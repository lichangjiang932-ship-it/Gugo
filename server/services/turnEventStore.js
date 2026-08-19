import { getDb } from '../db.js'
import { parseTurnEvent } from '../../shared/turnEvents.js'
import { saveTurnCheckpoint } from './turnCheckpointStore.js'

const subscribers = new Map()
const DAY_MS = 86_400_000
export const DEFAULT_TURN_EVENT_RETENTION_DAYS = 30
export const DEFAULT_TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER = 1_000
export const DEFAULT_TURN_EVENT_CLEANUP_INTERVAL_MS = 300_000
let lastCleanupAt = 0

function boundedNumber(value, fallback, { min, max }) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(max, parsed)
}

export function resolveTurnEventRetentionConfig(env = process.env) {
  const retentionDays = boundedNumber(
    env?.TURN_EVENT_RETENTION_DAYS,
    DEFAULT_TURN_EVENT_RETENTION_DAYS,
    { min: 1, max: 3_650 },
  )
  return {
    retentionMs: Math.floor(retentionDays * DAY_MS),
    maxTerminalTurnsPerUser: Math.floor(boundedNumber(
      env?.TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER,
      DEFAULT_TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER,
      { min: 1, max: 100_000 },
    )),
    cleanupIntervalMs: Math.floor(boundedNumber(
      env?.TURN_EVENT_CLEANUP_INTERVAL_MS,
      DEFAULT_TURN_EVENT_CLEANUP_INTERVAL_MS,
      { min: 1_000, max: DAY_MS },
    )),
  }
}

function subscriptionKey(userId, sessionId, turnId) {
  return `${userId}\u0000${sessionId}\u0000${turnId}`
}

function publishTurnEvent(userId, event) {
  const listeners = subscribers.get(subscriptionKey(userId, event.sessionId, event.turnId))
  if (!listeners) return
  for (const listener of [...listeners]) {
    try { listener(event) } catch { /* A disconnected stream must not break persistence. */ }
  }
}

function mapRow(row) {
  return row ? parseTurnEvent({ id: row.id, sessionId: row.session_id, turnId: row.turn_id, sequence: row.sequence, type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }) : null
}

export function turnEventForClient(event) {
  if (event?.type !== 'turn.checkpoint') return event
  if (event.payload?.storage === 'turn_checkpoints') return event
  const state = event.payload?.state && typeof event.payload.state === 'object'
    ? event.payload.state
    : {}
  const budget = state.budget && typeof state.budget === 'object' ? state.budget : {}
  return {
    ...event,
    payload: {
      state: {
        iterations: Math.max(0, Number(state.iterations) || 0),
        toolCalls: Array.isArray(state.toolCalls) ? state.toolCalls.length : 0,
        artifactCount: Array.isArray(state.artifactIds) ? state.artifactIds.length : 0,
        budget: {
          used: Math.max(0, Number(budget.used) || 0),
          maxTotalCalls: Math.max(0, Number(budget.maxTotalCalls) || 0),
          modelCalls: Math.max(0, Number(budget.modelCalls) || 0),
          maxModelCalls: Math.max(0, Number(budget.maxModelCalls) || 0),
        },
      },
    },
  }
}

/**
 * Retention is applied to whole turns, never to individual events. This keeps
 * replay sequences internally consistent: recent/active turns remain complete,
 * while expired or surplus terminal turns disappear atomically as a unit.
 */
