import { getDb } from '../db.js'
import { assertUserDataMutationAllowed } from './userDataClearGuard.js'

// A turn can briefly monopolize the event loop while packaging a large local
// artifact. Keep enough expiry headroom for a saturated Windows host; the
// heartbeat still renews every third of this window and explicit test/runtime
// overrides can use shorter leases when fast takeover is required.
export const DEFAULT_TURN_EXECUTION_LEASE_MS = 120_000

function normalizedDuration(leaseMs) {
  return Math.max(1_000, Number(leaseMs) || DEFAULT_TURN_EXECUTION_LEASE_MS)
}

function validScope({ userId, sessionId, turnId } = {}) {
  return !!(userId && sessionId && turnId)
}

function normalizedFencingToken(value) {
  const token = Number(value)
  return Number.isSafeInteger(token) && token > 0 ? token : null
}

function rememberFencingToken(db, { userId, sessionId, turnId, fencingToken, now }) {
  db.prepare(`
    INSERT INTO turn_execution_fences
      (user_id, session_id, turn_id, fencing_token, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
      fencing_token = MAX(turn_execution_fences.fencing_token, excluded.fencing_token),
      updated_at = MAX(turn_execution_fences.updated_at, excluded.updated_at)
  `).run(userId, sessionId, turnId, fencingToken, now)
}

