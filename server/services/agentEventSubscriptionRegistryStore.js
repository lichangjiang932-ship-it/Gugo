import { createHash } from 'node:crypto'

import { TURN_EVENT_TYPES } from '../../shared/turnEvents.js'
import { getDb } from '../db.js'

export const AGENT_EVENT_DURABLE_SUBSCRIPTION_CONTRACT_VERSION = 2
export const DEFAULT_AGENT_EVENT_RETRY_MAX_ATTEMPTS = 5
export const DEFAULT_AGENT_EVENT_RETRY_BASE_DELAY_MS = 1_000
export const DEFAULT_AGENT_EVENT_RETRY_MAX_DELAY_MS = 300_000

const MAX_LEASE_DURATION_MS = 3_600_000
const MAX_RETRY_ATTEMPTS = 100
const MAX_RETRY_DELAY_MS = 604_800_000
const EVENT_TYPE_SET = new Set(TURN_EVENT_TYPES)
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const CONTENT_DIGEST_RE = /^sha256-[a-f0-9]{64}$/u
const SUBSCRIPTION_KEY_RE = /^[a-f0-9]{64}$/u

export function subscriptionError(code, message, details = undefined) {
  const error = Object.assign(new Error(message), {
    name: 'AgentEventSubscriptionError',
    code,
    retryable: false,
  })
  if (details !== undefined) error.details = Object.freeze({ ...details })
  return error
}

function requiredString(value, field, maxLength, pattern = null) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maxLength
    || (pattern && !pattern.test(normalized))) {
    throw new TypeError(`${field} is invalid`)
  }
  return normalized
}

export function nonNegativeInteger(value, field) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return normalized
}

export function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return normalized
}

function normalizeBinding(input = {}) {
  const contractVersion = positiveInteger(input.contractVersion, 'contractVersion')
  if (contractVersion !== AGENT_EVENT_DURABLE_SUBSCRIPTION_CONTRACT_VERSION) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_VERSION_UNSUPPORTED',
      `durable Agent Event subscriptions require contract version ${AGENT_EVENT_DURABLE_SUBSCRIPTION_CONTRACT_VERSION}`,
    )
  }
  const eventType = requiredString(input.eventType, 'eventType', 128)
  if (!EVENT_TYPE_SET.has(eventType)) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_EVENT_UNSUPPORTED',
      `unsupported Agent Event type ${eventType}`,
    )
  }
  return Object.freeze({
    publisherId: requiredString(input.publisherId, 'publisherId', 128, LOCAL_ID_RE),
    publisherKeyId: requiredString(input.publisherKeyId, 'publisherKeyId', 256),
    packageDigest: requiredString(
      input.packageDigest,
      'packageDigest',
      71,
      CONTENT_DIGEST_RE,
    ).toLowerCase(),
    publicationDigest: requiredString(
      input.publicationDigest,
      'publicationDigest',
      71,
      CONTENT_DIGEST_RE,
    ).toLowerCase(),
    releaseId: requiredString(input.releaseId, 'releaseId', 128, LOCAL_ID_RE),
    releaseContentDigest: requiredString(
      input.releaseContentDigest,
      'releaseContentDigest',
      71,
      CONTENT_DIGEST_RE,
    ).toLowerCase(),
    releaseDigestVersion: positiveInteger(input.releaseDigestVersion, 'releaseDigestVersion'),
    pluginId: requiredString(input.pluginId, 'pluginId', 80, PLUGIN_ID_RE),
    pluginVersion: requiredString(input.pluginVersion, 'pluginVersion', 128),
    subscriptionId: requiredString(input.subscriptionId, 'subscriptionId', 128, LOCAL_ID_RE),
    eventType,
    contractVersion,
  })
}

function canonicalBinding(binding) {
  return JSON.stringify([
    'gugo-agent-event-durable-subscription',
    binding.contractVersion,
    binding.publisherId,
    binding.publisherKeyId,
    binding.packageDigest,
    binding.publicationDigest,
    binding.releaseId,
    binding.releaseContentDigest,
    binding.releaseDigestVersion,
    binding.pluginId,
    binding.pluginVersion,
    binding.subscriptionId,
    binding.eventType,
  ])
}

export function buildAgentEventSubscriptionKey(input) {
  const binding = normalizeBinding(input)
  return createHash('sha256').update(canonicalBinding(binding), 'utf8').digest('hex')
}

export function normalizeSubscriptionKey(value) {
  return requiredString(value, 'subscriptionKey', 64, SUBSCRIPTION_KEY_RE).toLowerCase()
}

