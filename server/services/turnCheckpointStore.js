import { getDb } from '../db.js'

const CHECKPOINT_VERSION = 1

function parseState(value) {
  if (!value) return null
  try {
    const state = JSON.parse(value)
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null
  } catch {
    return null
  }
}

function mapCheckpoint(row) {
  if (!row) return null
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    eventSequence: row.event_sequence,
    state: parseState(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ownsSession({ userId, sessionId }) {
  if (!userId || !sessionId) return false
  return Boolean(getDb().prepare(`
    SELECT 1 FROM sessions WHERE user_id = ? AND token = ?
  `).get(userId, sessionId))
}

export function getTurnCheckpoint({ userId, sessionId, turnId } = {}) {
  if (!userId || !sessionId || !turnId) return null
  return mapCheckpoint(getDb().prepare(`
    SELECT * FROM turn_checkpoints
     WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, turnId))
}

export function saveTurnCheckpoint({
  userId,
  sessionId,
  turnId,
  eventSequence,
  state,
  now = Date.now(),
} = {}) {
  const sequence = Number(eventSequence)
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('checkpoint state must be an object')
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('checkpoint event sequence must be a non-negative integer')
  }
  if (!ownsSession({ userId, sessionId })) return null
  const normalized = { ...state, checkpointVersion: CHECKPOINT_VERSION }
  const timestamp = Number.isFinite(Number(now)) ? Math.max(0, Math.floor(Number(now))) : Date.now()
  getDb().prepare(`
    INSERT INTO turn_checkpoints
      (user_id, session_id, turn_id, event_sequence, state_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
      event_sequence = excluded.event_sequence,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
    WHERE excluded.event_sequence >= turn_checkpoints.event_sequence
  `).run(
    userId,
    sessionId,
    turnId,
    sequence,
    JSON.stringify(normalized),
    timestamp,
    timestamp,
  )
  return getTurnCheckpoint({ userId, sessionId, turnId })
}

export function deleteTurnCheckpoint({ userId, sessionId, turnId } = {}) {
  if (!userId || !sessionId || !turnId) return 0
  return getDb().prepare(`
    DELETE FROM turn_checkpoints
     WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).run(userId, sessionId, turnId).changes || 0
}
