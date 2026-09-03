import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import { createDurableAgentEventConsumerHost } from '../server/core/durableAgentEventConsumerHost.js'
import { migrateToV113 } from '../server/migrations/v113AgentEventOutbox.js'
import { migrateToV114 } from '../server/migrations/v114AgentEventSubscriptions.js'
import { migrateToV115 } from '../server/migrations/v115TenantScopedAgentEventSubscriptions.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
import {
  createRuntimePluginDurableIdentity,
} from '../server/plugins/runtimePluginDurableIdentity.js'
import {
  buildRuntimePluginReleaseContentIdentity,
} from '../server/plugins/runtimePluginReleaseIdentity.js'
import { enqueueAgentEventOutboxInDb } from '../server/services/agentEventOutboxStore.js'
import {
  acknowledgeAgentEventSubscription,
  acquireAgentEventSubscriptionLease,
  disableAgentEventSubscription,
  enableAgentEventSubscription,
  ensureAgentEventSubscription,
  failAgentEventSubscription,
  getAgentEventSubscription,
  listAgentEventSubscriptions,
  releaseAgentEventSubscriptionLease,
  renewAgentEventSubscriptionLease,
  scanAgentEventSubscription,
  truncateAgentEventOutboxToSafeWatermark,
} from '../server/services/agentEventSubscriptionStore.js'
import { hydrateStoredRelease } from '../server/services/runtimePluginReleaseSupport.js'
import { createTurnEvent } from '../shared/turnEvents.js'

const PLUGIN_ID = 'durable-agent-event-integration'
const SUBSCRIPTION_ID = 'heartbeat-stream'

function manifest() {
  return {
    id: PLUGIN_ID,
    name: 'Durable Agent Event integration',
    version: '1.0.0',
    contributes: ['agent-event:heartbeat'],
  }
}

function trustedDurableIdentity() {
  const source = 'function transform(input) { return input }'
  const plugin = {
    ...manifest(),
    type: 'transformer',
    entry: 'index.js',
    description: 'Durable Agent Event integration fixture',
    author: 'Fixture publisher',
    license: 'MIT',
    tags: [],
    capabilities: [],
    distribution: {
      sourceKind: 'local-marketplace',
      mutable: false,
      verifiedPackage: true,
      installReceipt: {
        schemaVersion: 2,
        pluginId: PLUGIN_ID,
        pluginVersion: '1.0.0',
        packageDigest: `sha256-${'a'.repeat(64)}`,
        fileCount: 1,
        totalBytes: 128,
        installedAt: 1_000,
        publisherVerified: true,
        sourceKind: 'local-marketplace',
        marketplace: { name: 'fixture-market', displayName: 'Fixture Market' },
        publisher: {
          id: 'fixture-publisher',
          displayName: 'Fixture Publisher',
          keyId: `sha256-${'b'.repeat(64)}`,
        },
        publicationDigest: `sha256-${'c'.repeat(64)}`,
      },
    },
  }
  const raw = {
    releaseId: 'release-durable-agent-event-integration',
    pluginId: PLUGIN_ID,
    sourceDigest: `sha256-${createHash('sha256').update(source).digest('hex')}`,
    source,
    pluginSnapshotJson: JSON.stringify(plugin),
    validationStatus: 'passed',
    healthStatus: 'passed',
    failure: null,
    createdAt: 1_000,
  }
  const contentIdentity = buildRuntimePluginReleaseContentIdentity(raw)
  const release = hydrateStoredRelease({
    ...raw,
    digestVersion: contentIdentity.digestVersion,
    releaseContentDigest: contentIdentity.releaseContentDigest,
  })
  return createRuntimePluginDurableIdentity(release)
}

function createSubscriptionStore(db) {
  return Object.freeze({
    ensureAgentEventSubscription: (definition) => ensureAgentEventSubscription({
      ...definition,
      db,
    }),
    enableAgentEventSubscription: (subscriptionKey, options) => (
      enableAgentEventSubscription(subscriptionKey, { ...options, db })
    ),
    disableAgentEventSubscription: (subscriptionKey, options) => (
      disableAgentEventSubscription(subscriptionKey, { ...options, db })
    ),
    acquireAgentEventSubscriptionLease: (subscriptionKey, options) => (
      acquireAgentEventSubscriptionLease(subscriptionKey, { ...options, db })
    ),
    renewAgentEventSubscriptionLease: (token, options) => (
      renewAgentEventSubscriptionLease(token, { ...options, db })
    ),
    releaseAgentEventSubscriptionLease: (token, options) => (
      releaseAgentEventSubscriptionLease(token, { ...options, db })
    ),
    scanAgentEventSubscription: (token, options) => (
      scanAgentEventSubscription(token, { ...options, db })
    ),
    acknowledgeAgentEventSubscription: (token, options) => (
      acknowledgeAgentEventSubscription(token, { ...options, db })
    ),
    failAgentEventSubscription: (token, options) => (
      failAgentEventSubscription(token, { ...options, db })
    ),
    truncateAgentEventOutboxToSafeWatermark: (options) => (
      truncateAgentEventOutboxToSafeWatermark({ ...options, db })
    ),
  })
}

