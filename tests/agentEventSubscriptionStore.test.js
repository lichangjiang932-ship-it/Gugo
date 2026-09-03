import assert from 'node:assert/strict'
import test from 'node:test'

import Database from 'better-sqlite3'

import { migrateToV113 } from '../server/migrations/v113AgentEventOutbox.js'
import { migrateToV114 } from '../server/migrations/v114AgentEventSubscriptions.js'
import { enqueueAgentEventOutboxInDb } from '../server/services/agentEventOutboxStore.js'
import {
  AGENT_EVENT_DURABLE_SUBSCRIPTION_CONTRACT_VERSION,
  acknowledgeAgentEventSubscription,
  acquireAgentEventSubscriptionLease,
  buildAgentEventSubscriptionKey,
  deleteAgentEventSubscription,
  disableAgentEventSubscription,
  enableAgentEventSubscription,
  ensureAgentEventSubscription,
  failAgentEventSubscription,
  getAgentEventRetentionWatermark,
  getAgentEventSubscription,
  listAgentEventSubscriptionDeadLetters,
  scanAgentEventSubscription,
  settleDeletedUserAgentEventRetriesInTransaction,
  truncateAgentEventOutboxToSafeWatermark,
} from '../server/services/agentEventSubscriptionStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'

const BASE_BINDING = Object.freeze({
  publisherId: 'publisher-a',
  publisherKeyId: `sha256-${'a'.repeat(64)}`,
  packageDigest: `sha256-${'c'.repeat(64)}`,
  publicationDigest: `sha256-${'d'.repeat(64)}`,
  releaseId: 'release-a',
  releaseContentDigest: `sha256-${'b'.repeat(64)}`,
  releaseDigestVersion: 1,
  pluginId: 'plugin-a',
  pluginVersion: '1.0.0',
  subscriptionId: 'consumer-a',
  eventType: 'turn.started',
  contractVersion: AGENT_EVENT_DURABLE_SUBSCRIPTION_CONTRACT_VERSION,
})

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  migrateToV113(db)
  migrateToV114(db)
  db.prepare('INSERT INTO users (id) VALUES (?), (?)').run('tenant-a', 'tenant-b')
  return db
}

function event(id, type = 'turn.started', createdAt = 1_000) {
  return createTurnEvent({
    id,
    sessionId: `session-${id}`,
    turnId: `turn-${id}`,
    sequence: type === 'turn.started' ? 0 : 1,
    type,
    payload: type === 'turn.started' ? {} : { phase: id },
    createdAt,
  })
}

function enqueue(db, id, type = 'turn.started', userId = 'tenant-a') {
  return db.transaction(() => enqueueAgentEventOutboxInDb(db, {
    userId,
    event: event(id, type, 1_000 + id.length),
  }))()
}

function subscribe(db, overrides = {}) {
  return ensureAgentEventSubscription({
    ...BASE_BINDING,
    ...overrides,
    now: 100,
    db,
  })
}

function lease(db, subscriptionKey, {
  owner = 'worker-a',
  now = 1_000,
  leaseDurationMs = 10_000,
} = {}) {
  return acquireAgentEventSubscriptionLease(subscriptionKey, {
    owner,
    now,
    leaseDurationMs,
    db,
  })
}