export function pruneTurnEvents({
  userId = null,
  now = Date.now(),
  retentionMs = null,
  maxTerminalTurnsPerUser = null,
} = {}) {
  const defaults = resolveTurnEventRetentionConfig()
  const safeNow = Number.isFinite(Number(now)) ? Math.floor(Number(now)) : Date.now()
  const safeRetentionMs = Math.max(1, Math.floor(boundedNumber(
    retentionMs,
    defaults.retentionMs,
    { min: 1, max: 3_650 * DAY_MS },
  )))
  const safeMaxTerminalTurns = Math.max(1, Math.floor(boundedNumber(
    maxTerminalTurnsPerUser,
    defaults.maxTerminalTurnsPerUser,
    { min: 1, max: 100_000 },
  )))
  const db = getDb()
  const where = userId ? 'WHERE user_id = ?' : ''
  const summaries = db.prepare(`
    SELECT
      user_id,
      session_id,
      turn_id,
      MAX(created_at) AS last_event_at,
      MAX(CASE WHEN type IN ('turn.completed', 'turn.cancelled', 'turn.failed') THEN created_at END) AS terminal_at
    FROM turn_events
    ${where}
    GROUP BY user_id, session_id, turn_id
    ORDER BY user_id ASC, terminal_at DESC, last_event_at DESC
  `).all(...(userId ? [userId] : []))
  const cutoff = safeNow - safeRetentionMs
  const terminalCounts = new Map()
  const doomed = new Map()
  for (const row of summaries) {
    const key = `${row.user_id}\u0000${row.session_id}\u0000${row.turn_id}`
    if (Number(row.last_event_at) < cutoff) doomed.set(key, row)
    if (row.terminal_at !== null && row.terminal_at !== undefined) {
      const count = (terminalCounts.get(row.user_id) || 0) + 1
      terminalCounts.set(row.user_id, count)
      if (count > safeMaxTerminalTurns) doomed.set(key, row)
    }
  }

  if (doomed.size === 0) return { turnsDeleted: 0, eventsDeleted: 0 }
  const remove = db.prepare(`
    DELETE FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `)
  const removeCheckpoint = db.prepare(`
    DELETE FROM turn_checkpoints
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `)
  let turnsDeleted = 0
  let eventsDeleted = 0
  db.transaction(() => {
    for (const row of doomed.values()) {
      const result = remove.run(row.user_id, row.session_id, row.turn_id)
      removeCheckpoint.run(row.user_id, row.session_id, row.turn_id)
      if (result.changes > 0) turnsDeleted += 1
      eventsDeleted += result.changes
    }
  })()
  return { turnsDeleted, eventsDeleted }
}

function maybePruneTurnEvents(now = Date.now()) {
  const config = resolveTurnEventRetentionConfig()
  if (now - lastCleanupAt < config.cleanupIntervalMs) return
  lastCleanupAt = now
  try {
    pruneTurnEvents({ now, ...config })
  } catch (error) {
    // Retention is maintenance; a cleanup failure must not discard the event
    // that triggered it or fail the running turn.
    console.warn('[turn-events] retention cleanup failed:', error?.message || error)
  }
}

function normalizeAppendEntry({ userId, event, checkpointState = null } = {}) {
  if (!userId) throw new Error('user id is required')
  const value = parseTurnEvent(event)
  if (checkpointState !== null && value.type !== 'turn.checkpoint') {
    throw new Error('checkpoint state requires a turn.checkpoint event')
  }
  return {
    userId,
    value,
    checkpointState,
    payloadJson: JSON.stringify(value.payload),
  }
}

/** Persist a write-behind batch in one SQLite transaction. */
export function appendTurnEvents(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('turn event entries must be an array')
  if (entries.length === 0) return []
  const normalized = entries.map(normalizeAppendEntry)
  const db = getDb()
  const ownsSession = db.prepare(`
    SELECT token FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `)
  const insertEvent = db.prepare(`INSERT OR IGNORE INTO turn_events
    (id, user_id, session_id, turn_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const readEvent = db.prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence = ?`)
  const deleteOlderCheckpoints = db.prepare(`DELETE FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
      AND type = 'turn.checkpoint' AND sequence < ?`)
  const stored = []
  const insertedEvents = []

  db.transaction(() => {
    for (const entry of normalized) {
      const { userId, value, checkpointState, payloadJson } = entry
      if (!ownsSession.get(userId, value.sessionId)) throw new Error('session not found')
      const inserted = insertEvent.run(
        value.id,
        userId,
        value.sessionId,
        value.turnId,
        value.sequence,
        value.type,
        payloadJson,
        value.createdAt,
      )
      const row = readEvent.get(userId, value.sessionId, value.turnId, value.sequence)
      if (!row || row.id !== value.id || row.type !== value.type || row.payload_json !== payloadJson) {
        throw new Error('turn event sequence conflict')
      }
      const mapped = mapRow(row)
      stored.push(mapped)
      if (inserted.changes === 0) continue
      if (checkpointState !== null) {
        const checkpoint = saveTurnCheckpoint({
          userId,
          sessionId: value.sessionId,
          turnId: value.turnId,
          eventSequence: value.sequence,
          state: checkpointState,
          now: value.createdAt,
        }, db)
        if (!checkpoint?.state) throw new Error('Failed to persist turn checkpoint')
      }
      if (value.type === 'turn.checkpoint') {
        deleteOlderCheckpoints.run(userId, value.sessionId, value.turnId, value.sequence)
      }
      insertedEvents.push({ userId, event: mapped })
    }
  })()

  for (const entry of insertedEvents) {
    publishTurnEvent(entry.userId, turnEventForClient(entry.event))
  }
  if (insertedEvents.length > 0) {
    // Event timestamps and retention share the same clock. A single cleanup
    // after the committed batch avoids turning maintenance into write pressure.
    maybePruneTurnEvents(Math.max(...insertedEvents.map(({ event }) => event.createdAt)))
  }
  return stored
}

