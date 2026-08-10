import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

export const MAX_TURN_STEERING_LENGTH = 20_000
const MAX_CLIENT_REQUEST_ID_LENGTH = 256

export class TurnSteeringError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TurnSteeringError'
    this.code = code
    this.status = status
  }
}

function validScope({ userId, sessionId, turnId } = {}) {
  return !!(userId && sessionId && turnId)
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    messageId: row.message_id,
    clientRequestId: row.client_request_id,
    content: row.content,
    status: row.status,
    leaseId: row.lease_id || null,
    leaseOwnerId: row.lease_owner_id || null,
    leasedAt: row.leased_at ?? null,
    consumedAt: row.consumed_at ?? null,
    createdAt: row.created_at,
  }
}

function normalizeContent(content) {
  const text = String(content || '').trim()
  if (!text) {
    throw new TurnSteeringError('TURN_STEERING_CONTENT_REQUIRED', 'steering content is required')
  }
  if (text.length > MAX_TURN_STEERING_LENGTH) {
    throw new TurnSteeringError(
      'TURN_STEERING_CONTENT_TOO_LONG',
      `steering content exceeds ${MAX_TURN_STEERING_LENGTH} characters`,
    )
  }
  return text
}

function normalizeClientRequestId(clientRequestId) {
  const value = String(clientRequestId || '').trim()
  if (!value) {
    throw new TurnSteeringError(
      'TURN_STEERING_CLIENT_REQUEST_ID_REQUIRED',
      'clientRequestId is required',
    )
  }
  if (value.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
    throw new TurnSteeringError(
      'TURN_STEERING_CLIENT_REQUEST_ID_TOO_LONG',
      `clientRequestId exceeds ${MAX_CLIENT_REQUEST_ID_LENGTH} characters`,
    )
  }
  return value
}

function requireOwnedTurn(db, { userId, sessionId, turnId }) {
  const session = db.prepare(`
    SELECT title
    FROM sessions
    WHERE user_id = ? AND token = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `).get(userId, sessionId)
  if (!session) {
    throw new TurnSteeringError('TURN_NOT_FOUND', 'turn not found', 404)
  }
  const started = db.prepare(`
    SELECT 1
    FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND type = 'turn.started'
    LIMIT 1
  `).get(userId, sessionId, turnId)
  if (!started) {
    throw new TurnSteeringError('TURN_NOT_FOUND', 'turn not found', 404)
  }
  return session
}