test('subscription key binds publisher, release, plugin, local id, event type, and contract v2', () => {
  const db = createDb()
  try {
    const expectedKey = buildAgentEventSubscriptionKey(BASE_BINDING)
    const first = subscribe(db)
    const retry = subscribe(db)

    assert.equal(first.subscriptionKey, expectedKey)
    assert.deepEqual(retry, first)
    assert.equal(first.publisherId, BASE_BINDING.publisherId)
    assert.equal(first.publisherKeyId, BASE_BINDING.publisherKeyId)
    assert.equal(first.packageDigest, BASE_BINDING.packageDigest)
    assert.equal(first.publicationDigest, BASE_BINDING.publicationDigest)
    assert.equal(first.releaseId, BASE_BINDING.releaseId)
    assert.equal(first.releaseContentDigest, BASE_BINDING.releaseContentDigest)
    assert.equal(first.releaseDigestVersion, BASE_BINDING.releaseDigestVersion)
    assert.equal(first.pluginId, BASE_BINDING.pluginId)
    assert.equal(first.pluginVersion, BASE_BINDING.pluginVersion)
    assert.equal(first.subscriptionId, BASE_BINDING.subscriptionId)
    assert.equal(first.eventType, BASE_BINDING.eventType)
    assert.equal(first.contractVersion, 2)
    assert.equal(first.ackedCursor, 0)
    assert.equal(first.scannedCursor, 0)
    assert.equal(first.streamEpoch, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_subscriptions').get().count, 1)

    assert.notEqual(
      buildAgentEventSubscriptionKey({ ...BASE_BINDING, pluginVersion: '2.0.0' }),
      expectedKey,
    )
    assert.throws(
      () => subscribe(db, { contractVersion: 1 }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_VERSION_UNSUPPORTED',
    )
    assert.throws(
      () => subscribe(db, { eventType: 'unknown.event' }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_EVENT_UNSUPPORTED',
    )
  } finally {
    db.close()
  }
})

test('exclusive leases use monotonic fencing across same-owner renewal and expired takeover', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db)
    const stored = enqueue(db, 'lease-event')
    const first = lease(db, subscription.subscriptionKey, { now: 1_000, leaseDurationMs: 100 })
    assert.equal(first.generation, 1)
    assert.equal(lease(db, subscription.subscriptionKey, {
      owner: 'worker-b',
      now: 1_050,
      leaseDurationMs: 100,
    }), null)

    const second = lease(db, subscription.subscriptionKey, { now: 1_060, leaseDurationMs: 100 })
    assert.equal(second.generation, 2)
    assert.throws(
      () => scanAgentEventSubscription(first, { now: 1_061, db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
    )

    const takeover = lease(db, subscription.subscriptionKey, {
      owner: 'worker-b',
      now: 1_161,
      leaseDurationMs: 200,
    })
    assert.equal(takeover.generation, 3)
    assert.throws(
      () => acknowledgeAgentEventSubscription(second, { cursor: stored.cursor, now: 1_162, db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
    )
    assert.throws(
      () => failAgentEventSubscription(second, { cursor: stored.cursor, now: 1_162, db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
    )

    const work = scanAgentEventSubscription(takeover, { now: 1_162, db })
    assert.equal(work.entry.cursor, stored.cursor)
    const acknowledged = acknowledgeAgentEventSubscription(takeover, {
      cursor: stored.cursor,
      now: 1_163,
      db,
    })
    assert.equal(acknowledged.ackedCursor, stored.cursor)
    assert.equal(acknowledged.scannedCursor, stored.cursor)
  } finally {
    db.close()
  }
})

test('scan advances over filtered events but leaves the matching event pending for fenced ACK', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db)
    const filteredBefore = enqueue(db, 'filtered-before', 'turn.progress')
    const matching = enqueue(db, 'matching')
    const filteredAfter = enqueue(db, 'filtered-after', 'turn.progress')
    const token = lease(db, subscription.subscriptionKey)

    const first = scanAgentEventSubscription(token, { now: 1_001, limit: 10, db })
    assert.equal(first.entry.cursor, matching.cursor)
    assert.equal(first.scannedThrough, filteredBefore.cursor)
    assert.equal(first.subscription.ackedCursor, 0)

    const acknowledged = acknowledgeAgentEventSubscription(token, {
      cursor: matching.cursor,
      now: 1_002,
      db,
    })
    assert.equal(acknowledged.ackedCursor, matching.cursor)
    assert.equal(acknowledged.scannedCursor, matching.cursor)

    const empty = scanAgentEventSubscription(token, { now: 1_003, limit: 10, db })
    assert.equal(empty.entry, null)
    assert.equal(empty.scannedThrough, filteredAfter.cursor)
    assert.equal(empty.subscription.ackedCursor, matching.cursor)
  } finally {
    db.close()
  }
})

test('bounded exponential retries atomically dead-letter and advance only the scanned cursor', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db, {
      retryMaxAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 150,
    })
    const first = enqueue(db, 'retry-first')
    const second = enqueue(db, 'retry-second')
    const token = lease(db, subscription.subscriptionKey, {
      now: 1_000,
      leaseDurationMs: 5_000,
    })

    assert.equal(scanAgentEventSubscription(token, { now: 1_001, db }).entry.cursor, first.cursor)
    const failure1 = failAgentEventSubscription(token, {
      cursor: first.cursor,
      failureCode: 'PLUGIN_TIMEOUT',
      now: 1_010,
      db,
    })
    assert.deepEqual(
      { deadLettered: failure1.deadLettered, attempt: failure1.attempt, retryAt: failure1.retryAt },
      { deadLettered: false, attempt: 1, retryAt: 1_110 },
    )
    const waiting = scanAgentEventSubscription(token, { now: 1_109, db })
    assert.equal(waiting.entry, null)
    assert.equal(waiting.retryAt, 1_110)

    assert.equal(scanAgentEventSubscription(token, { now: 1_110, db }).entry.cursor, first.cursor)
    const failure2 = failAgentEventSubscription(token, {
      cursor: first.cursor,
      now: 1_110,
      db,
    })
    assert.equal(failure2.attempt, 2)
    assert.equal(failure2.retryAt, 1_260)

    assert.equal(scanAgentEventSubscription(token, { now: 1_260, db }).entry.cursor, first.cursor)
    const failure3 = failAgentEventSubscription(token, {
      cursor: first.cursor,
      failureCode: 'PLUGIN_TIMEOUT',
      now: 1_260,
      db,
    })
    assert.equal(failure3.deadLettered, true)
    assert.equal(failure3.attempt, 3)
    assert.equal(failure3.subscription.ackedCursor, 0)
    assert.equal(failure3.subscription.scannedCursor, first.cursor)
    assert.equal(failure3.subscription.retryCursor, null)

    assert.deepEqual(listAgentEventSubscriptionDeadLetters(subscription.subscriptionKey, { db }), [{
      deadLetterId: 1,
      subscriptionKey: subscription.subscriptionKey,
      cursor: first.cursor,
      eventType: 'turn.started',
      failureCode: 'PLUGIN_TIMEOUT',
      attempts: 3,
      failedAt: 1_260,
    }])
    assert.equal(scanAgentEventSubscription(token, { now: 1_261, db }).entry.cursor, second.cursor)
  } finally {
    db.close()
  }
})

