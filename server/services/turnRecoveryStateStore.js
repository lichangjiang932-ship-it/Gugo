import { getDb } from '../db.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'

const MIN_DELAY_MS = 25
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 60_000
const MAX_CANDIDATE_VERSION_LENGTH = 500
const CANDIDATE_VERSION_PATTERN = /^(\d+):([^:]+):(\d+)$/

function validScope({ userId, sessionId, turnId } = {}) {
  return !!(userId && sessionId && turnId)
}

function storedTurnEventResolved(row) {
  if (row?.type === 'turn.cancelled' || row?.type === 'turn.failed') return true
  if (row?.type !== 'turn.completed') return false
  try {
    return isSuccessfulTurnCompletedEvent({
      type: row.type,
      payload: JSON.parse(row.payload_json),
    })
  } catch {
    return false
  }
}

function normalizeNow(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : Date.now()
}

function normalizeLimit(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback
}

function boundedText(value, fallback, maxLength = 2_000) {
  return String(value || fallback).slice(0, maxLength)
}

function invalidCandidateVersion() {
  const error = new TypeError('turn recovery candidateVersion must be sequence:type:createdAt')
  error.code = 'TURN_RECOVERY_CANDIDATE_INVALID'
  return error
}

function parseCandidateVersion(value, { stored = false } = {}) {
  const version = String(value ?? '')
  const match = version.length <= MAX_CANDIDATE_VERSION_LENGTH
    ? CANDIDATE_VERSION_PATTERN.exec(version)
    : null
  if (!match) {
    if (stored) return null
    throw invalidCandidateVersion()
  }
  return {
    version,
    sequence: BigInt(match[1]),
  }
}

function compareCandidateVersion(incoming, previousVersion) {
  if (incoming.version === previousVersion) return 'same'
  const previous = parseCandidateVersion(previousVersion, { stored: true })
  // A valid event identity may replace a legacy opaque value, but an opaque
  // value is never emitted by this store again.
  if (!previous || incoming.sequence > previous.sequence) return 'newer'
  if (incoming.sequence < previous.sequence) return 'stale'
  return 'conflict'
}

function mapRow(row) {
  return row ? {
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    candidateVersion: row.candidate_version,
    status: row.status,
    attemptCount: row.attempt_count,
    retryable: row.retryable !== 0,
    firstFailedAt: row.first_failed_at,
    lastFailedAt: row.last_failed_at,
    nextRetryAt: row.next_retry_at ?? null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message,
  } : null
}

