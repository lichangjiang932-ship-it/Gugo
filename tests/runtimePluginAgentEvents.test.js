import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createAgentEventConsumerHost } from '../server/core/agentEventConsumerHost.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
import {
  createRuntimePluginDurableIdentity,
} from '../server/plugins/runtimePluginDurableIdentity.js'
import {
  buildRuntimePluginReleaseContentIdentity,
} from '../server/plugins/runtimePluginReleaseIdentity.js'
import { hydrateStoredRelease } from '../server/services/runtimePluginReleaseSupport.js'
import {
  createTurnEvent,
  createTurnEventTransportEnvelope,
} from '../shared/turnEvents.js'

function manifest(id, contributes = []) {
  return { id, name: id, version: '1.0.0', contributes }
}

function heartbeat(id, sequence = 0) {
  return createTurnEventTransportEnvelope(createTurnEvent({
    id,
    sessionId: 'agent-event-session',
    turnId: 'agent-event-turn',
    sequence,
    type: 'heartbeat',
    payload: { at: 1_000 + sequence },
    createdAt: 1_000 + sequence,
  }))
}

test('runtime plugins must declare each read-only Agent Event and use the supported contract', async () => {
  const host = createAgentEventConsumerHost()
  const registry = createRuntimePluginRegistry({ agentEventConsumerHost: host })

  await assert.rejects(
    registry.registerPlugin(manifest('undeclared-agent-event'), (context) => {
      context.agentEvents.subscribe('heartbeat', () => {})
    }),
    (error) => error?.code === 'PLUGIN_CONTRIBUTION_UNDECLARED'
      || error?.cause?.code === 'PLUGIN_CONTRIBUTION_UNDECLARED',
  )
  await assert.rejects(
    registry.registerPlugin(
      manifest('future-agent-event', ['agent-event:heartbeat']),
      (context) => context.agentEvents.subscribe('heartbeat', () => {}, { contractVersion: 3 }),
    ),
    (error) => error?.code === 'PLUGIN_AGENT_EVENT_VERSION_UNSUPPORTED'
      || error?.cause?.code === 'PLUGIN_AGENT_EVENT_VERSION_UNSUPPORTED',
  )

  const received = []
  await registry.registerPlugin(
    manifest('declared-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe('heartbeat', (envelope) => {
      received.push(envelope)
      return { forgedTurnDecision: true }
    }),
  )
  const receipt = await host.publish(heartbeat('declared-heartbeat'))
  assert.deepEqual([receipt.attempted, receipt.delivered, receipt.failed], [1, 1, 0])
  assert.equal(received.length, 1)
  assert.equal(received[0].v, 1)
  assert.equal(received[0].type, 'turn.event')
  assert.equal(Object.isFrozen(received[0].event.payload), true)

  assert.equal(await registry.unregisterPlugin('declared-agent-event'), true)
  assert.equal((await host.publish(heartbeat('after-unload', 1))).attempted, 0)
  await host.shutdown()
})