function allocateFencingToken(db, { userId, sessionId, turnId, currentToken, now }) {
  const counter = db.prepare(`
    SELECT fencing_token
    FROM turn_execution_fences
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, turnId)
  const previous = Math.max(
    normalizedFencingToken(counter?.fencing_token) || 0,
    normalizedFencingToken(currentToken) || 0,
  )
  if (previous >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('turn execution fencing token space is exhausted')
    error.code = 'TURN_EXECUTION_FENCE_EXHAUSTED'
    error.status = 503
    error.retryable = false
    throw error
  }
  const fencingToken = previous + 1
  rememberFencingToken(db, { userId, sessionId, turnId, fencingToken, now })
  return fencingToken
}

function mapLease(row) {
  return row ? {
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    fencingToken: row.fencing_token,
    cancelRequestedAt: row.cancel_requested_at ?? null,
    acceptingSteering: row.accepting_steering !== 0,
  } : null
}

/**
 * Atomically claims a turn for one process. Expired leases may be recovered,
 * while a pending cancellation survives owner failure so the recovery worker
 * can finish the turn as cancelled instead of silently restarting it.
 */
export function claimTurnExecutionLease({
  userId,
  sessionId,
  turnId,
  ownerId,
  now = Date.now(),
  leaseMs = DEFAULT_TURN_EXECUTION_LEASE_MS,
} = {}) {
  if (!validScope({ userId, sessionId, turnId }) || !ownerId) return false
  const expiresAt = now + normalizedDuration(leaseMs)
  const db = getDb()
  return db.transaction(() => {
    assertUserDataMutationAllowed(
      db,
      userId,
      'A turn cannot start while local session data is being deleted',
    )
    const latest = db.prepare(`
      SELECT type FROM turn_events
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(userId, sessionId, turnId)
    if (['turn.completed', 'turn.cancelled', 'turn.failed'].includes(latest?.type)) return false
    const current = db.prepare(`
      SELECT owner_id, expires_at, fencing_token
      FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(userId, sessionId, turnId)
    if (current && current.owner_id !== ownerId && current.expires_at > now) return false

    const sameLiveOwner = current?.owner_id === ownerId && current.expires_at > now
    const fencingToken = sameLiveOwner
      ? normalizedFencingToken(current.fencing_token)
      : allocateFencingToken(db, {
          userId,
          sessionId,
          turnId,
          currentToken: current?.fencing_token,
          now,
        })
    if (!fencingToken) {
      throw new Error('turn execution lease has an invalid fencing token')
    }
    if (sameLiveOwner) {
      rememberFencingToken(db, { userId, sessionId, turnId, fencingToken, now })
    }
    const result = db.prepare(`
      INSERT INTO turn_execution_leases
        (user_id, session_id, turn_id, owner_id, acquired_at, expires_at,
         cancel_requested_at, accepting_steering, fencing_token)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)
      ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        fencing_token = excluded.fencing_token,
        accepting_steering = CASE
          WHEN turn_execution_leases.owner_id = excluded.owner_id
            AND turn_execution_leases.expires_at > excluded.acquired_at
            THEN turn_execution_leases.accepting_steering
          ELSE 1
        END
      WHERE turn_execution_leases.owner_id = excluded.owner_id
         OR turn_execution_leases.expires_at <= excluded.acquired_at
    `).run(userId, sessionId, turnId, ownerId, now, expiresAt, fencingToken)
    return result.changes === 1
  }).immediate()
}

export function renewTurnExecutionLease({
  userId,
  sessionId,
  turnId,
  ownerId,
  fencingToken,
  now = Date.now(),
  leaseMs = DEFAULT_TURN_EXECUTION_LEASE_MS,
} = {}) {
  const token = normalizedFencingToken(fencingToken)
  if (!validScope({ userId, sessionId, turnId }) || !ownerId || !token) {
    return { renewed: false, cancelRequested: false }
  }
  const expiresAt = now + normalizedDuration(leaseMs)
  const db = getDb()
  return db.transaction(() => {
    const updated = db.prepare(`
      UPDATE turn_execution_leases
      SET expires_at = ?
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND fencing_token = ? AND expires_at > ?
    `).run(expiresAt, userId, sessionId, turnId, ownerId, token, now)
    if (updated.changes !== 1) return { renewed: false, cancelRequested: false }
    const row = db.prepare(`
      SELECT cancel_requested_at
      FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND fencing_token = ?
    `).get(userId, sessionId, turnId, ownerId, token)
    return { renewed: true, cancelRequested: row?.cancel_requested_at != null }
  })()
}

export function requestTurnExecutionCancellation({
  userId,
  sessionId,
  turnId,
  now = Date.now(),
} = {}) {
  if (!validScope({ userId, sessionId, turnId })) return false
  return getDb().prepare(`
    UPDATE turn_execution_leases
    SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
    WHERE user_id = ? AND session_id = ? AND turn_id = ? AND expires_at > ?
  `).run(now, userId, sessionId, turnId, now).changes === 1
}

/**
 * Close the live-steering inbox only when this process still owns the active
 * turn and no unclaimed message remains. Steering already leased by this owner
 * is part of the checkpoint being finalized and must not force a duplicate
 * model round. enqueueTurnSteering uses
 * an immediate transaction too, so either the enqueue wins and closing sees a
 * pending row, or closing wins and the enqueue observes accepting_steering=0.
 */
export function tryCloseTurnSteeringInbox({
  userId,
  sessionId,
  turnId,
  ownerId,
  fencingToken,
  now = Date.now(),
} = {}) {
  const token = normalizedFencingToken(fencingToken)
  if (!validScope({ userId, sessionId, turnId }) || !ownerId || !token) {
    return { closed: false, reason: 'not_owner', pendingCount: 0 }
  }
  const db = getDb()
  return db.transaction(() => {
    const lease = db.prepare(`
      SELECT owner_id, expires_at, accepting_steering, fencing_token
      FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(userId, sessionId, turnId)
    if (!lease
      || lease.owner_id !== ownerId
      || lease.fencing_token !== token
      || lease.expires_at <= now) {
      return { closed: false, reason: 'not_owner', pendingCount: 0 }
    }
    if (lease.accepting_steering === 0) {
      return { closed: true, reason: 'already_closed', pendingCount: 0 }
    }
    const pendingCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM turn_steering_messages
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND (
          status = 'queued'
          OR (status = 'leased' AND COALESCE(lease_owner_id, '') <> ?)
        )
    `).get(userId, sessionId, turnId, ownerId)?.count) || 0
    if (pendingCount > 0) return { closed: false, reason: 'pending', pendingCount }

    const closed = db.prepare(`
      UPDATE turn_execution_leases
      SET accepting_steering = 0
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
        AND owner_id = ? AND fencing_token = ?
        AND expires_at > ? AND accepting_steering = 1
    `).run(userId, sessionId, turnId, ownerId, token, now).changes === 1
    return closed
      ? { closed: true, reason: 'closed', pendingCount: 0 }
      : { closed: false, reason: 'not_owner', pendingCount: 0 }
  }).immediate()
}

export function releaseTurnExecutionLease({
  userId,
  sessionId,
  turnId,
  ownerId,
  fencingToken,
} = {}) {
  const token = normalizedFencingToken(fencingToken)
  if (!validScope({ userId, sessionId, turnId }) || !ownerId || !token) return false
  return getDb().prepare(`
    DELETE FROM turn_execution_leases
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
      AND owner_id = ? AND fencing_token = ?
  `).run(userId, sessionId, turnId, ownerId, token).changes === 1
}

export function getTurnExecutionLease({ userId, sessionId, turnId } = {}) {
  if (!validScope({ userId, sessionId, turnId })) return null
  return mapLease(getDb().prepare(`
    SELECT * FROM turn_execution_leases
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, turnId))
}