function createDatabase(file) {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO users (id) VALUES (?)').run('tenant-integration')
  migrateToV113(db)
  migrateToV114(db)
  migrateToV115(db)
  return db
}

function enqueue(db, id, sequence) {
  return db.transaction(() => enqueueAgentEventOutboxInDb(db, {
    userId: 'tenant-integration',
    event: createTurnEvent({
      id,
      sessionId: 'session-integration',
      turnId: `turn-${id}`,
      sequence,
      type: 'heartbeat',
      payload: { at: 1_000 + sequence },
      createdAt: 1_000 + sequence,
    }),
  }))()
}

async function waitFor(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for durable plugin delivery')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function registerPlugin(registry, identity, received, registrationOptions = undefined) {
  return registry.registerPlugin(
    manifest(),
    (context) => context.agentEvents.subscribe(
      'heartbeat',
      (envelope) => { received.push(envelope.event.id) },
      { contractVersion: 2, subscriptionId: SUBSCRIPTION_ID },
    ),
    identity,
    {
      ownerUserId: 'tenant-integration',
      ...(registrationOptions || {}),
    },
  )
}

test('trusted durable plugin ACKs, disables on unregister, and resumes after restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-durable-events-'))
  const db = createDatabase(path.join(root, 'events.db'))
  const store = createSubscriptionStore(db)
  const identity = trustedDurableIdentity()
  let firstHost = null
  let firstRegistry = null
  let secondHost = null
  let secondRegistry = null

  try {
    firstHost = createDurableAgentEventConsumerHost({
      store,
      idlePollMs: 5,
      leaseDurationMs: 1_000,
    })
    firstRegistry = createRuntimePluginRegistry({
      durableAgentEventConsumerHost: firstHost,
    })
    const firstReceived = []
    await registerPlugin(firstRegistry, identity, firstReceived)
    firstHost.start()

    const firstEvent = enqueue(db, 'heartbeat-before-unregister', 0)
    firstHost.notify('heartbeat')
    await waitFor(() => firstReceived.length === 1)
    const [active] = listAgentEventSubscriptions({ db })
    assert.deepEqual(firstReceived, ['heartbeat-before-unregister'])
    assert.equal(active.status, 'active')
    assert.equal(active.ackedCursor, firstEvent.cursor)
    assert.equal(active.scannedCursor, firstEvent.cursor)

    assert.equal(await firstRegistry.unregisterPlugin(PLUGIN_ID), true)
    const disabled = getAgentEventSubscription(active.subscriptionKey, { db })
    assert.equal(disabled.status, 'disabled')
    assert.equal(firstHost.listConsumers().length, 0)

    const secondEvent = enqueue(db, 'heartbeat-while-disabled', 1)
    firstHost.notify('heartbeat')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(firstReceived, ['heartbeat-before-unregister'])
    await firstHost.shutdown()
    await firstRegistry.shutdown()

    secondHost = createDurableAgentEventConsumerHost({
      store,
      idlePollMs: 5,
      leaseDurationMs: 1_000,
    })
    secondRegistry = createRuntimePluginRegistry({
      durableAgentEventConsumerHost: secondHost,
    })
    const resumed = []
    await registerPlugin(secondRegistry, identity, resumed)
    const reenabled = getAgentEventSubscription(active.subscriptionKey, { db })
    assert.equal(reenabled.status, 'active')
    assert.equal(reenabled.ackedCursor, firstEvent.cursor)
    assert.equal(reenabled.scannedCursor, firstEvent.cursor)

    secondHost.start()
    secondHost.notify('heartbeat')
    await waitFor(() => resumed.length === 1)
    const acknowledged = getAgentEventSubscription(active.subscriptionKey, { db })
    assert.deepEqual(resumed, ['heartbeat-while-disabled'])
    assert.equal(acknowledged.ackedCursor, secondEvent.cursor)
    assert.equal(acknowledged.scannedCursor, secondEvent.cursor)

    await secondHost.shutdown()
    await secondRegistry.shutdown()
    assert.equal(getAgentEventSubscription(active.subscriptionKey, { db }).status, 'active')
  } finally {
    await secondHost?.shutdown().catch(() => {})
    await secondRegistry?.shutdown().catch(() => {})
    await firstHost?.shutdown().catch(() => {})
    await firstRegistry?.shutdown().catch(() => {})
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cross-epoch durable restore requires explicit reset and emits metadata-only audit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-durable-reset-'))
  const db = createDatabase(path.join(root, 'events.db'))
  const store = createSubscriptionStore(db)
  const identity = trustedDurableIdentity()
  let firstHost = null
  let firstRegistry = null
  let secondHost = null
  let secondRegistry = null

  try {
    firstHost = createDurableAgentEventConsumerHost({
      store,
      idlePollMs: 5,
      leaseDurationMs: 1_000,
    })
    firstRegistry = createRuntimePluginRegistry({
      durableAgentEventConsumerHost: firstHost,
    })
    await registerPlugin(firstRegistry, identity, [])
    const [created] = listAgentEventSubscriptions({ db })
    await firstRegistry.unregisterPlugin(PLUGIN_ID)
    const discarded = enqueue(db, 'heartbeat-retained-away', 0)
    const truncated = truncateAgentEventOutboxToSafeWatermark({ now: 2_000, db })
    assert.equal(truncated.truncated, true)
    assert.equal(truncated.watermark, discarded.cursor)
    assert.equal(getAgentEventSubscription(created.subscriptionKey, { db }).status, 'disabled')
    await firstHost.shutdown()
    await firstRegistry.shutdown()

    const audit = []
    secondHost = createDurableAgentEventConsumerHost({
      store,
      idlePollMs: 5,
      leaseDurationMs: 1_000,
    })
    secondRegistry = createRuntimePluginRegistry({
      durableAgentEventConsumerHost: secondHost,
      audit: (entry) => audit.push(entry),
    })
    await assert.rejects(
      registerPlugin(secondRegistry, identity, []),
      (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_CURSOR_TRUNCATED',
    )
    assert.equal(secondRegistry.getPlugin(PLUGIN_ID), null)
    assert.deepEqual(secondRegistry.listAgentEventResetAudit(), [])

    const received = []
    await registerPlugin(secondRegistry, identity, received, {
      resetDurableAgentEventSubscriptions: true,
    })
    const resetState = getAgentEventSubscription(created.subscriptionKey, { db })
    assert.equal(resetState.status, 'active')
    assert.equal(resetState.streamEpoch, truncated.stream.epoch)
    assert.equal(resetState.scannedCursor, discarded.cursor)
    const resetAudit = secondRegistry.listAgentEventResetAudit()
    assert.equal(resetAudit.length, 1)
    assert.deepEqual({
      pluginId: resetAudit[0].pluginId,
      subscriptionKey: resetAudit[0].subscriptionKey,
      previousStreamEpoch: resetAudit[0].previousStreamEpoch,
      streamEpoch: resetAudit[0].streamEpoch,
      truncatedThrough: resetAudit[0].truncatedThrough,
      previousScannedCursor: resetAudit[0].previousScannedCursor,
      scannedCursor: resetAudit[0].scannedCursor,
    }, {
      pluginId: PLUGIN_ID,
      subscriptionKey: created.subscriptionKey,
      previousStreamEpoch: 1,
      streamEpoch: truncated.stream.epoch,
      truncatedThrough: discarded.cursor,
      previousScannedCursor: 0,
      scannedCursor: discarded.cursor,
    })
    assert.equal(JSON.stringify(resetAudit).includes('tenant-integration'), false)
    assert.equal(JSON.stringify(resetAudit).includes('heartbeat-retained-away'), false)
    assert.equal(audit.some((entry) => (
      entry.event === 'plugin.agent_event_subscription_reset'
      && entry.subscriptionKey === created.subscriptionKey
    )), true)

    secondHost.start()
    const next = enqueue(db, 'heartbeat-after-explicit-reset', 1)
    secondHost.notify('heartbeat')
    await waitFor(() => received.length === 1)
    assert.deepEqual(received, ['heartbeat-after-explicit-reset'])
    const acknowledged = getAgentEventSubscription(created.subscriptionKey, { db })
    assert.equal(acknowledged.ackedCursor, next.cursor)
    assert.equal(acknowledged.scannedCursor, next.cursor)
  } finally {
    await secondHost?.shutdown().catch(() => {})
    await secondRegistry?.shutdown().catch(() => {})
    await firstHost?.shutdown().catch(() => {})
    await firstRegistry?.shutdown().catch(() => {})
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