function normalizeRetryPolicy({
  retryMaxAttempts = DEFAULT_AGENT_EVENT_RETRY_MAX_ATTEMPTS,
  retryBaseDelayMs = DEFAULT_AGENT_EVENT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs = DEFAULT_AGENT_EVENT_RETRY_MAX_DELAY_MS,
} = {}) {
  const maxAttempts = positiveInteger(retryMaxAttempts, 'retryMaxAttempts', MAX_RETRY_ATTEMPTS)
  const baseDelayMs = positiveInteger(retryBaseDelayMs, 'retryBaseDelayMs', MAX_RETRY_DELAY_MS)
  const maxDelayMs = positiveInteger(retryMaxDelayMs, 'retryMaxDelayMs', MAX_RETRY_DELAY_MS)
  if (baseDelayMs > maxDelayMs) {
    throw new TypeError('retryBaseDelayMs must not exceed retryMaxDelayMs')
  }
  return Object.freeze({ maxAttempts, baseDelayMs, maxDelayMs })
}

export function mapSubscription(row) {
  if (!row) return null
  return Object.freeze({
    subscriptionKey: row.subscription_key,
    publisherId: row.publisher_id,
    publisherKeyId: row.publisher_key_id,
    packageDigest: row.package_digest,
    publicationDigest: row.publication_digest,
    releaseId: row.release_id,
    releaseContentDigest: row.release_content_digest,
    releaseDigestVersion: row.release_digest_version,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    contractVersion: row.contract_version,
    status: row.status,
    ackedCursor: row.acked_cursor,
    scannedCursor: row.scanned_cursor,
    streamEpoch: row.stream_epoch,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    retryCursor: row.retry_cursor,
    retryAttempts: row.retry_attempts,
    retryNotBefore: row.retry_not_before,
    retryMaxAttempts: row.retry_max_attempts,
    retryBaseDelayMs: row.retry_base_delay_ms,
    retryMaxDelayMs: row.retry_max_delay_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function readSubscription(db, subscriptionKey) {
  return db.prepare(`
    SELECT * FROM agent_event_subscriptions WHERE subscription_key = ?
  `).get(subscriptionKey)
}

export function readStreamMetadata(db) {
  const rows = db.prepare(`
    SELECT stream_key, epoch, truncated_through
    FROM agent_event_stream_metadata ORDER BY stream_key
  `).all()
  const row = rows[0]
  if (rows.length !== 1
    || row?.stream_key !== 'global'
    || !Number.isSafeInteger(row.epoch)
    || row.epoch < 1
    || !Number.isSafeInteger(row.truncated_through)
    || row.truncated_through < 0) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
      'Agent Event stream metadata is missing or invalid',
    )
  }
  return Object.freeze({ epoch: row.epoch, truncatedThrough: row.truncated_through })
}

export function inImmediateTransaction(db, operation) {
  return db.inTransaction ? operation() : db.transaction(operation).immediate()
}

function assertBindingMatches(row, binding, subscriptionKey) {
  const storedBinding = normalizeBinding({
    publisherId: row.publisher_id,
    publisherKeyId: row.publisher_key_id,
    packageDigest: row.package_digest,
    publicationDigest: row.publication_digest,
    releaseId: row.release_id,
    releaseContentDigest: row.release_content_digest,
    releaseDigestVersion: row.release_digest_version,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    contractVersion: row.contract_version,
  })
  const storedKey = createHash('sha256')
    .update(canonicalBinding(storedBinding), 'utf8')
    .digest('hex')
  if (storedKey !== subscriptionKey || canonicalBinding(storedBinding) !== canonicalBinding(binding)) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_IDENTITY_CONFLICT',
      'subscription key is already bound to another immutable identity',
    )
  }
}