test('DLQ insertion and cursor advancement roll back together', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db, { retryMaxAttempts: 1 })
    const stored = enqueue(db, 'dlq-rollback')
    const token = lease(db, subscription.subscriptionKey)
    scanAgentEventSubscription(token, { now: 1_001, db })
    db.exec(`
      CREATE TRIGGER reject_subscription_dlq_advance
      BEFORE UPDATE OF scanned_cursor ON agent_event_subscriptions
      WHEN NEW.scanned_cursor = ${stored.cursor}
      BEGIN
        SELECT RAISE(ABORT, 'reject DLQ cursor advance');
      END;
    `)

    assert.throws(
      () => failAgentEventSubscription(token, { cursor: stored.cursor, now: 1_002, db }),
      /reject DLQ cursor advance/u,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_subscription_dlq').get().count, 0)
    assert.equal(getAgentEventSubscription(subscription.subscriptionKey, { db }).scannedCursor, 0)
  } finally {
    db.close()
  }
})

test('user clear settlement dead-letters active and disabled retries without blocking another user', () => {
  const db = createDb()
  try {
    const active = subscribe(db, { retryMaxAttempts: 3 })
    const disabled = subscribe(db, {
      subscriptionId: 'consumer-disabled',
      retryMaxAttempts: 3,
    })
    const removed = enqueue(db, 'deleted-user-private-payload', 'turn.started', 'tenant-a')
    const preserved = enqueue(db, 'preserved-user-event', 'turn.started', 'tenant-b')
    const activeLease = lease(db, active.subscriptionKey, { owner: 'worker-active' })
    const disabledLease = lease(db, disabled.subscriptionKey, { owner: 'worker-disabled' })

    assert.equal(scanAgentEventSubscription(activeLease, { now: 1_001, db }).entry.cursor, removed.cursor)
    assert.equal(scanAgentEventSubscription(disabledLease, { now: 1_001, db }).entry.cursor, removed.cursor)
    failAgentEventSubscription(activeLease, { cursor: removed.cursor, now: 1_002, db })
    failAgentEventSubscription(disabledLease, { cursor: removed.cursor, now: 1_002, db })
    disableAgentEventSubscription(disabled.subscriptionKey, { now: 1_003, db })

    assert.throws(
      () => settleDeletedUserAgentEventRetriesInTransaction({ userId: 'tenant-a', db }),
      (error) => error?.code === 'AGENT_EVENT_RETRY_SETTLEMENT_TRANSACTION_REQUIRED',
    )
    const settled = db.transaction(() => {
      const count = settleDeletedUserAgentEventRetriesInTransaction({
        userId: 'tenant-a',
        now: 1_004,
        db,
      })
      db.prepare('DELETE FROM agent_event_outbox WHERE user_id = ?').run('tenant-a')
      return count
    }).immediate()
    assert.equal(settled, 2)

    for (const subscription of [active, disabled]) {
      const current = getAgentEventSubscription(subscription.subscriptionKey, { db })
      assert.equal(current.scannedCursor, removed.cursor)
      assert.equal(current.retryCursor, null)
      const deadLetters = listAgentEventSubscriptionDeadLetters(subscription.subscriptionKey, { db })
      assert.deepEqual(deadLetters.map((entry) => ({
        cursor: entry.cursor,
        eventType: entry.eventType,
        failureCode: entry.failureCode,
        attempts: entry.attempts,
      })), [{
        cursor: removed.cursor,
        eventType: 'turn.started',
        failureCode: 'AGENT_EVENT_SOURCE_DELETED',
        attempts: 1,
      }])
      assert.equal(JSON.stringify(deadLetters).includes('tenant-a'), false)
      assert.equal(JSON.stringify(deadLetters).includes('deleted-user-private-payload'), false)
    }

    assert.throws(
      () => scanAgentEventSubscription(activeLease, { now: 1_005, db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
    )
    const resumed = lease(db, active.subscriptionKey, {
      owner: 'worker-resumed',
      now: 1_006,
    })
    assert.equal(scanAgentEventSubscription(resumed, { now: 1_007, db }).entry.cursor, preserved.cursor)
    acknowledgeAgentEventSubscription(resumed, { cursor: preserved.cursor, now: 1_008, db })
    const trimmed = truncateAgentEventOutboxToSafeWatermark({ now: 1_009, db })
    assert.equal(trimmed.truncated, true)
    assert.equal(trimmed.watermark, preserved.cursor)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox').get().count, 0)
  } finally {
    db.close()
  }
})

test('deleted-user retry settlement rolls back DLQ, cursor state, and outbox deletion together', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db, { retryMaxAttempts: 3 })
    const removed = enqueue(db, 'rollback-private-event')
    const token = lease(db, subscription.subscriptionKey)
    scanAgentEventSubscription(token, { now: 1_001, db })
    failAgentEventSubscription(token, { cursor: removed.cursor, now: 1_002, db })
    db.exec(`
      CREATE TRIGGER reject_deleted_user_retry_settlement
      BEFORE UPDATE ON agent_event_subscriptions
      WHEN OLD.subscription_key = '${subscription.subscriptionKey}'
        AND OLD.retry_cursor IS NOT NULL
        AND NEW.retry_cursor IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'reject deleted-user retry settlement');
      END;
    `)

    assert.throws(
      () => db.transaction(() => {
        settleDeletedUserAgentEventRetriesInTransaction({
          userId: 'tenant-a',
          now: 1_003,
          db,
        })
        db.prepare('DELETE FROM agent_event_outbox WHERE user_id = ?').run('tenant-a')
      }).immediate(),
      /reject deleted-user retry settlement/u,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_subscription_dlq').get().count, 0)
    assert.ok(db.prepare('SELECT 1 FROM agent_event_outbox WHERE cursor = ?').get(removed.cursor))
    const current = getAgentEventSubscription(subscription.subscriptionKey, { db })
    assert.equal(current.scannedCursor, 0)
    assert.equal(current.retryCursor, removed.cursor)
    assert.equal(current.retryAttempts, 1)
  } finally {
    db.close()
  }
})

