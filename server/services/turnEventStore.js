import { getDb } from '../db.js'
import { isDeepStrictEqual } from 'node:util'
import {
  canAdvanceTurnEventCursor,
  createTurnEventTransportEnvelope,
  parseTurnEvent,
} from '../../shared/turnEvents.js'
import {
  isSuccessfulTurnCompletedEvent,
  projectTurnEventForClient,
} from '../../shared/turnEventProjection.js'
import { publishAgentEventEnvelope } from '../core/agentEventConsumerRuntime.js'
import { saveTurnCheckpoint } from './turnCheckpointStore.js'
import { findTurnEventFenceError, isTurnEventFenceFailureRecord } from './eventWriteBehind.js'
import {
  canonicalCheckpointState,
  failureAllowsAttempt,
  storedTurnEventIsTerminal,
  turnCompletionInvalid,
} from './turnEventValidation.js'

const subscribers = new Map()
const DAY_MS = 86_400_000
export const DEFAULT_TURN_EVENT_RETENTION_DAYS = 30
export const DEFAULT_TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER = 1_000
export const DEFAULT_TURN_EVENT_CLEANUP_INTERVAL_MS = 300_000
export const DEFAULT_EVENT_WRITE_FAILURE_RETENTION_DAYS = 30
export const DEFAULT_EVENT_WRITE_FAILURE_MAX_PER_USER = 10_000
let lastCleanupAt = 0

export class TurnEventSequenceGapError extends Error {
  constructor({ userId, sessionId, turnId, expectedSequence, actualSequence } = {}) {
    super(`turn event sequence gap: expected ${expectedSequence}, received ${actualSequence}`)
    this.name = 'TurnEventSequenceGapError'
    this.code = 'TURN_EVENT_SEQUENCE_GAP'
    this.status = 409
    this.userId = userId || null
    this.sessionId = sessionId || null
    this.turnId = turnId || null
    this.expectedSequence = expectedSequence
    this.actualSequence = actualSequence
  }
}

export class TurnAlreadyTerminalError extends Error {
  constructor({ userId, sessionId, turnId, terminalType, terminalSequence } = {}) {
    super(`turn is already terminal at sequence ${terminalSequence}`)
    this.name = 'TurnAlreadyTerminalError'
    this.code = 'TURN_ALREADY_TERMINAL'
    this.status = 409
    this.userId = userId || null
    this.sessionId = sessionId || null
    this.turnId = turnId || null
    this.terminalType = terminalType || null
    this.terminalSequence = terminalSequence
  }
}

function turnEventSequenceConflict() {
  const error = new Error('turn event sequence conflict')
  error.code = 'TURN_EVENT_SEQUENCE_CONFLICT'
  error.status = 409
  return error
}

function turnCheckpointIdentityConflict() {
  const error = new Error('turn checkpoint identity conflict')
  error.code = 'TURN_CHECKPOINT_IDENTITY_CONFLICT'
  error.status = 409
  return error
}

function turnEventTransactionRequired() {
  const error = new Error('caller-owned turn event transaction is required')
  error.code = 'TURN_EVENT_TRANSACTION_REQUIRED'
  error.status = 500
  error.retryable = false
  return error
}

function turnEventSequenceInvalid() {
  const error = new Error('turn.started must be sequence 0 and all other events must follow it')
  error.code = 'TURN_EVENT_SEQUENCE_INVALID'
  error.status = 409
  error.retryable = false
  return error
}

// Keep pure validation independent from transaction and publication orchestration.
// This store now owns persistence concerns only.
// The helpers remain synchronous so transaction behavior is unchanged.

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

function mapFailureRow(row) {
  if (!row) return null
  let payload
  try { payload = JSON.parse(row.payload_json) }
  catch { payload = { serializationError: true } }
  let checkpointState = null
  if (row.checkpoint_state_json !== null && row.checkpoint_state_json !== undefined) {
    try { checkpointState = JSON.parse(row.checkpoint_state_json) }
    catch { checkpointState = { serializationError: true } }
  }
  return {
    id: row.id,
    userId: row.user_id || null,
    sessionId: row.session_id || null,
    turnId: row.turn_id || null,
    eventId: row.event_id || null,
    eventSequence: Number.isInteger(row.event_sequence) ? row.event_sequence : null,
    eventType: row.event_type || null,
    payload,
    checkpointState,
    errorMessage: row.error_message,
    attempts: row.attempts,
    failedAt: row.failed_at,
  }
}