export function ensureAgentEventSubscription({
  now = Date.now(),
  db = getDb(),
  ...input
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const timestamp = nonNegativeInteger(now, 'now')
  const binding = normalizeBinding(input)
  const policy = normalizeRetryPolicy(input)
  const subscriptionKey = buildAgentEventSubscriptionKey(binding)
  return inImmediateTransaction(db, () => {
    const stream = readStreamMetadata(db)
    db.prepare(`
      INSERT INTO agent_event_subscriptions (
        subscription_key, publisher_id, publisher_key_id, package_digest,
        publication_digest, release_id,
        release_content_digest, release_digest_version, plugin_id, plugin_version,
        subscription_id, event_type, contract_version, status,
        acked_cursor, scanned_cursor, stream_epoch,
        lease_owner, lease_generation, lease_expires_at,
        retry_cursor, retry_attempts, retry_not_before,
        retry_max_attempts, retry_base_delay_ms, retry_max_delay_ms,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
        ?, ?, ?, NULL, 0, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?
      ) ON CONFLICT(subscription_key) DO NOTHING
    `).run(
      subscriptionKey,
      binding.publisherId,
      binding.publisherKeyId,
      binding.packageDigest,
      binding.publicationDigest,
      binding.releaseId,
      binding.releaseContentDigest,
      binding.releaseDigestVersion,
      binding.pluginId,
      binding.pluginVersion,
      binding.subscriptionId,
      binding.eventType,
      binding.contractVersion,
      stream.truncatedThrough,
      stream.truncatedThrough,
      stream.epoch,
      policy.maxAttempts,
      policy.baseDelayMs,
      policy.maxDelayMs,
      timestamp,
      timestamp,
    )
    const row = readSubscription(db, subscriptionKey)
    if (!row) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'durable subscription insert did not produce a row',
      )
    }
    assertBindingMatches(row, binding, subscriptionKey)
    return mapSubscription(row)
  })
}

export function getAgentEventSubscription(subscriptionKey, { db = getDb() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  return mapSubscription(readSubscription(db, normalizeSubscriptionKey(subscriptionKey)))
}

export function listAgentEventSubscriptions({ db = getDb() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  return Object.freeze(db.prepare(`
    SELECT * FROM agent_event_subscriptions
    ORDER BY subscription_key
  `).all().map(mapSubscription))
}

export function requireSubscription(db, subscriptionKey) {
  const row = readSubscription(db, subscriptionKey)
  if (!row) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_NOT_FOUND',
      `durable subscription ${subscriptionKey} was not found`,
    )
  }
  return row
}

export function disableAgentEventSubscription(subscriptionKey, {
  now = Date.now(),
  db = getDb(),
} = {}) {
  const key = normalizeSubscriptionKey(subscriptionKey)
  const timestamp = nonNegativeInteger(now, 'now')
  return inImmediateTransaction(db, () => {
    const row = requireSubscription(db, key)
    if (row.status === 'disabled') return mapSubscription(row)
    db.prepare(`
      UPDATE agent_event_subscriptions
      SET status = 'disabled', lease_owner = NULL, lease_expires_at = NULL,
          lease_generation = lease_generation + 1, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
    `).run(timestamp, key)
    return mapSubscription(requireSubscription(db, key))
  })
}

export function enableAgentEventSubscription(subscriptionKey, {
  now = Date.now(),
  resetToCurrent = false,
  db = getDb(),
} = {}) {
  const key = normalizeSubscriptionKey(subscriptionKey)
  const timestamp = nonNegativeInteger(now, 'now')
  return inImmediateTransaction(db, () => {
    const row = requireSubscription(db, key)
    if (row.status === 'active') return mapSubscription(row)
    const stream = readStreamMetadata(db)
    const fellBehind = row.scanned_cursor < stream.truncatedThrough
      || row.stream_epoch !== stream.epoch
    if (fellBehind && resetToCurrent !== true) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_CURSOR_TRUNCATED',
        'disabled subscription must explicitly reset after retained events were truncated',
        { streamEpoch: stream.epoch, truncatedThrough: stream.truncatedThrough },
      )
    }
    const scannedCursor = fellBehind
      ? Math.max(row.scanned_cursor, stream.truncatedThrough)
      : row.scanned_cursor
    const ackedCursor = Math.min(row.acked_cursor, scannedCursor)
    const reset = fellBehind
      ? Object.freeze({
          previousStreamEpoch: row.stream_epoch,
          streamEpoch: stream.epoch,
          truncatedThrough: stream.truncatedThrough,
          previousAckedCursor: row.acked_cursor,
          ackedCursor,
          previousScannedCursor: row.scanned_cursor,
          scannedCursor,
        })
      : null
    db.prepare(`
      UPDATE agent_event_subscriptions
      SET status = 'active', acked_cursor = ?, scanned_cursor = ?, stream_epoch = ?,
          retry_cursor = NULL, retry_attempts = 0, retry_not_before = NULL,
          updated_at = ?
      WHERE subscription_key = ? AND status = 'disabled'
    `).run(ackedCursor, scannedCursor, stream.epoch, timestamp, key)
    const enabled = mapSubscription(requireSubscription(db, key))
    return reset ? Object.freeze({ ...enabled, reset }) : enabled
  })
}

