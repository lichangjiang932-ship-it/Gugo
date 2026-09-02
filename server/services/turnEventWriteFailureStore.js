import { getDb } from '../db.js'
import { parsePersistedTurnEvent } from '../../shared/turnEvents.js'
import { projectTurnEventForClient } from '../../shared/turnEventProjection.js'
import { findTurnEventFenceError, isTurnEventFenceFailureRecord } from './eventWriteBehind.js'

const DAY_MS = 86_400_000
export const DEFAULT_EVENT_WRITE_FAILURE_RETENTION_DAYS = 30
export const DEFAULT_EVENT_WRITE_FAILURE_MAX_PER_USER = 10_000

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

export function replayTurnEventWriteFailure({ userId, id } = {}, appendTurnEvent) {
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
  const event = projectTurnEventForClient(parsePersistedTurnEvent({
    id: failure.eventId,
    sessionId: failure.sessionId,
    turnId: failure.turnId,
    sequence: failure.eventSequence,
    type: failure.eventType,
    payload: failure.payload,
    createdAt: failure.failedAt,
  }))
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
