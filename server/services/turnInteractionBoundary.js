import { getDb } from '../db.js'
import { types } from 'node:util'

function boundaryError(message) {
  return Object.assign(new Error(message), {
    code: 'TURN_INTERACTION_STALE', statusCode: 409, retryable: false,
  })
}

function requireScope(scope) {
  for (const key of ['userId', 'sessionId', 'turnId']) {
    const value = scope[key]
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 500) {
      throw boundaryError('The interaction requires an exact owner, session and turn identity.')
    }
  }
}

function eventBoundary(row) {
  return row ? { id: row.id, sequence: row.sequence, type: row.type } : null
}

function readLatest(db, scope) {
  return db.prepare(`SELECT id, sequence, type, payload_json FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
    ORDER BY sequence DESC LIMIT 1`).get(scope.userId, scope.sessionId, scope.turnId)
}

function assertExpected(row, boundary, toolCallId) {
  if (!boundary || typeof boundary.id !== 'string' || !boundary.id
    || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0
    || !['turn.paused', 'turn.blocked'].includes(boundary.type)
    || row?.id !== boundary.id || row.sequence !== boundary.sequence || row.type !== boundary.type) {
    throw boundaryError('This request is no longer the current turn boundary. Refresh the task before confirming.')
  }
  let payload
  try { payload = JSON.parse(row.payload_json) } catch { throw boundaryError('The pending interaction is unreadable.') }
  const clarification = payload?.clarification
  if (row.type === 'turn.paused') {
    if (toolCallId != null || (clarification?.request_type || clarification?.requestType) !== 'directory') {
      throw boundaryError('This pause is not a directory authorization request.')
    }
  } else if (typeof toolCallId !== 'string' || !toolCallId || toolCallId !== toolCallId.trim()
    || payload?.code !== 'SIDE_EFFECT_OUTCOME_UNKNOWN' || payload.requiresUserVerification !== true
    || payload.recoveryKind !== 'side_effect_outcome_unknown' || payload.toolCallId !== toolCallId) {
    throw boundaryError('This confirmation does not match the current unknown operation.')
  }
  return payload
}

/** SELECT-only snapshot for rendering one pending interaction. */
export function readTurnInteractionBoundary({ userId, sessionId, turnId, toolCallId, db } = {}) {
  const scope = { userId, sessionId, turnId }
  requireScope(scope)
  const row = readLatest(db || getDb(), scope)
  const boundary = eventBoundary(row)
  assertExpected(row, boundary, toolCallId)
  return Object.freeze(boundary)
}

/**
 * Bind a human confirmation to the still-current durable boundary. The SQLite
 * write lock spans the check and synchronous mutation, so another window cannot
 * cancel/resume the turn between them. Non-SQLite hosts provide their own port.
 */
export function runWithTurnInteractionBoundary({
  userId, sessionId, turnId, boundary, toolCallId, db,
} = {}, operation) {
  const scope = { userId, sessionId, turnId }
  requireScope(scope)
  if (typeof operation !== 'function' || types.isAsyncFunction(operation)) {
    throw new TypeError('A synchronous interaction operation is required.')
  }
  const database = db || getDb()
  return database.transaction(() => {
    const payload = assertExpected(readLatest(database, scope), boundary, toolCallId)
    const result = operation({ db: database, payload })
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {})
      throw new TypeError('Turn interaction mutations must complete synchronously inside the boundary transaction.')
    }
    return result
  }).immediate()
}