export function isTurnExecutionLeaseActive(scope = {}, now = Date.now()) {
  const lease = getTurnExecutionLease(scope)
  return !!lease && lease.expiresAt > now
}

export function hasActiveTurnExecutionLeaseForSession({ userId, sessionId } = {}, now = Date.now()) {
  if (!userId || !sessionId) return false
  return !!getDb().prepare(`
    SELECT 1 FROM turn_execution_leases
    WHERE user_id = ? AND session_id = ? AND expires_at > ?
    LIMIT 1
  `).get(userId, sessionId, now)
}

/**
 * Returns the durable, non-terminal turns that existed before this process
 * started. Lease metadata is included so the recovery runtime can wait for a
 * live owner instead of stealing its work.
 */
export function listUnfinishedTurnExecutions({ before = Date.now(), limit = 10_000 } = {}) {
  const safeBefore = Number.isFinite(Number(before)) ? Math.floor(Number(before)) : Date.now()
  const safeLimit = Math.min(100_000, Math.max(1, Math.floor(Number(limit) || 10_000)))
  const rows = getDb().prepare(`
    WITH summaries AS (
      SELECT
        user_id,
        session_id,
        turn_id,
        MAX(sequence) AS last_sequence,
        MAX(CASE WHEN type = 'turn.started' THEN 1 ELSE 0 END) AS has_started
      FROM turn_events
      GROUP BY user_id, session_id, turn_id
    )
    SELECT
      summary.user_id,
      summary.session_id,
      summary.turn_id,
      latest.sequence AS last_sequence,
      latest.type AS last_event_type,
      latest.created_at AS last_event_at,
      lease.owner_id,
      lease.expires_at,
      lease.fencing_token,
      lease.cancel_requested_at
    FROM summaries AS summary
    JOIN turn_events AS latest
      ON latest.user_id = summary.user_id
     AND latest.session_id = summary.session_id
     AND latest.turn_id = summary.turn_id
     AND latest.sequence = summary.last_sequence
    LEFT JOIN turn_execution_leases AS lease
      ON lease.user_id = summary.user_id
     AND lease.session_id = summary.session_id
     AND lease.turn_id = summary.turn_id
    WHERE summary.has_started = 1
      AND latest.type NOT IN ('turn.completed', 'turn.cancelled', 'turn.failed')
      AND latest.created_at <= ?
    ORDER BY latest.created_at ASC, summary.user_id ASC, summary.session_id ASC, summary.turn_id ASC
    LIMIT ?
  `).all(safeBefore, safeLimit)
  return rows.map((row) => ({
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    lastSequence: row.last_sequence,
    lastEventType: row.last_event_type,
    lastEventAt: row.last_event_at,
    lease: row.owner_id ? {
      ownerId: row.owner_id,
      expiresAt: row.expires_at,
      fencingToken: row.fencing_token,
      cancelRequestedAt: row.cancel_requested_at ?? null,
    } : null,
  }))
}

export function pruneExpiredTurnExecutionLeases(now = Date.now()) {
  return getDb().prepare(
    'DELETE FROM turn_execution_leases WHERE expires_at <= ?',
  ).run(now).changes
}