export function assertContiguousTurnEvents(events = [], {
  userId = null,
  sessionId = null,
  turnId = null,
  after = -1,
  compactedThrough = null,
} = {}) {
  let cursor = Math.max(-1, Math.floor(Number(after) || 0))
  const boundary = Number.isInteger(compactedThrough) ? compactedThrough : -1
  const replayEvents = []
  for (const event of events) {
    const replayEvent = !canAdvanceTurnEventCursor(event, cursor)
      && event.sequence > cursor + 1
      && event.sequence <= boundary
      ? { ...event, compactedThrough: boundary }
      : event
    if (!canAdvanceTurnEventCursor(replayEvent, cursor)) {
      throw new TurnEventSequenceGapError({
        userId,
        sessionId,
        turnId,
        expectedSequence: cursor + 1,
        actualSequence: event.sequence,
      })
    }
    replayEvents.push(replayEvent)
    cursor = event.sequence
  }
  return replayEvents
}

export const turnEventForClient = projectTurnEventForClient

// Retention deletes whole turns so every remaining replay stays contiguous.
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
    WITH latest AS (
      SELECT user_id, session_id, turn_id, MAX(sequence) AS sequence
      FROM turn_events
      ${where}
      GROUP BY user_id, session_id, turn_id
    )
    SELECT
      event.user_id,
      event.session_id,
      event.turn_id,
      event.type,
      event.payload_json,
      event.created_at AS last_event_at,
      CASE
        WHEN event.type IN ('turn.completed', 'turn.cancelled', 'turn.failed')
          THEN event.created_at
        ELSE NULL
      END AS terminal_at
    FROM latest
    JOIN turn_events AS event
      ON event.user_id = latest.user_id
      AND event.session_id = latest.session_id
      AND event.turn_id = latest.turn_id
      AND event.sequence = latest.sequence
    ORDER BY event.user_id ASC, terminal_at DESC, last_event_at DESC
  `).all(...(userId ? [userId] : []))
  const cutoff = safeNow - safeRetentionMs
  const terminalCounts = new Map()
  const doomed = new Map()
  for (const row of summaries) {
    const key = `${row.user_id}\u0000${row.session_id}\u0000${row.turn_id}`
    if (Number(row.last_event_at) < cutoff) doomed.set(key, row)
    if (storedTurnEventIsTerminal(row)) {
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
  if (value.type === 'turn.completed' && !isSuccessfulTurnCompletedEvent(value)) {
    throw turnCompletionInvalid()
  }
  if ((value.sequence === 0) !== (value.type === 'turn.started')) {
    throw turnEventSequenceInvalid()
  }
  if (value.type === 'turn.checkpoint'
    && (!checkpointState || typeof checkpointState !== 'object' || Array.isArray(checkpointState))) {
    throw new TypeError('turn.checkpoint requires checkpoint state')
  }
  if (checkpointState !== null && value.type !== 'turn.checkpoint') {
    throw new Error('checkpoint state requires a turn.checkpoint event')
  }
  return {
    userId,
    value,
    checkpointState: checkpointState === null ? null : canonicalCheckpointState(checkpointState),
    payloadJson: JSON.stringify(value.payload),
  }
}

/** Persist events inside a caller-owned SQLite transaction without publishing. */
export function appendTurnEventsInTransaction(entries = [], db, {
  allowFailedRetry = false,
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError('turn event entries must be an array')
  if (!db || typeof db.prepare !== 'function' || db.inTransaction !== true) {
    throw turnEventTransactionRequired()
  }
  if (entries.length === 0) return { stored: [], insertedEvents: [] }
  const normalized = entries.map(normalizeAppendEntry)
  const ownsSession = db.prepare(`
    SELECT token FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `)
  const insertEvent = db.prepare(`INSERT OR IGNORE INTO turn_events
    (id, user_id, session_id, turn_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  const readEvent = db.prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence = ?`)
  const readCheckpoint = db.prepare(`SELECT event_sequence, state_json FROM turn_checkpoints
    WHERE user_id = ? AND session_id = ? AND turn_id = ?`)
  const readPredecessor = db.prepare(`SELECT 1 FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence = ?`)
  const readLatest = db.prepare(`SELECT sequence, type, payload_json FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
    ORDER BY sequence DESC LIMIT 1`)
  const deleteOlderCheckpoints = db.prepare(`DELETE FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
      AND type = 'turn.checkpoint' AND sequence < ?`)
  const stored = []
  const insertedEvents = []

  for (const entry of normalized) {
      const { userId, value, checkpointState, payloadJson } = entry
      if (!ownsSession.get(userId, value.sessionId)) throw new Error('session not found')
      const existing = readEvent.get(userId, value.sessionId, value.turnId, value.sequence)
      if (existing) {
      if (existing.id !== value.id
        || existing.type !== value.type
        || existing.payload_json !== payloadJson
        || existing.created_at !== value.createdAt) {
        throw turnEventSequenceConflict()
      }
      if (checkpointState !== null) {
        const checkpoint = readCheckpoint.get(userId, value.sessionId, value.turnId)
        let storedState = null
        try { storedState = checkpoint?.state_json ? JSON.parse(checkpoint.state_json) : null } catch { /* conflict below */ }
        const expectedState = { ...checkpointState, checkpointVersion: 1 }
        if (checkpoint?.event_sequence !== value.sequence
          || !isDeepStrictEqual(storedState, expectedState)) {
          throw turnCheckpointIdentityConflict()
        }
      }
      stored.push(mapRow(existing))
        continue
      }
      const latest = readLatest.get(userId, value.sessionId, value.turnId)
      const latestIsTerminal = storedTurnEventIsTerminal(latest)
      const allowedFailedRetry = allowFailedRetry === true
        && latest?.type === 'turn.failed'
        && failureAllowsAttempt(latest.payload_json, value.payload)
        && value.type === 'turn.attempt'
        && value.payload?.reason === 'failed_retry'
        && value.sequence === latest.sequence + 1
      if (latestIsTerminal && !allowedFailedRetry) {
        throw new TurnAlreadyTerminalError({
          userId,
          sessionId: value.sessionId,
          turnId: value.turnId,
          terminalType: latest.type,
          terminalSequence: latest.sequence,
        })
      }
      if (value.sequence > 0 && !readPredecessor.get(
        userId,
        value.sessionId,
        value.turnId,
        value.sequence - 1,
      )) {
        throw new TurnEventSequenceGapError({
          userId,
          sessionId: value.sessionId,
          turnId: value.turnId,
          expectedSequence: value.sequence - 1,
          actualSequence: value.sequence,
        })
      }
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
      if (!row
        || row.id !== value.id
        || row.type !== value.type
        || row.payload_json !== payloadJson
        || row.created_at !== value.createdAt) {
        throw turnEventSequenceConflict()
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
        if (!checkpoint?.state) {
          const error = new Error('Failed to persist turn checkpoint')
          error.code = 'TURN_CHECKPOINT_PERSISTENCE_FAILED'
          error.status = 503
          error.retryable = true
          throw error
        }
      }
      if (value.type === 'turn.checkpoint') {
        deleteOlderCheckpoints.run(userId, value.sessionId, value.turnId, value.sequence)
      }
    insertedEvents.push({ userId, event: mapped })
  }

  return { stored, insertedEvents }
}

/** Publish only events whose owning transaction has committed. */
export function publishCommittedTurnEvents(insertedEvents = []) {
  for (const entry of insertedEvents) {
    const clientEvent = turnEventForClient(entry.event)
    publishTurnEvent(entry.userId, clientEvent)
    try {
      // Agent Event consumers observe the exact versioned event sent to modern
      // transports. Delivery is isolated and never changes persistence success.
      const delivery = publishAgentEventEnvelope(
        createTurnEventTransportEnvelope(clientEvent),
        { userId: entry.userId },
      )
      if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {})
    } catch {
      // A consumer host failure is observability debt, never a reason to make a
      // durable Turn appear uncommitted or to publish a contradictory terminal.
    }
  }
  if (insertedEvents.length > 0) {
    // Event timestamps and retention share the same clock. A single cleanup
    // after the committed batch avoids turning maintenance into write pressure.
    maybePruneTurnEvents(Math.max(...insertedEvents.map(({ event }) => event.createdAt)))
  }
}

/** Persist a write-behind batch in one SQLite transaction. */
export function appendTurnEvents(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('turn event entries must be an array')
  if (entries.length === 0) return []
  const db = getDb()
  let committed
  db.transaction(() => {
    committed = appendTurnEventsInTransaction(entries, db)
  })()
  publishCommittedTurnEvents(committed.insertedEvents)
  return committed.stored
}

export function appendTurnEvent(entry) {
  return appendTurnEvents([entry])[0]
}

/** Read-after-write verification used for terminal Turn durability fences. */
export function verifyTurnEventCommit({ userId, event } = {}) {
  if (!userId) throw new TypeError('user id is required')
  const expected = parseTurnEvent(event)
  const row = getDb().prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence = ?`)
    .get(userId, expected.sessionId, expected.turnId, expected.sequence)
  const committed = Boolean(row
    && row.id === expected.id
    && row.type === expected.type
    && row.payload_json === JSON.stringify(expected.payload)
    && row.created_at === expected.createdAt)
  return Object.freeze({
    committed,
    receipt: committed ? Object.freeze({
      eventId: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      sequence: row.sequence,
      type: row.type,
      committedAt: row.created_at,
    }) : null,
  })
}