function assertTurnAcceptingSteering(db, { userId, sessionId, turnId }, now) {
  const terminal = db.prepare(`
    SELECT type
    FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
      AND type IN ('turn.completed', 'turn.cancelled', 'turn.failed')
    ORDER BY sequence DESC
    LIMIT 1
  `).get(userId, sessionId, turnId)
  if (terminal) {
    throw new TurnSteeringError('TURN_STEERING_TURN_FINISHED', 'turn is already finished', 409)
  }

  const lease = db.prepare(`
    SELECT expires_at, cancel_requested_at, accepting_steering
    FROM turn_execution_leases
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, turnId)
  if (!lease || lease.expires_at <= now) {
    throw new TurnSteeringError('TURN_STEERING_TURN_INACTIVE', 'turn is not running', 409)
  }
  if (lease.cancel_requested_at != null) {
    throw new TurnSteeringError('TURN_STEERING_CANCEL_REQUESTED', 'turn cancellation was requested', 409)
  }
  if (lease.accepting_steering === 0) {
    throw new TurnSteeringError('TURN_STEERING_INBOX_CLOSED', 'turn is finishing', 409)
  }
}

/**
 * Persist the steering inbox row and its canonical user-visible message in one
 * immediate transaction. This serializes against tryCloseTurnSteeringInbox:
 * one side wins and the other observes either a pending row or a closed inbox.
 */
export function enqueueTurnSteering({
  userId,
  sessionId,
  turnId,
  content,
  clientRequestId,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId })) {
    throw new TurnSteeringError('TURN_STEERING_SCOPE_REQUIRED', 'userId, sessionId, and turnId are required')
  }
  const text = normalizeContent(content)
  const requestId = normalizeClientRequestId(clientRequestId)
  const db = getDb()
  return db.transaction(() => {
    const session = requireOwnedTurn(db, { userId, sessionId, turnId })
    const existing = db.prepare(`
      SELECT *
      FROM turn_steering_messages
      WHERE user_id = ? AND session_id = ? AND turn_id = ? AND client_request_id = ?
    `).get(userId, sessionId, turnId, requestId)
    if (existing) {
      if (existing.content !== text) {
        throw new TurnSteeringError(
          'TURN_STEERING_IDEMPOTENCY_CONFLICT',
          'clientRequestId was already used with different content',
          409,
        )
      }
      return mapMessage(existing)
    }

    assertTurnAcceptingSteering(db, { userId, sessionId, turnId }, now)
    const id = `turn-steer-${randomUUID()}`
    const messageId = `${id}:user`
    db.prepare(`
      INSERT INTO turn_steering_messages
        (id, user_id, session_id, turn_id, message_id, client_request_id, content, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, userId, sessionId, turnId, messageId, requestId, text, now)
    db.prepare(`
      INSERT INTO messages
        (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)
    `).run(
      messageId,
      sessionId,
      userId,
      text,
      session.title || '',
      JSON.stringify({
        version: 1,
        turnId,
        modelContent: text,
        liveSteering: true,
        steeringId: id,
        steeringClientRequestId: requestId,
      }),
      now,
      now,
    )
    db.prepare(`
      UPDATE sessions
      SET updated_at = CASE WHEN COALESCE(updated_at, 0) < ? THEN ? ELSE updated_at END
      WHERE user_id = ? AND token = ?
    `).run(now, now, userId, sessionId)
    return mapMessage(db.prepare('SELECT * FROM turn_steering_messages WHERE id = ?').get(id))
  }).immediate()
}

export function listTurnSteering({ userId, sessionId, turnId, status, limit = 100 } = {}) {
  if (!validScope({ userId, sessionId, turnId })) return []
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = status
    ? getDb().prepare(`
        SELECT * FROM turn_steering_messages
        WHERE user_id = ? AND session_id = ? AND turn_id = ? AND status = ?
        ORDER BY created_at, id LIMIT ?
      `).all(userId, sessionId, turnId, status, safeLimit)
    : getDb().prepare(`
        SELECT * FROM turn_steering_messages
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
        ORDER BY created_at, id LIMIT ?
      `).all(userId, sessionId, turnId, safeLimit)
  return rows.map(mapMessage)
}

export function claimTurnSteering({
  userId,
  sessionId,
  turnId,
  ownerId,
  limit = 20,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId) {
    return { leaseId: null, messages: [] }
  }
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const leaseId = `turn-steering-lease-${randomUUID()}`
  const db = getDb()
  return db.transaction(() => {
    const ownsTurn = db.prepare(`
      SELECT 1
      FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND expires_at > ?
        AND cancel_requested_at IS NULL AND accepting_steering = 1
    `).get(userId, sessionId, turnId, ownerId, now)
    if (!ownsTurn) return { leaseId: null, messages: [] }
    db.prepare(`
      UPDATE turn_steering_messages
      SET status = 'leased', lease_id = @leaseId,
        lease_owner_id = @ownerId, leased_at = @now
      WHERE id IN (
        SELECT id FROM turn_steering_messages
        WHERE user_id = @userId AND session_id = @sessionId
          AND turn_id = @turnId AND status = 'queued'
        ORDER BY created_at, id LIMIT @limit
      )
    `).run({ leaseId, ownerId, now, userId, sessionId, turnId, limit: safeLimit })
    const messages = db.prepare(`
      SELECT * FROM turn_steering_messages
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND lease_id = ? AND lease_owner_id = ? AND status = 'leased'
      ORDER BY created_at, id
    `).all(userId, sessionId, turnId, leaseId, ownerId).map(mapMessage)
    return messages.length ? { leaseId, messages } : { leaseId: null, messages: [] }
  }).immediate()
}