export function appendTurnEvent(entry) {
  return appendTurnEvents([entry])[0]
}

export function recordTurnEventWriteFailure({
  batch = [],
  errorMessage = 'event write failed',
  attempts = 3,
  failedAt = Date.now(),
} = {}) {
  if (!Array.isArray(batch) || batch.length === 0) return 0
  const db = getDb()
  const insert = db.prepare(`INSERT INTO event_write_failures
    (user_id, session_id, turn_id, event_id, event_sequence, event_type,
      payload_json, error_message, attempts, failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let changes = 0
  db.transaction(() => {
    for (const item of batch) {
      const event = item?.event && typeof item.event === 'object' ? item.event : {}
      let payloadJson
      try { payloadJson = JSON.stringify(event.payload ?? {}) }
      catch { payloadJson = '{"serializationError":true}' }
      changes += insert.run(
        item?.userId ? String(item.userId) : null,
        event.sessionId ? String(event.sessionId) : null,
        event.turnId ? String(event.turnId) : null,
        event.id ? String(event.id) : null,
        Number.isInteger(event.sequence) ? event.sequence : null,
        event.type ? String(event.type) : null,
        payloadJson,
        String(errorMessage || 'event write failed').slice(0, 2_000),
        Math.max(1, Math.floor(Number(attempts) || 1)),
        Math.max(0, Math.floor(Number(failedAt) || Date.now())),
      ).changes
    }
  })()
  return changes
}

export function listTurnEvents({ userId, sessionId, turnId, after = -1, limit = 500 }) {
  if (!userId || !sessionId || !turnId) return []
  const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 500))
  const parsedAfter = after === null || after === undefined || after === '' ? -1 : Number(after)
  const safeAfter = Number.isFinite(parsedAfter) ? Math.floor(parsedAfter) : -1
  return getDb().prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?`).all(userId, sessionId, turnId, safeAfter, safeLimit).map(mapRow)
}

export function getLastTurnEvent({ userId, sessionId, turnId, type = null }) {
  if (!userId || !sessionId || !turnId) return null
  const row = type
    ? getDb().prepare(`SELECT * FROM turn_events
        WHERE user_id = ? AND session_id = ? AND turn_id = ? AND type = ?
        ORDER BY sequence DESC LIMIT 1`).get(userId, sessionId, turnId, type)
    : getDb().prepare(`SELECT * FROM turn_events
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
        ORDER BY sequence DESC LIMIT 1`).get(userId, sessionId, turnId)
  return mapRow(row)
}

export function subscribeTurnEvents({ userId, sessionId, turnId }, listener) {
  if (!userId || !sessionId || !turnId || typeof listener !== 'function') return () => {}
  const key = subscriptionKey(userId, sessionId, turnId)
  const listeners = subscribers.get(key) || new Set()
  listeners.add(listener)
  subscribers.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) subscribers.delete(key)
  }
}
