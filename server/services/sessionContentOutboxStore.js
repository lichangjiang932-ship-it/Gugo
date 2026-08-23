import crypto, { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { normalizeSessionContentEvent } from './sessionJsonlCodec.js'

const MAX_BATCH_SIZE = 1_000
const DEFAULT_LEASE_MS = 60_000
const MAX_LEASE_MS = 60 * 60 * 1_000
const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 5 * 60 * 1_000
const MAX_ERROR_LENGTH = 2_000

function outboxError(code, message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    name: 'SessionContentOutboxError',
    code,
    retryable: false,
  })
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized <= 0) return fallback
  return Math.min(normalized, maximum)
}

function nonNegativeTimestamp(value, label) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw outboxError('SESSION_CONTENT_OUTBOX_INVALID', `${label} must be a non-negative safe integer`)
  }
  return normalized
}

function requiredOwner(value) {
  const owner = String(value || '').trim()
  if (!owner || owner.length > 512) {
    throw outboxError('SESSION_CONTENT_OUTBOX_INVALID', 'ownerId must contain 1-512 characters')
  }
  return owner
}

function eventFingerprint(event) {
  return crypto.createHash('sha256').update(JSON.stringify({
    userId: event.userId,
    sessionId: event.sessionId,
    eventType: event.eventType,
    payload: event.payload,
  })).digest('hex')
}

function normalizedEnqueueEvent(input, createdAt) {
  return normalizeSessionContentEvent({
    id: 1,
    eventId: input?.eventId || randomUUID(),
    userId: input?.userId,
    sessionId: input?.sessionId,
    eventType: input?.eventType,
    payload: input?.payload,
    createdAt,
  })
}

function parsePayload(value) {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw outboxError('SESSION_CONTENT_OUTBOX_CORRUPT', 'outbox payload is not valid JSON', cause)
  }
}

function mapClaimedRow(row) {
  if (!row) return null
  return normalizeSessionContentEvent({
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
  })
}

function mapInspectionRow(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: row.status === 'materialized' ? null : parsePayload(row.payload_json),
    eventFingerprint: row.event_fingerprint,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    materializedAt: row.materialized_at ?? null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

/**
 * Insert using the caller's database handle. If the caller already owns a
 * transaction, the message mutation and this durable hand-off commit or roll
 * back together.
 */
export function enqueueSessionContentEventInDb(db, input = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const createdAt = nonNegativeTimestamp(input.createdAt ?? Date.now(), 'createdAt')
  const event = normalizedEnqueueEvent(input, createdAt)
  const payloadJson = JSON.stringify(event.payload)
  const fingerprint = eventFingerprint(event)
  const result = db.prepare(`
    INSERT INTO session_content_outbox (
      event_id, user_id, session_id, event_type, payload_json, event_fingerprint,
      status, attempt_count, available_at, lease_owner, lease_expires_at,
      materialized_at, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    event.eventId,
    event.userId,
    event.sessionId,
    event.eventType,
    payloadJson,
    fingerprint,
    createdAt,
    createdAt,
    createdAt,
  )
  const row = result.changes === 1
    ? db.prepare('SELECT * FROM session_content_outbox WHERE id = ?').get(Number(result.lastInsertRowid))
    : db.prepare('SELECT * FROM session_content_outbox WHERE event_id = ?').get(event.eventId)
  if (!row || row.event_fingerprint !== fingerprint) {
    throw outboxError(
      'SESSION_CONTENT_OUTBOX_IDEMPOTENCY_CONFLICT',
      'eventId was already used for a different session content event',
    )
  }
  return mapInspectionRow(row)
}

export function enqueueSessionContentEvent(input = {}) {
  const db = getDb()
  return db.transaction(() => enqueueSessionContentEventInDb(db, input))()
}

function releaseExpiredLeases(db, now) {
  db.prepare(`
    UPDATE session_content_outbox
    SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
      available_at = MIN(available_at, ?), updated_at = ?
    WHERE status = 'leased' AND lease_expires_at <= ?
  `).run(now, now, now)
}

/** Claim at most the earliest unmaterialized event for each session. */
export function claimSessionContentOutbox({
  ownerId,
  userId = null,
  limit = 16,
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now(),
  db = getDb(),
} = {}) {
  const owner = requiredOwner(ownerId)
  const checkedAt = nonNegativeTimestamp(now, 'now')
  const safeLimit = positiveInteger(limit, 16, MAX_BATCH_SIZE)
  const safeLeaseMs = positiveInteger(leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS)
  const leaseExpiresAt = checkedAt + safeLeaseMs
  const scopedUserId = userId == null ? null : String(userId).trim()
  return db.transaction(() => {
    releaseExpiredLeases(db, checkedAt)
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT current.id
        FROM session_content_outbox AS current
        WHERE current.status = 'pending'
          AND current.available_at <= @now
          AND (@userId IS NULL OR current.user_id = @userId)
          AND NOT EXISTS (
            SELECT 1
            FROM user_data_clear_operations AS clear_operation
            WHERE clear_operation.owner_id = current.user_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM session_content_outbox AS earlier
            WHERE earlier.user_id = current.user_id
              AND earlier.session_id = current.session_id
              AND earlier.id < current.id
              AND earlier.status <> 'materialized'
          )
        ORDER BY current.id ASC
        LIMIT @limit
      )
      UPDATE session_content_outbox
      SET status = 'leased', lease_owner = @owner,
        lease_expires_at = @leaseExpiresAt, updated_at = @now
      WHERE id IN (SELECT id FROM candidates) AND status = 'pending'
      RETURNING *
    `).all({
      now: checkedAt,
      userId: scopedUserId || null,
      limit: safeLimit,
      owner,
      leaseExpiresAt,
    })
    return Object.freeze(rows.sort((left, right) => left.id - right.id).map(mapClaimedRow))
  }).immediate()
}