export function getTurnRecoveryState(scope = {}) {
  if (!validScope(scope)) return null
  return mapRow(getDb().prepare(`
    SELECT * FROM turn_recovery_states
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(scope.userId, scope.sessionId, scope.turnId))
}

/**
 * Atomically advances one candidate's failure budget. Equal jitter keeps a
 * positive delay while preventing many abandoned turns from retrying together.
 */
export function recordTurnRecoveryFailure({
  userId,
  sessionId,
  turnId,
  candidateVersion,
  retryable = true,
  errorCode = null,
  errorMessage = 'turn recovery failed',
  now = Date.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random = Math.random,
} = {}) {
  const scope = { userId, sessionId, turnId }
  if (!validScope(scope)) throw new TypeError('turn recovery scope is required')
  const candidate = parseCandidateVersion(candidateVersion)
  const version = candidate.version
  const failedAt = normalizeNow(now)
  const attemptsLimit = normalizeLimit(maxAttempts, DEFAULT_MAX_ATTEMPTS)
  const base = normalizeLimit(baseDelayMs, DEFAULT_BASE_DELAY_MS, MIN_DELAY_MS)
  const cap = Math.max(base, normalizeLimit(maxDelayMs, DEFAULT_MAX_DELAY_MS, MIN_DELAY_MS))
  const canRetry = retryable !== false
  const db = getDb()

  return db.transaction(() => {
    const previous = db.prepare(`
      SELECT *
      FROM turn_recovery_states
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(userId, sessionId, turnId)
    const candidateOrder = previous
      ? compareCandidateVersion(candidate, previous.candidate_version)
      : 'newer'
    if (candidateOrder === 'stale' || candidateOrder === 'conflict') {
      return mapRow(previous)
    }

    const sameCandidate = candidateOrder === 'same'
    const attemptCount = sameCandidate ? previous.attempt_count + 1 : 1
    const deadLetter = !canRetry || attemptCount >= attemptsLimit
    const exponent = Math.min(cap, base * 2 ** Math.max(0, attemptCount - 1))
    const sample = Math.min(1, Math.max(0, Number(random?.()) || 0))
    const delayMs = Math.max(MIN_DELAY_MS, Math.floor(exponent * (0.5 + (sample * 0.5))))
    const nextRetryAt = deadLetter ? null : failedAt + delayMs
    const firstFailedAt = sameCandidate ? previous.first_failed_at : failedAt

    const expectedCandidate = previous?.candidate_version ?? null
    const expectedAttemptCount = sameCandidate ? previous.attempt_count : null
    const write = db.prepare(`
      INSERT INTO turn_recovery_states (
        user_id, session_id, turn_id, candidate_version, status,
        attempt_count, retryable, first_failed_at, last_failed_at,
        next_retry_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
        candidate_version = excluded.candidate_version,
        status = excluded.status,
        attempt_count = excluded.attempt_count,
        retryable = excluded.retryable,
        first_failed_at = excluded.first_failed_at,
        last_failed_at = excluded.last_failed_at,
        next_retry_at = excluded.next_retry_at,
        error_code = excluded.error_code,
        error_message = excluded.error_message
      WHERE turn_recovery_states.candidate_version = ?
        AND (? IS NULL OR turn_recovery_states.attempt_count = ?)
    `).run(
      userId,
      sessionId,
      turnId,
      version,
      deadLetter ? 'dead_letter' : 'retrying',
      attemptCount,
      canRetry ? 1 : 0,
      firstFailedAt,
      failedAt,
      nextRetryAt,
      errorCode ? boundedText(errorCode, '', 200) : null,
      boundedText(errorMessage, 'turn recovery failed'),
      expectedCandidate,
      expectedAttemptCount,
      expectedAttemptCount,
    )

    // BEGIN IMMEDIATE keeps the read/CAS pair in one SQLite writer epoch. The
    // predicate remains part of the UPSERT so nested/alternate adapters fail
    // closed if the expected row ever differs.
    if (write.changes !== 1) {
      return mapRow(db.prepare(`
        SELECT * FROM turn_recovery_states
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get(userId, sessionId, turnId))
    }
    return mapRow(db.prepare(`
      SELECT * FROM turn_recovery_states
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(userId, sessionId, turnId))
  }).immediate()
}

export function clearTurnRecoveryState(scope = {}, { candidateVersion = null } = {}) {
  if (!validScope(scope)) return false
  const params = [scope.userId, scope.sessionId, scope.turnId]
  const versionClause = candidateVersion == null ? '' : ' AND candidate_version = ?'
  if (candidateVersion != null) params.push(String(candidateVersion))
  return getDb().prepare(`
    DELETE FROM turn_recovery_states
    WHERE user_id = ? AND session_id = ? AND turn_id = ?${versionClause}
  `).run(...params).changes === 1
}

/** Remove diagnostics only after the corresponding turn is durably terminal. */
export function pruneResolvedTurnRecoveryStates() {
  const db = getDb()
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT recovery.user_id, recovery.session_id, recovery.turn_id,
        event.type, event.payload_json
      FROM turn_recovery_states AS recovery
      JOIN turn_events AS event
        ON event.user_id = recovery.user_id
       AND event.session_id = recovery.session_id
       AND event.turn_id = recovery.turn_id
       AND event.sequence = (
         SELECT MAX(latest.sequence)
         FROM turn_events AS latest
         WHERE latest.user_id = recovery.user_id
           AND latest.session_id = recovery.session_id
           AND latest.turn_id = recovery.turn_id
       )
      WHERE event.type IN ('turn.completed', 'turn.cancelled', 'turn.failed')
    `).all()
    const remove = db.prepare(`
      DELETE FROM turn_recovery_states
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `)
    let changes = 0
    for (const row of rows) {
      if (!storedTurnEventResolved(row)) continue
      changes += remove.run(row.user_id, row.session_id, row.turn_id).changes
    }
    return changes
  }).immediate()
}

export function listTurnRecoveryStates({ status = null, limit = 1_000 } = {}) {
  const safeLimit = Math.min(10_000, normalizeLimit(limit, 1_000))
  const rows = status === 'retrying' || status === 'dead_letter'
    ? getDb().prepare(`
        SELECT * FROM turn_recovery_states
        WHERE status = ?
        ORDER BY last_failed_at DESC
        LIMIT ?
      `).all(status, safeLimit)
    : getDb().prepare(`
        SELECT * FROM turn_recovery_states
        ORDER BY last_failed_at DESC
        LIMIT ?
      `).all(safeLimit)
  return rows.map(mapRow)
}
