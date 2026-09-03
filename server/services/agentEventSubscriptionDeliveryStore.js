import { getDb } from '../db.js'
import { readAgentEventOutboxSubscriptionPage } from './agentEventOutboxStore.js'
import {
  assertActiveLease,
  inImmediateTransaction,
  mapSubscription,
  nonNegativeInteger,
  normalizeLeaseToken,
  normalizeSubscriptionKey,
  positiveInteger,
  requireSubscription,
  subscriptionError,
} from './agentEventSubscriptionRegistryStore.js'

const MAX_SCAN_LIMIT = 1_000
const FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/u
const SOURCE_DELETED_FAILURE_CODE = 'AGENT_EVENT_SOURCE_DELETED'

/**
 * Convert retries whose source event belongs to a user being cleared into a
 * metadata-only DLQ record. The caller must own the surrounding IMMEDIATE
 * transaction so this transition and deletion of the outbox rows commit or
 * roll back together.
 */
export function settleDeletedUserAgentEventRetriesInTransaction({
  userId,
  now = Date.now(),
  db = getDb(),
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  if (!db.inTransaction) {
    throw subscriptionError(
      'AGENT_EVENT_RETRY_SETTLEMENT_TRANSACTION_REQUIRED',
      'deleted-user retry settlement requires a caller-owned transaction',
    )
  }
  const ownerId = typeof userId === 'string' ? userId.trim() : ''
  if (!ownerId) throw new TypeError('userId is required')
  const timestamp = nonNegativeInteger(now, 'now')
  const retries = db.prepare(`
    SELECT
      subscription.subscription_key,
      subscription.retry_cursor,
      subscription.retry_attempts,
      subscription.event_type
    FROM agent_event_subscriptions AS subscription
    JOIN agent_event_outbox AS event
      ON event.cursor = subscription.retry_cursor
      AND event.event_type = subscription.event_type
    WHERE subscription.user_id = ?
      AND event.user_id = subscription.user_id
      AND subscription.status IN ('active', 'disabled')
    ORDER BY subscription.subscription_key
  `).all(ownerId)

  const insertDeadLetter = db.prepare(`
    INSERT INTO agent_event_subscription_dlq (
      subscription_key, cursor, event_type, failure_code, attempts, failed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const settleRetry = db.prepare(`
    UPDATE agent_event_subscriptions
    SET scanned_cursor = retry_cursor,
        retry_cursor = NULL, retry_attempts = 0, retry_not_before = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        lease_generation = lease_generation + 1, updated_at = ?
    WHERE subscription_key = ?
      AND retry_cursor = ?
      AND retry_attempts = ?
      AND event_type = ?
      AND status IN ('active', 'disabled')
  `)

  for (const retry of retries) {
    const attempts = Math.max(1, retry.retry_attempts)
    insertDeadLetter.run(
      retry.subscription_key,
      retry.retry_cursor,
      retry.event_type,
      SOURCE_DELETED_FAILURE_CODE,
      attempts,
      timestamp,
    )
    const settled = settleRetry.run(
      timestamp,
      retry.subscription_key,
      retry.retry_cursor,
      retry.retry_attempts,
      retry.event_type,
    )
    if (settled.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'durable subscription retry changed during deleted-user settlement',
      )
    }
  }
  return retries.length
}

function updateScannedCursor(db, token, row, cursor, now) {
  if (cursor <= row.scanned_cursor) return row
  const result = db.prepare(`
    UPDATE agent_event_subscriptions SET scanned_cursor = ?, updated_at = ?
    WHERE subscription_key = ? AND status = 'active'
      AND scanned_cursor = ? AND lease_owner = ? AND lease_generation = ?
      AND lease_expires_at > ?
  `).run(
    cursor,
    now,
    token.subscriptionKey,
    row.scanned_cursor,
    token.owner,
    token.generation,
    now,
  )
  if (result.changes !== 1) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
      'durable subscription cursor was fenced while scanning',
    )
  }
  return requireSubscription(db, token.subscriptionKey)
}

export function scanAgentEventSubscription(input, {
  now = Date.now(),
  limit = 100,
  db = getDb(),
} = {}) {
  const token = normalizeLeaseToken(input)
  const timestamp = nonNegativeInteger(now, 'now')
  const scanLimit = positiveInteger(limit, 'limit', MAX_SCAN_LIMIT)
  return inImmediateTransaction(db, () => {
    let row = assertActiveLease(db, token, timestamp)
    if (row.retry_not_before !== null && row.retry_not_before > timestamp) {
      return Object.freeze({
        subscription: mapSubscription(row),
        entry: null,
        retryAt: row.retry_not_before,
        scannedThrough: row.scanned_cursor,
        hasMore: true,
      })
    }
    const page = readAgentEventOutboxSubscriptionPage({
      db,
      afterCursor: row.scanned_cursor,
      userId: row.user_id,
      eventType: row.event_type,
      limit: scanLimit,
    })
    if (page.stream.epoch !== row.stream_epoch) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'subscription cursor changed stream epoch while scanning',
      )
    }
    const match = page.entry
    row = updateScannedCursor(db, token, row, page.scannedThrough, timestamp)
    if (row.retry_cursor !== null && match?.cursor !== row.retry_cursor) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'pending retry no longer identifies the next matching Agent Event',
      )
    }
    return Object.freeze({
      subscription: mapSubscription(row),
      entry: match,
      retryAt: null,
      scannedThrough: row.scanned_cursor,
      hasMore: Boolean(match) || page.hasMore,
    })
  })
}

function assertNextMatchingCursor(db, row, cursor) {
  const next = db.prepare(`
    SELECT cursor FROM agent_event_outbox
    WHERE cursor > ? AND user_id = ? AND event_type = ?
    ORDER BY cursor ASC LIMIT 1
  `).get(row.scanned_cursor, row.user_id, row.event_type)
  if (!next || next.cursor !== cursor) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_CURSOR_INVALID',
      'cursor is not the next matching Agent Event for this subscription',
    )
  }
  if (row.retry_cursor !== null && row.retry_cursor !== cursor) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_CURSOR_INVALID',
      'cursor does not match the pending retry',
    )
  }
}

export function acknowledgeAgentEventSubscription(input, {
  cursor,
  now = Date.now(),
  db = getDb(),
} = {}) {
  const token = normalizeLeaseToken(input)
  const acknowledgedCursor = positiveInteger(cursor, 'cursor')
  const timestamp = nonNegativeInteger(now, 'now')
  return inImmediateTransaction(db, () => {
    const row = assertActiveLease(db, token, timestamp)
    assertNextMatchingCursor(db, row, acknowledgedCursor)
    const result = db.prepare(`
      UPDATE agent_event_subscriptions
      SET acked_cursor = ?, scanned_cursor = ?, retry_cursor = NULL,
          retry_attempts = 0, retry_not_before = NULL, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
        AND scanned_cursor = ? AND lease_owner = ? AND lease_generation = ?
        AND lease_expires_at > ?
    `).run(
      acknowledgedCursor,
      acknowledgedCursor,
      timestamp,
      token.subscriptionKey,
      row.scanned_cursor,
      token.owner,
      token.generation,
      timestamp,
    )
    if (result.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
        'durable subscription ACK was fenced',
      )
    }
    return mapSubscription(requireSubscription(db, token.subscriptionKey))
  })
}

function retryDelay(row, attempt) {
  const exponent = Math.min(30, Math.max(0, attempt - 1))
  return Math.min(row.retry_max_delay_ms, row.retry_base_delay_ms * (2 ** exponent))
}

function normalizeFailureCode(value) {
  if (typeof value !== 'string') return 'AGENT_EVENT_DELIVERY_FAILED'
  const normalized = value.trim().toUpperCase()
  return FAILURE_CODE_RE.test(normalized) ? normalized : 'AGENT_EVENT_DELIVERY_FAILED'
}

export function failAgentEventSubscription(input, {
  cursor,
  failureCode = 'AGENT_EVENT_DELIVERY_FAILED',
  now = Date.now(),
  db = getDb(),
} = {}) {
  const token = normalizeLeaseToken(input)
  const failedCursor = positiveInteger(cursor, 'cursor')
  const code = normalizeFailureCode(failureCode)
  const timestamp = nonNegativeInteger(now, 'now')
  return inImmediateTransaction(db, () => {
    const row = assertActiveLease(db, token, timestamp)
    assertNextMatchingCursor(db, row, failedCursor)
    const attempt = row.retry_cursor === failedCursor ? row.retry_attempts + 1 : 1
    if (attempt < row.retry_max_attempts) {
      const delayMs = retryDelay(row, attempt)
      const retryAt = timestamp + delayMs
      if (!Number.isSafeInteger(retryAt)) throw new TypeError('retry timestamp is out of range')
      const result = db.prepare(`
        UPDATE agent_event_subscriptions
        SET retry_cursor = ?, retry_attempts = ?, retry_not_before = ?, updated_at = ?
        WHERE subscription_key = ? AND status = 'active'
          AND scanned_cursor = ? AND lease_owner = ? AND lease_generation = ?
          AND lease_expires_at > ?
      `).run(
        failedCursor,
        attempt,
        retryAt,
        timestamp,
        token.subscriptionKey,
        row.scanned_cursor,
        token.owner,
        token.generation,
        timestamp,
      )
      if (result.changes !== 1) {
        throw subscriptionError(
          'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
          'durable subscription failure was fenced',
        )
      }
      return Object.freeze({
        deadLettered: false,
        attempt,
        retryAt,
        subscription: mapSubscription(requireSubscription(db, token.subscriptionKey)),
      })
    }

    db.prepare(`
      INSERT INTO agent_event_subscription_dlq (
        subscription_key, cursor, event_type, failure_code, attempts, failed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(token.subscriptionKey, failedCursor, row.event_type, code, attempt, timestamp)
    const result = db.prepare(`
      UPDATE agent_event_subscriptions
      SET scanned_cursor = ?, retry_cursor = NULL, retry_attempts = 0,
          retry_not_before = NULL, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
        AND scanned_cursor = ? AND lease_owner = ? AND lease_generation = ?
        AND lease_expires_at > ?
    `).run(
      failedCursor,
      timestamp,
      token.subscriptionKey,
      row.scanned_cursor,
      token.owner,
      token.generation,
      timestamp,
    )
    if (result.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
        'durable subscription dead-letter transition was fenced',
      )
    }
    return Object.freeze({
      deadLettered: true,
      attempt,
      retryAt: null,
      subscription: mapSubscription(requireSubscription(db, token.subscriptionKey)),
    })
  })
}

export function listAgentEventSubscriptionDeadLetters(subscriptionKey, {
  limit = 100,
  db = getDb(),
} = {}) {
  const key = normalizeSubscriptionKey(subscriptionKey)
  const pageLimit = positiveInteger(limit, 'limit', MAX_SCAN_LIMIT)
  return Object.freeze(db.prepare(`
    SELECT dlq_id, subscription_key, cursor, event_type, failure_code, attempts, failed_at
    FROM agent_event_subscription_dlq
    WHERE subscription_key = ?
    ORDER BY dlq_id ASC LIMIT ?
  `).all(key, pageLimit).map((row) => Object.freeze({
    deadLetterId: row.dlq_id,
    subscriptionKey: row.subscription_key,
    cursor: row.cursor,
    eventType: row.event_type,
    failureCode: row.failure_code,
    attempts: row.attempts,
    failedAt: row.failed_at,
  })))
}