export function acknowledgeSessionContentOutbox({
  id,
  eventId,
  ownerId,
  now = Date.now(),
  db = getDb(),
} = {}) {
  const owner = requiredOwner(ownerId)
  const checkedAt = nonNegativeTimestamp(now, 'now')
  const result = db.prepare(`
    UPDATE session_content_outbox
    SET status = 'materialized', payload_json = '{}', materialized_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
    WHERE id = ? AND event_id = ? AND status = 'leased' AND lease_owner = ?
      AND lease_expires_at > ?
      AND NOT EXISTS (
        SELECT 1
        FROM user_data_clear_operations AS clear_operation
        WHERE clear_operation.owner_id = session_content_outbox.user_id
      )
  `).run(checkedAt, checkedAt, id, eventId, owner, checkedAt)
  return result.changes === 1
}

/**
 * Commit one filesystem record under the exact durable outbox lease.
 *
 * The synchronous callback deliberately runs while an IMMEDIATE SQLite
 * transaction owns the write lock. A user-data clear barrier, lease takeover,
 * or later event claim therefore cannot interleave with tail repair, append,
 * fsync, and the final acknowledgement. If SQLite commit fails after fsync,
 * replay remains safe because the JSONL projection deduplicates eventId.
 */
export function materializeSessionContentOutbox({
  id,
  eventId,
  ownerId,
  now = Date.now(),
  db = getDb(),
} = {}, append) {
  if (typeof append !== 'function') throw new TypeError('append must be a function')
  const owner = requiredOwner(ownerId)
  const checkedAt = nonNegativeTimestamp(now, 'now')

  return db.transaction(() => {
    const row = db.prepare(`
      SELECT outbox.*
      FROM session_content_outbox AS outbox
      WHERE outbox.id = ? AND outbox.event_id = ?
        AND outbox.status = 'leased' AND outbox.lease_owner = ?
        AND outbox.lease_expires_at > ?
        AND NOT EXISTS (
          SELECT 1
          FROM user_data_clear_operations AS clear_operation
          WHERE clear_operation.owner_id = outbox.user_id
        )
    `).get(id, eventId, owner, checkedAt)
    if (!row) {
      throw outboxError(
        'SESSION_CONTENT_OUTBOX_LEASE_LOST',
        'session content outbox lease is missing, expired, superseded, or fenced by user-data clear',
      )
    }

    const event = mapClaimedRow(row)
    const written = append(event)
    if (written && typeof written.then === 'function') {
      throw outboxError(
        'SESSION_CONTENT_OUTBOX_ASYNC_APPEND_UNSUPPORTED',
        'session content append must complete synchronously inside the SQLite fence',
      )
    }

    const acknowledged = db.prepare(`
      UPDATE session_content_outbox
      SET status = 'materialized', payload_json = '{}', materialized_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND event_id = ? AND status = 'leased' AND lease_owner = ?
        AND lease_expires_at > ?
        AND NOT EXISTS (
          SELECT 1
          FROM user_data_clear_operations AS clear_operation
          WHERE clear_operation.owner_id = session_content_outbox.user_id
        )
    `).run(checkedAt, checkedAt, id, eventId, owner, checkedAt)
    if (acknowledged.changes !== 1) {
      throw outboxError(
        'SESSION_CONTENT_OUTBOX_LEASE_LOST',
        'session content outbox lease changed before acknowledgement',
      )
    }
    return Object.freeze({ event, written })
  }).immediate()
}

function retryDelay(attemptCount) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.min(18, Math.max(0, attemptCount - 1))))
}

export function releaseSessionContentOutboxFailure({
  id,
  eventId,
  ownerId,
  error,
  now = Date.now(),
  db = getDb(),
} = {}) {
  const owner = requiredOwner(ownerId)
  const checkedAt = nonNegativeTimestamp(now, 'now')
  const message = String(error?.message || error || 'session content materialization failed')
    .slice(0, MAX_ERROR_LENGTH)
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT attempt_count
      FROM session_content_outbox
      WHERE id = ? AND event_id = ? AND status = 'leased' AND lease_owner = ?
    `).get(id, eventId, owner)
    if (!row) return false
    const attempts = Number(row.attempt_count) + 1
    const result = db.prepare(`
      UPDATE session_content_outbox
      SET status = 'pending', attempt_count = ?, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND event_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(
      attempts,
      checkedAt + retryDelay(attempts),
      message,
      checkedAt,
      id,
      eventId,
      owner,
    )
    return result.changes === 1
  }).immediate()
}

export function listSessionContentOutbox({
  userId,
  sessionId = null,
  status = null,
  limit = 1_000,
  db = getDb(),
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) return Object.freeze([])
  const safeLimit = positiveInteger(limit, 1_000, 10_000)
  const rows = db.prepare(`
    SELECT *
    FROM session_content_outbox
    WHERE user_id = @userId
      AND (@sessionId IS NULL OR session_id = @sessionId)
      AND (@status IS NULL OR status = @status)
    ORDER BY id ASC
    LIMIT @limit
  `).all({
    userId: safeUserId,
    sessionId: sessionId == null ? null : String(sessionId),
    status: status == null ? null : String(status),
    limit: safeLimit,
  })
  return Object.freeze(rows.map(mapInspectionRow))
}