export function acknowledgeTurnSteering({
  userId,
  sessionId,
  turnId,
  ownerId,
  leaseId,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId || !leaseId) return 0
  const db = getDb()
  return db.transaction(() => {
    const ownsTurn = db.prepare(`
      SELECT 1 FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND expires_at > ?
    `).get(userId, sessionId, turnId, ownerId, now)
    if (!ownsTurn) return 0
    return db.prepare(`
      UPDATE turn_steering_messages
      SET status = 'consumed', consumed_at = ?,
        lease_id = NULL, lease_owner_id = NULL, leased_at = NULL
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND lease_id = ? AND lease_owner_id = ? AND status = 'leased'
    `).run(now, userId, sessionId, turnId, leaseId, ownerId).changes
  }).immediate()
}

/**
 * Reconcile steering that is already present in a durable turn checkpoint but
 * whose lease ACK was lost when the previous process stopped. The active turn
 * owner may acknowledge only the exact durable steering/message identifiers
 * supplied by the checkpoint; unrelated queued or leased rows are untouched.
 */
export function acknowledgeAppliedTurnSteering({
  userId,
  sessionId,
  turnId,
  ownerId,
  messageIds = [],
  steeringIds = [],
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId) return 0
  const exactMessageIds = [...new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
  const exactSteeringIds = [...new Set(
    (Array.isArray(steeringIds) ? steeringIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )]
  if (!exactMessageIds.length && !exactSteeringIds.length) return 0

  const db = getDb()
  return db.transaction(() => {
    const ownsTurn = db.prepare(`
      SELECT 1 FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND expires_at > ?
    `).get(userId, sessionId, turnId, ownerId, now)
    if (!ownsTurn) return 0

    const exactPredicates = []
    const exactIds = []
    if (exactMessageIds.length) {
      exactPredicates.push(`message_id IN (${exactMessageIds.map(() => '?').join(', ')})`)
      exactIds.push(...exactMessageIds)
    }
    if (exactSteeringIds.length) {
      exactPredicates.push(`id IN (${exactSteeringIds.map(() => '?').join(', ')})`)
      exactIds.push(...exactSteeringIds)
    }
    return db.prepare(`
      UPDATE turn_steering_messages
      SET status = 'consumed', consumed_at = ?,
        lease_id = NULL, lease_owner_id = NULL, leased_at = NULL
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND status IN ('queued', 'leased')
        AND (${exactPredicates.join(' OR ')})
    `).run(now, userId, sessionId, turnId, ...exactIds).changes
  }).immediate()
}

export function releaseTurnSteeringLease({
  userId,
  sessionId,
  turnId,
  ownerId,
  leaseId,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId || !leaseId) return 0
  const db = getDb()
  return db.transaction(() => {
    const ownsTurn = db.prepare(`
      SELECT 1 FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND expires_at > ?
    `).get(userId, sessionId, turnId, ownerId, now)
    if (!ownsTurn) return 0
    return db.prepare(`
      UPDATE turn_steering_messages
      SET status = 'queued', lease_id = NULL,
        lease_owner_id = NULL, leased_at = NULL
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND lease_id = ? AND lease_owner_id = ? AND status = 'leased'
    `).run(userId, sessionId, turnId, leaseId, ownerId).changes
  }).immediate()
}

/**
 * A replacement process may recover leases only for the exact turn whose
 * execution lease it owns. Leases created by the current owner are left alone,
 * preventing a second local schedule from stealing an in-flight model request.
 */
export function releaseTurnSteeringLeasesForTurn({
  userId,
  sessionId,
  turnId,
  ownerId,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId) return 0
  const db = getDb()
  return db.transaction(() => {
    const ownsTurn = db.prepare(`
      SELECT 1 FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND expires_at > ?
    `).get(userId, sessionId, turnId, ownerId, now)
    if (!ownsTurn) return 0
    return db.prepare(`
      UPDATE turn_steering_messages
      SET status = 'queued', lease_id = NULL,
        lease_owner_id = NULL, leased_at = NULL
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND status = 'leased'
        AND (lease_owner_id IS NULL OR lease_owner_id <> ?)
    `).run(userId, sessionId, turnId, ownerId).changes
  }).immediate()
}