export function recordTurnEventWriteFailure({
  batch = [],
  error = null,
  errorMessage = 'event write failed',
  attempts = 3,
  failedAt = Date.now(),
} = {}) {
  if (findTurnEventFenceError(error)) return 0
  if (!Array.isArray(batch) || batch.length === 0) return 0
  const db = getDb()
  const findExisting = db.prepare(`SELECT id FROM event_write_failures
    WHERE user_id = ? AND event_id = ?
    ORDER BY id DESC LIMIT 1`)
  const insert = db.prepare(`INSERT INTO event_write_failures
    (user_id, session_id, turn_id, event_id, event_sequence, event_type,
      payload_json, checkpoint_state_json, error_message, attempts, failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const update = db.prepare(`UPDATE event_write_failures SET
      session_id = ?, turn_id = ?, event_sequence = ?, event_type = ?,
      payload_json = ?, checkpoint_state_json = ?, error_message = ?, attempts = ?, failed_at = ?
    WHERE id = ? AND user_id = ?`)
  let changes = 0
  const affectedUsers = new Set()
  db.transaction(() => {
    for (const item of batch) {
      const event = item?.event && typeof item.event === 'object' ? item.event : {}
      const entryUserId = item?.userId ? String(item.userId) : null
      const eventId = event.id ? String(event.id) : null
      let payloadJson
      try { payloadJson = JSON.stringify(event.payload ?? {}) }
      catch { payloadJson = '{"serializationError":true}' }
      let checkpointStateJson = null
      if (item?.checkpointState !== null && item?.checkpointState !== undefined) {
        try { checkpointStateJson = JSON.stringify(item.checkpointState) }
        catch { checkpointStateJson = '{"serializationError":true}' }
      }
      const values = [
        event.sessionId ? String(event.sessionId) : null,
        event.turnId ? String(event.turnId) : null,
        Number.isInteger(event.sequence) ? event.sequence : null,
        event.type ? String(event.type) : null,
        payloadJson,
        checkpointStateJson,
        String(errorMessage || 'event write failed').slice(0, 2_000),
        Math.max(1, Math.floor(Number(attempts) || 1)),
        Math.max(0, Math.floor(Number(failedAt) || Date.now())),
      ]
      const existing = entryUserId && eventId ? findExisting.get(entryUserId, eventId) : null
      changes += existing
        ? update.run(...values, existing.id, entryUserId).changes
        : insert.run(
            entryUserId,
            values[0],
            values[1],
            eventId,
            values[2],
            values[3],
            values[4],
            values[5],
            values[6],
            values[7],
            values[8],
          ).changes
      if (entryUserId) affectedUsers.add(entryUserId)
    }
  })()
  for (const affectedUserId of affectedUsers) {
    try { pruneTurnEventWriteFailures({ userId: affectedUserId }) } catch { /* journal cleanup is best-effort */ }
  }
  return changes
}

function normalizeFailureId(value) {
  const parsed = Math.floor(Number(value))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function failureReplayError(code, message, status = 409) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function listTurnEventWriteFailures({
  userId,
  sessionId = null,
  turnId = null,
  beforeId = null,
  limit = 100,
} = {}) {
  if (!userId) return []
  const clauses = ['user_id = ?']
  const params = [userId]
  if (sessionId) {
    clauses.push('session_id = ?')
    params.push(sessionId)
  }
  if (turnId) {
    clauses.push('turn_id = ?')
    params.push(turnId)
  }
  const safeBeforeId = normalizeFailureId(beforeId)
  if (safeBeforeId) {
    clauses.push('id < ?')
    params.push(safeBeforeId)
  }
  const safeLimit = Math.min(1_000, Math.max(1, Math.floor(Number(limit) || 100)))
  params.push(safeLimit)
  return getDb().prepare(`SELECT * FROM event_write_failures
    WHERE ${clauses.join(' AND ')}
    ORDER BY id DESC LIMIT ?`).all(...params).map(mapFailureRow)
}

export function acknowledgeTurnEventWriteFailure({ userId, id } = {}) {
  const safeId = normalizeFailureId(id)
  if (!userId || !safeId) return false
  return getDb().prepare(`DELETE FROM event_write_failures
    WHERE id = ? AND user_id = ?`).run(safeId, userId).changes === 1
}

export function acknowledgeTurnEventWriteFailuresByEventIds(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      userId: entry?.userId ? String(entry.userId) : null,
      eventId: entry?.event?.id ? String(entry.event.id) : null,
    }))
    .filter((entry) => entry.userId && entry.eventId)
  if (normalized.length === 0) return 0
  const remove = getDb().prepare(`DELETE FROM event_write_failures
    WHERE user_id = ? AND event_id = ?`)
  let changes = 0
  getDb().transaction(() => {
    for (const entry of normalized) changes += remove.run(entry.userId, entry.eventId).changes
  })()
  return changes
}

export function replayTurnEventWriteFailure({ userId, id } = {}) {
  const safeId = normalizeFailureId(id)
  if (!userId || !safeId) return null
  const row = getDb().prepare(`SELECT * FROM event_write_failures
    WHERE id = ? AND user_id = ?`).get(safeId, userId)
  if (!row) return null
  if (isTurnEventFenceFailureRecord(row)) {
    throw failureReplayError('TURN_EVENT_FAILURE_FENCED',
      'an event rejected from a stale execution owner cannot be replayed', 422)
  }
  const failure = mapFailureRow(row)
  if (!failure.eventId || !failure.sessionId || !failure.turnId
    || !Number.isInteger(failure.eventSequence) || !failure.eventType) {
    throw failureReplayError('TURN_EVENT_FAILURE_NOT_REPLAYABLE', 'event failure does not contain a complete event identity', 422)
  }
  if (failure.eventType === 'turn.checkpoint' && failure.checkpointState === null) {
    throw failureReplayError(
      'TURN_EVENT_FAILURE_NOT_REPLAYABLE',
      'checkpoint failure cannot be replayed without its checkpoint state',
      422,
    )
  }
  const event = parseTurnEvent({
    id: failure.eventId,
    sessionId: failure.sessionId,
    turnId: failure.turnId,
    sequence: failure.eventSequence,
    type: failure.eventType,
    payload: failure.payload,
    createdAt: failure.failedAt,
  })
  const stored = appendTurnEvent({
    userId,
    event,
    checkpointState: failure.eventType === 'turn.checkpoint' ? failure.checkpointState : null,
  })
  acknowledgeTurnEventWriteFailure({ userId, id: safeId })
  return { failure, event: stored }
}

export function pruneTurnEventWriteFailures({
  userId = null,
  now = Date.now(),
  retentionMs = DEFAULT_EVENT_WRITE_FAILURE_RETENTION_DAYS * DAY_MS,
  maxPerUser = DEFAULT_EVENT_WRITE_FAILURE_MAX_PER_USER,
} = {}) {
  const db = getDb()
  const safeNow = Math.max(0, Math.floor(Number(now) || Date.now()))
  const safeRetentionMs = Math.max(DAY_MS, Math.floor(Number(retentionMs) || (DEFAULT_EVENT_WRITE_FAILURE_RETENTION_DAYS * DAY_MS)))
  const safeMax = Math.min(100_000, Math.max(1, Math.floor(Number(maxPerUser) || DEFAULT_EVENT_WRITE_FAILURE_MAX_PER_USER)))
  let deleted = 0
  db.transaction(() => {
    if (userId) {
      deleted += db.prepare(`DELETE FROM event_write_failures
        WHERE user_id = ? AND failed_at < ?`).run(userId, safeNow - safeRetentionMs).changes
      deleted += db.prepare(`DELETE FROM event_write_failures
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM event_write_failures
          WHERE user_id = ? ORDER BY failed_at DESC, id DESC LIMIT ?
        )`).run(userId, userId, safeMax).changes
      return
    }
    deleted += db.prepare('DELETE FROM event_write_failures WHERE failed_at < ?')
      .run(safeNow - safeRetentionMs).changes
    const users = db.prepare(`SELECT DISTINCT user_id FROM event_write_failures
      WHERE user_id IS NOT NULL`).all()
    const trim = db.prepare(`DELETE FROM event_write_failures
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM event_write_failures
        WHERE user_id = ? ORDER BY failed_at DESC, id DESC LIMIT ?
      )`)
    for (const row of users) deleted += trim.run(row.user_id, row.user_id, safeMax).changes
  })()
  return deleted
}

// Turn ids are not global, so ambiguous user-owned scopes remain explicit.
export function resolveTurnSession({ userId, turnId } = {}) {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : ''
  if (!normalizedUserId) throw new TypeError('user id is required')
  if (!normalizedTurnId) throw new TypeError('turn id is required')

  const rows = getDb().prepare(`
    SELECT session_id, MAX(created_at) AS updated_at
    FROM turn_events
    WHERE user_id = ? AND turn_id = ?
    GROUP BY session_id
    ORDER BY updated_at DESC, session_id ASC
    LIMIT 2
  `).all(normalizedUserId, normalizedTurnId)
  if (rows.length === 0) return Object.freeze({ status: 'not_found' })
  if (rows.length > 1) return Object.freeze({ status: 'ambiguous' })

  const sessionId = typeof rows[0]?.session_id === 'string'
    ? rows[0].session_id.trim()
    : ''
  if (!sessionId) throw new TypeError('resolved turn session id must be a non-empty string')
  return Object.freeze({ status: 'found', sessionId })
}

export function listTurnEvents({ userId, sessionId, turnId, after = -1, limit = 500 }) {
  if (!userId || !sessionId || !turnId) return []
  const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 500))
  const parsedAfter = after === null || after === undefined || after === '' ? -1 : Number(after)
  const safeAfter = Number.isFinite(parsedAfter) ? Math.max(-1, Math.floor(parsedAfter)) : -1
  const db = getDb()
  const events = db.prepare(`SELECT * FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND sequence > ?
    ORDER BY sequence ASC LIMIT ?`).all(userId, sessionId, turnId, safeAfter, safeLimit).map(mapRow)
  const checkpoint = db.prepare(`SELECT event_sequence FROM turn_checkpoints
    WHERE user_id = ? AND session_id = ? AND turn_id = ?`).get(userId, sessionId, turnId)
  return assertContiguousTurnEvents(events, {
    userId,
    sessionId,
    turnId,
    after: safeAfter,
    compactedThrough: checkpoint?.event_sequence,
  })
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