test('disable fences the active lease and delete requires the disabled state', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db)
    const token = lease(db, subscription.subscriptionKey)
    assert.throws(
      () => deleteAgentEventSubscription(subscription.subscriptionKey, { db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_DELETE_REQUIRES_DISABLED',
    )

    const disabled = disableAgentEventSubscription(subscription.subscriptionKey, { now: 1_001, db })
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.leaseOwner, null)
    assert.equal(disabled.leaseGeneration, token.generation + 1)
    assert.equal(lease(db, subscription.subscriptionKey, { now: 1_002 }), null)
    assert.throws(
      () => scanAgentEventSubscription(token, { now: 1_002, db }),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED',
    )
    assert.equal(deleteAgentEventSubscription(subscription.subscriptionKey, { db }), true)
    assert.equal(getAgentEventSubscription(subscription.subscriptionKey, { db }), null)
  } finally {
    db.close()
  }
})

test('retention truncates through the outbox tail when no subscriptions exist', () => {
  const db = createDb()
  try {
    enqueue(db, 'unobserved-started')
    const tail = enqueue(db, 'unobserved-progress', 'turn.progress')

    const watermark = getAgentEventRetentionWatermark({ db })
    assert.equal(watermark.allowed, true)
    assert.equal(watermark.watermark, tail.cursor)
    assert.equal(watermark.blockingSubscriptions, 0)

    const trimmed = truncateAgentEventOutboxToSafeWatermark({ now: 500, db })
    assert.equal(trimmed.truncated, true)
    assert.equal(trimmed.deleted, 2)
    assert.deepEqual(trimmed.stream, { epoch: 2, truncatedThrough: tail.cursor })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox').get().count, 0)

    const empty = truncateAgentEventOutboxToSafeWatermark({ now: 501, db })
    assert.equal(empty.truncated, false)
    assert.equal(empty.reason, 'at_watermark')
  } finally {
    db.close()
  }
})

