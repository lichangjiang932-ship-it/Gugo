import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentEventConsumerHost } from '../server/core/agentEventConsumerHost.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'
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
      (context) => context.agentEvents.subscribe('heartbeat', () => {}, { contractVersion: 2 }),
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