export function deleteAgentEventSubscription(subscriptionKey, { db = getDb() } = {}) {
  const key = normalizeSubscriptionKey(subscriptionKey)
  return inImmediateTransaction(db, () => {
    const row = requireSubscription(db, key)
    if (row.status !== 'disabled') {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_DELETE_REQUIRES_DISABLED',
        'durable subscription must be disabled before deletion',
      )
    }
    return db.prepare(`
      DELETE FROM agent_event_subscriptions
      WHERE subscription_key = ? AND status = 'disabled'
    `).run(key).changes === 1
  })
}

export function normalizeLeaseToken({ subscriptionKey, owner, generation } = {}) {
  return Object.freeze({
    subscriptionKey: normalizeSubscriptionKey(subscriptionKey),
    owner: requiredString(owner, 'owner', 256),
    generation: positiveInteger(generation, 'generation'),
  })
}

export function assertActiveLease(db, token, now) {
  const row = requireSubscription(db, token.subscriptionKey)
  if (row.status !== 'active'
    || row.lease_owner !== token.owner
    || row.lease_generation !== token.generation
    || !Number.isSafeInteger(row.lease_expires_at)
    || row.lease_expires_at <= now) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
      'durable subscription lease is expired or fenced by a newer owner',
    )
  }
  const stream = readStreamMetadata(db)
  if (row.stream_epoch !== stream.epoch || row.scanned_cursor < stream.truncatedThrough) {
    throw subscriptionError(
      'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
      'subscription cursor does not belong to the current Agent Event stream epoch',
    )
  }
  return row
}

export function acquireAgentEventSubscriptionLease(subscriptionKey, {
  owner,
  now = Date.now(),
  leaseDurationMs,
  db = getDb(),
} = {}) {
  const key = normalizeSubscriptionKey(subscriptionKey)
  const leaseOwner = requiredString(owner, 'owner', 256)
  const timestamp = nonNegativeInteger(now, 'now')
  const duration = positiveInteger(leaseDurationMs, 'leaseDurationMs', MAX_LEASE_DURATION_MS)
  const expiresAt = timestamp + duration
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError('lease expiry is out of range')
  return inImmediateTransaction(db, () => {
    const row = requireSubscription(db, key)
    const stream = readStreamMetadata(db)
    if (row.status !== 'active') return null
    if (row.stream_epoch !== stream.epoch || row.scanned_cursor < stream.truncatedThrough) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_STATE_UNKNOWN',
        'subscription cursor does not belong to the current Agent Event stream epoch',
      )
    }
    const result = db.prepare(`
      UPDATE agent_event_subscriptions
      SET lease_owner = ?, lease_generation = lease_generation + 1,
          lease_expires_at = ?, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
        AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
    `).run(leaseOwner, expiresAt, timestamp, key, timestamp, leaseOwner)
    if (result.changes !== 1) return null
    const acquired = requireSubscription(db, key)
    return Object.freeze({
      subscriptionKey: key,
      owner: leaseOwner,
      generation: acquired.lease_generation,
      expiresAt: acquired.lease_expires_at,
    })
  })
}

export function renewAgentEventSubscriptionLease(input, {
  now = Date.now(),
  leaseDurationMs,
  db = getDb(),
} = {}) {
  const token = normalizeLeaseToken(input)
  const timestamp = nonNegativeInteger(now, 'now')
  const duration = positiveInteger(leaseDurationMs, 'leaseDurationMs', MAX_LEASE_DURATION_MS)
  const expiresAt = timestamp + duration
  if (!Number.isSafeInteger(expiresAt)) throw new TypeError('lease expiry is out of range')
  return inImmediateTransaction(db, () => {
    assertActiveLease(db, token, timestamp)
    const result = db.prepare(`
      UPDATE agent_event_subscriptions SET lease_expires_at = ?, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
    `).run(
      expiresAt,
      timestamp,
      token.subscriptionKey,
      token.owner,
      token.generation,
      timestamp,
    )
    if (result.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
        'durable subscription lease was fenced while renewing',
      )
    }
    return Object.freeze({ ...token, expiresAt })
  })
}

export function releaseAgentEventSubscriptionLease(input, {
  now = Date.now(),
  db = getDb(),
} = {}) {
  const token = normalizeLeaseToken(input)
  const timestamp = nonNegativeInteger(now, 'now')
  return inImmediateTransaction(db, () => {
    assertActiveLease(db, token, timestamp)
    const result = db.prepare(`
      UPDATE agent_event_subscriptions
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE subscription_key = ? AND status = 'active'
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
    `).run(
      timestamp,
      token.subscriptionKey,
      token.owner,
      token.generation,
      timestamp,
    )
    if (result.changes !== 1) {
      throw subscriptionError(
        'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
        'durable subscription lease was fenced while releasing',
      )
    }
    return true
  })
}