test('retention ignores disabled subscriptions and leaves them on their prior epoch', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db)
    disableAgentEventSubscription(subscription.subscriptionKey, { now: 200, db })
    const tail = enqueue(db, 'disabled-consumer-event')

    const trimmed = truncateAgentEventOutboxToSafeWatermark({ now: 500, db })
    assert.equal(trimmed.truncated, true)
    assert.equal(trimmed.watermark, tail.cursor)
    assert.deepEqual(trimmed.stream, { epoch: 2, truncatedThrough: tail.cursor })
    assert.deepEqual(db.prepare(`
      SELECT status, stream_epoch FROM agent_event_subscriptions
      WHERE subscription_key = ?
    `).get(subscription.subscriptionKey), { status: 'disabled', stream_epoch: 1 })
  } finally {
    db.close()
  }
})

test('reset keeps disabled subscription cursors monotonic when the retained tail moves backward', () => {
  const db = createDb()
  try {
    const retainedTail = enqueue(db, 'retained-lower-cursor', 'turn.started', 'tenant-b')
    const removedHighCursor = enqueue(db, 'removed-higher-cursor')
    const subscription = subscribe(db)
    const token = lease(db, subscription.subscriptionKey)

    assert.equal(scanAgentEventSubscription(token, { now: 1_001, db }).entry.cursor, retainedTail.cursor)
    acknowledgeAgentEventSubscription(token, { cursor: retainedTail.cursor, now: 1_002, db })
    assert.equal(
      scanAgentEventSubscription(token, { now: 1_003, db }).entry.cursor,
      removedHighCursor.cursor,
    )
    acknowledgeAgentEventSubscription(token, { cursor: removedHighCursor.cursor, now: 1_004, db })
    disableAgentEventSubscription(subscription.subscriptionKey, { now: 1_005, db })

    db.prepare('DELETE FROM users WHERE id = ?').run('tenant-a')
    const trimmed = truncateAgentEventOutboxToSafeWatermark({ now: 1_006, db })
    assert.deepEqual(trimmed.stream, { epoch: 2, truncatedThrough: retainedTail.cursor })
    assert.ok(removedHighCursor.cursor > trimmed.stream.truncatedThrough)

    const enabled = enableAgentEventSubscription(subscription.subscriptionKey, {
      now: 1_007,
      resetToCurrent: true,
      db,
    })
    assert.equal(enabled.status, 'active')
    assert.equal(enabled.streamEpoch, 2)
    assert.equal(enabled.ackedCursor, removedHighCursor.cursor)
    assert.equal(enabled.scannedCursor, removedHighCursor.cursor)

    const resumedToken = lease(db, subscription.subscriptionKey, {
      owner: 'worker-b',
      now: 1_008,
    })
    assert.equal(scanAgentEventSubscription(resumedToken, { now: 1_009, db }).entry, null)
    const next = enqueue(db, 'post-reset-event', 'turn.started', 'tenant-b')
    assert.equal(
      scanAgentEventSubscription(resumedToken, { now: 1_010, db }).entry.cursor,
      next.cursor,
    )
  } finally {
    db.close()
  }
})