function verifiedMarketplaceDistribution() {
  return {
    sourceKind: 'local-marketplace',
    mutable: false,
    verifiedPackage: true,
    installReceipt: {
      schemaVersion: 2,
      pluginId: 'durable-agent-event',
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
  }
}

function storedDurableRelease(
  distribution = verifiedMarketplaceDistribution(),
  { omitDistribution = false } = {},
) {
  const source = 'function transform(input) { return input }'
  const plugin = {
    ...manifest('durable-agent-event', ['agent-event:heartbeat']),
    type: 'transformer',
    entry: 'index.js',
    description: 'Durable Agent Event fixture',
    author: 'Fixture publisher',
    license: 'MIT',
    tags: [],
    capabilities: [],
    ...(omitDistribution ? {} : { distribution }),
  }
  const raw = {
    releaseId: 'release-durable-agent-event',
    pluginId: plugin.id,
    sourceDigest: `sha256-${createHash('sha256').update(source).digest('hex')}`,
    source,
    pluginSnapshotJson: JSON.stringify(plugin),
    validationStatus: 'passed',
    healthStatus: 'passed',
    failure: null,
    createdAt: 1_000,
  }
  const contentIdentity = buildRuntimePluginReleaseContentIdentity(raw)
  return hydrateStoredRelease({
    ...raw,
    digestVersion: contentIdentity.digestVersion,
    releaseContentDigest: contentIdentity.releaseContentDigest,
  })
}

function trustedDurableIdentity() {
  return createRuntimePluginDurableIdentity(storedDurableRelease())
}

test('durable Agent Event v2 requires trusted Release identity and stable subscriptionId', async () => {
  const registrations = []
  const durableHost = Object.freeze({
    contractVersion: 2,
    register: (definition) => {
      registrations.push(definition)
      return Object.freeze({ revoke: async () => true })
    },
  })
  const registry = createRuntimePluginRegistry({ durableAgentEventConsumerHost: durableHost })

  await assert.rejects(
    registry.registerPlugin(
      manifest('unsigned-agent-event', ['agent-event:heartbeat']),
      (context) => context.agentEvents.subscribe(
        'heartbeat',
        () => {},
        { contractVersion: 2, subscriptionId: 'heartbeat-stream' },
      ),
    ),
    (error) => error?.code === 'PLUGIN_AGENT_EVENT_DURABLE_IDENTITY_REQUIRED'
      || error?.cause?.code === 'PLUGIN_AGENT_EVENT_DURABLE_IDENTITY_REQUIRED',
  )
  await assert.rejects(
    registry.registerPlugin(
      manifest('missing-subscription-id', ['agent-event:heartbeat']),
      (context) => context.agentEvents.subscribe('heartbeat', () => {}, { contractVersion: 2 }),
    ),
    (error) => error?.code === 'PLUGIN_AGENT_EVENT_SUBSCRIPTION_ID_INVALID'
      || error?.cause?.code === 'PLUGIN_AGENT_EVENT_SUBSCRIPTION_ID_INVALID',
  )

  const identity = trustedDurableIdentity()
  const received = []
  await registry.registerPlugin(
    manifest('durable-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe(
      'heartbeat',
      (envelope) => { received.push(envelope.event.id) },
      { contractVersion: 2, subscriptionId: 'heartbeat-stream' },
    ),
    identity,
    { ownerUserId: 'tenant-a' },
  )
  assert.equal(registrations.length, 1)
  assert.deepEqual({
    userId: registrations[0].userId,
    publisherId: registrations[0].publisherId,
    publisherKeyId: registrations[0].publisherKeyId,
    packageDigest: registrations[0].packageDigest,
    publicationDigest: registrations[0].publicationDigest,
    releaseId: registrations[0].releaseId,
    releaseContentDigest: registrations[0].releaseContentDigest,
    releaseDigestVersion: registrations[0].releaseDigestVersion,
    pluginId: registrations[0].pluginId,
    pluginVersion: registrations[0].pluginVersion,
    subscriptionId: registrations[0].subscriptionId,
    eventType: registrations[0].eventType,
    contractVersion: registrations[0].contractVersion,
  }, {
    ...identity,
    userId: 'tenant-a',
    subscriptionId: 'heartbeat-stream',
    eventType: 'heartbeat',
    contractVersion: 2,
  })
  await registrations[0].listener(heartbeat('durable-heartbeat'))
  assert.deepEqual(received, ['durable-heartbeat'])
  assert.equal(await registry.unregisterPlugin('durable-agent-event'), true)
  await registry.shutdown()
})

test('durable Release identity fails closed for local, legacy, and tampered releases', () => {
  const unsignedLocal = {
    sourceKind: 'local-directory',
    mutable: true,
    verifiedPackage: false,
    installReceipt: {
      schemaVersion: 1,
      pluginId: 'durable-agent-event',
      pluginVersion: '1.0.0',
      packageDigest: `sha256-${'d'.repeat(64)}`,
      fileCount: 1,
      totalBytes: 128,
      installedAt: 1_000,
      publisherVerified: false,
      sourceKind: 'local-directory',
    },
  }
  assert.equal(createRuntimePluginDurableIdentity(storedDurableRelease(unsignedLocal)), null)
  assert.equal(createRuntimePluginDurableIdentity(
    storedDurableRelease(undefined, { omitDistribution: true }),
  ), null)

  const verified = storedDurableRelease()
  const raw = {
    releaseId: verified.releaseId,
    pluginId: verified.pluginId,
    sourceDigest: verified.sourceDigest,
    source: verified.source,
    pluginSnapshotJson: JSON.stringify({ ...verified.plugin, version: '1.0.1' }),
    validationStatus: verified.validationStatus,
    healthStatus: verified.healthStatus,
    failure: verified.failure,
    createdAt: verified.createdAt,
    digestVersion: verified.digestVersion,
    releaseContentDigest: verified.releaseContentDigest,
  }
  assert.throws(
    () => hydrateStoredRelease(raw),
    (error) => error?.code === 'PLUGIN_RELEASE_CORRUPT',
  )
})

test('durable Agent Event cleanup retries after a failed host revoke', async () => {
  let revokeAttempts = 0
  const durableHost = Object.freeze({
    contractVersion: 2,
    register: () => Object.freeze({
      revoke: async () => {
        revokeAttempts += 1
        if (revokeAttempts === 1) throw new Error('disable temporarily failed')
        return true
      },
    }),
  })
  const registry = createRuntimePluginRegistry({ durableAgentEventConsumerHost: durableHost })

  await registry.registerPlugin(
    manifest('durable-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe(
      'heartbeat',
      () => {},
      { contractVersion: 2, subscriptionId: 'heartbeat-stream' },
    ),
    trustedDurableIdentity(),
    { ownerUserId: 'tenant-a' },
  )

  await assert.rejects(
    registry.unregisterPlugin('durable-agent-event'),
    (error) => error?.code === 'PLUGIN_UNINSTALL_INCOMPLETE',
  )
  assert.equal(revokeAttempts, 1)
  assert.equal(await registry.unregisterPlugin('durable-agent-event'), true)
  assert.equal(revokeAttempts, 2)
  await registry.shutdown()
})

test('Agent Event registration rejects Proxy hosts, options, and listeners without invoking traps', async () => {
  const host = createAgentEventConsumerHost()
  const proxiedHostOptions = new Proxy({ agentEventConsumerHost: host }, {
    getOwnPropertyDescriptor() {
      throw new Error('top-level host options trap must not run')
    },
  })
  assert.throws(
    () => createRuntimePluginRegistry(proxiedHostOptions),
    (error) => error?.code === 'PLUGIN_HOST_ADAPTER_INVALID',
  )
  assert.throws(
    () => createRuntimePluginRegistry({
      agentEventConsumerHost: new Proxy(host, {
        getOwnPropertyDescriptor() {
          throw new Error('host trap must not run')
        },
      }),
    }),
    (error) => error?.code === 'PLUGIN_HOST_ADAPTER_INVALID',
  )

  const registry = createRuntimePluginRegistry({ agentEventConsumerHost: host })
  const proxiedOptions = new Proxy({ contractVersion: 1 }, {
    getOwnPropertyDescriptor() {
      throw new Error('options trap must not run')
    },
  })
  const proxiedListener = new Proxy(() => {}, {
    apply() {
      throw new Error('listener trap must not run')
    },
  })
  await assert.rejects(
    registry.registerPlugin(
      manifest('proxied-options-agent-event', ['agent-event:heartbeat']),
      (context) => context.agentEvents.subscribe('heartbeat', () => {}, proxiedOptions),
    ),
    (error) => error?.code === 'PLUGIN_AGENT_EVENT_OPTIONS_INVALID'
      || error?.cause?.code === 'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
  )
  await assert.rejects(
    registry.registerPlugin(
      manifest('proxied-listener-agent-event', ['agent-event:heartbeat']),
      (context) => context.agentEvents.subscribe('heartbeat', proxiedListener),
    ),
    (error) => error?.code === 'PLUGIN_AGENT_EVENT_LISTENER_INVALID'
      || error?.cause?.code === 'PLUGIN_AGENT_EVENT_LISTENER_INVALID',
  )

  await registry.shutdown()
  await host.shutdown()
})

test('Agent Event listener failures are audited and isolated from healthy plugins', async () => {
  const host = createAgentEventConsumerHost()
  const audit = []
  const registry = createRuntimePluginRegistry({
    agentEventConsumerHost: host,
    audit: (entry) => audit.push(entry),
  })
  const healthy = []
  await registry.registerPlugin(
    manifest('failing-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe('heartbeat', () => {
      throw Object.assign(new Error('observer failed'), { code: 'OBSERVER_FAILED' })
    }),
  )
  await registry.registerPlugin(
    manifest('healthy-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe('heartbeat', (envelope) => {
      healthy.push(envelope.event.id)
    }),
  )

  const receipt = await host.publish(heartbeat('isolated-heartbeat'))
  assert.deepEqual([receipt.attempted, receipt.delivered, receipt.failed], [2, 1, 1])
  assert.deepEqual(healthy, ['isolated-heartbeat'])
  assert.equal(audit.some((entry) => (
    entry.event === 'plugin.agent_event_failed'
      && entry.pluginId === 'failing-agent-event'
      && entry.agentEvent === 'heartbeat'
      && entry.code === 'PLUGIN_AGENT_EVENT_LISTENER_FAILED'
  )), true)

  await registry.shutdown()
  await host.shutdown()
})