test('safe watermark is the minimum active scanned cursor and truncation is one IMMEDIATE transaction', () => {
  const db = createDb()
  try {
    const c1 = enqueue(db, 'trim-started-1')
    const c2 = enqueue(db, 'trim-progress-1', 'turn.progress')
    const c3 = enqueue(db, 'trim-started-2')
    const c4 = enqueue(db, 'trim-progress-2', 'turn.progress')

    const started = subscribe(db)
    const progress = subscribe(db, {
      subscriptionId: 'consumer-progress',
      eventType: 'turn.progress',
    })
    const startedLease = lease(db, started.subscriptionKey)
    const progressLease = lease(db, progress.subscriptionKey, { owner: 'worker-b' })

    assert.equal(scanAgentEventSubscription(startedLease, { now: 1_001, db }).entry.cursor, c1.cursor)
    acknowledgeAgentEventSubscription(startedLease, { cursor: c1.cursor, now: 1_002, db })
    assert.equal(scanAgentEventSubscription(startedLease, { now: 1_003, db }).entry.cursor, c3.cursor)
    assert.equal(scanAgentEventSubscription(progressLease, { now: 1_001, db }).entry.cursor, c2.cursor)
    acknowledgeAgentEventSubscription(progressLease, { cursor: c2.cursor, now: 1_002, db })

    const watermark = getAgentEventRetentionWatermark({ db })
    assert.equal(watermark.allowed, true)
    assert.equal(watermark.watermark, c2.cursor)
    const trimmed = truncateAgentEventOutboxToSafeWatermark({ now: 1_004, db })
    assert.equal(trimmed.truncated, true)
    assert.equal(trimmed.deleted, 2)
    assert.deepEqual(trimmed.stream, { epoch: 2, truncatedThrough: c2.cursor })
    assert.deepEqual(
      db.prepare('SELECT cursor FROM agent_event_outbox ORDER BY cursor').all(),
      [{ cursor: c3.cursor }, { cursor: c4.cursor }],
    )
    assert.deepEqual(
      db.prepare('SELECT DISTINCT stream_epoch FROM agent_event_subscriptions').all(),
      [{ stream_epoch: 2 }],
    )

    acknowledgeAgentEventSubscription(startedLease, { cursor: c3.cursor, now: 1_005, db })
    assert.equal(scanAgentEventSubscription(progressLease, { now: 1_005, db }).entry.cursor, c4.cursor)
    acknowledgeAgentEventSubscription(progressLease, { cursor: c4.cursor, now: 1_006, db })
    db.exec(`
      CREATE TRIGGER reject_agent_event_truncation
      BEFORE DELETE ON agent_event_outbox
      WHEN OLD.cursor <= ${c3.cursor}
      BEGIN
        SELECT RAISE(ABORT, 'reject Agent Event truncation');
      END;
    `)
    assert.throws(
      () => truncateAgentEventOutboxToSafeWatermark({ now: 1_007, db }),
      /reject Agent Event truncation/u,
    )
    assert.deepEqual(db.prepare(`
      SELECT epoch, truncated_through FROM agent_event_stream_metadata
      WHERE stream_key = 'global'
    `).get(), { epoch: 2, truncated_through: c2.cursor })
    assert.deepEqual(
      db.prepare('SELECT DISTINCT stream_epoch FROM agent_event_subscriptions').all(),
      [{ stream_epoch: 2 }],
    )
    assert.ok(db.prepare('SELECT 1 FROM agent_event_outbox WHERE cursor = ?').get(c3.cursor))
  } finally {
    db.close()
  }
})

test('unknown subscription state prohibits retention and DLQ does not duplicate user payloads', () => {
  const db = createDb()
  try {
    const subscription = subscribe(db, { retryMaxAttempts: 1 })
    const stored = enqueue(db, 'governance-event')
    const token = lease(db, subscription.subscriptionKey)
    scanAgentEventSubscription(token, { now: 1_001, db })
    failAgentEventSubscription(token, { cursor: stored.cursor, now: 1_002, db })

    const dlqColumns = new Set(
      db.prepare('SELECT name FROM pragma_table_info(?)').all('agent_event_subscription_dlq')
        .map((row) => row.name),
    )
    assert.equal(dlqColumns.has('user_id'), false)
    assert.equal(dlqColumns.has('envelope_json'), false)
    assert.equal(JSON.stringify(listAgentEventSubscriptionDeadLetters(
      subscription.subscriptionKey,
      { db },
    )).includes('tenant-a'), false)
    db.prepare('DELETE FROM users WHERE id = ?').run('tenant-a')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_outbox').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_event_subscription_dlq').get().count, 1)

    db.pragma('ignore_check_constraints = ON')
    db.prepare(`
      UPDATE agent_event_subscriptions SET status = 'unknown' WHERE subscription_key = ?
    `).run(subscription.subscriptionKey)
    db.pragma('ignore_check_constraints = OFF')
    assert.equal(getAgentEventRetentionWatermark({ db }).reason, 'state_unknown')
    assert.equal(truncateAgentEventOutboxToSafeWatermark({ now: 2_000, db }).reason, 'state_unknown')
  } finally {
    db.close()
  }
})