test('runtime plugin unload closes Agent Event visibility before draining accepted callbacks', async () => {
  const host = createAgentEventConsumerHost()
  const registry = createRuntimePluginRegistry({ agentEventConsumerHost: host })
  let markStarted
  let releaseListener
  let unloaded = false
  const started = new Promise((resolve) => { markStarted = resolve })
  const gate = new Promise((resolve) => { releaseListener = resolve })
  const received = []

  await registry.registerPlugin(
    manifest('draining-agent-event', ['agent-event:heartbeat']),
    (context) => context.agentEvents.subscribe('heartbeat', async (envelope) => {
      received.push(envelope.event.id)
      markStarted()
      await gate
    }),
  )

  const accepted = host.publish(heartbeat('accepted-before-unload'))
  await started
  const queued = host.publish(heartbeat('queued-before-unload', 1))
  const unloading = registry.unregisterPlugin('draining-agent-event').then((value) => {
    unloaded = true
    return value
  })
  await Promise.resolve()
  const rejected = await host.publish(heartbeat('rejected-after-unload', 2))
  assert.equal(rejected.attempted, 0)
  assert.equal(unloaded, false)
  assert.deepEqual(received, ['accepted-before-unload'])

  releaseListener()
  assert.equal(await unloading, true)
  assert.equal((await accepted).delivered, 1)
  assert.equal((await queued).delivered, 1)
  assert.deepEqual(received, ['accepted-before-unload', 'queued-before-unload'])
  await host.shutdown()
})
