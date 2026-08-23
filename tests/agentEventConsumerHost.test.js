import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
  createAgentEventConsumerHost,
} from '../server/core/agentEventConsumerHost.js'
import {
  createTurnEvent,
  createTurnEventTransportEnvelope,
} from '../shared/turnEvents.js'

function envelope({
  id = 'event-1',
  sequence = 0,
  type = 'model.phase',
  payload = { phase: 'requesting', usage: { promptTokens: 12 } },
} = {}) {
  return createTurnEventTransportEnvelope(createTurnEvent({
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    sequence,
    type,
    payload,
    createdAt: 100 + sequence,
  }))
}

test('agent event consumer receives only its declared v1 events as detached deep-frozen data', async () => {
  const host = createAgentEventConsumerHost()
  const received = []
  const handle = host.register({
    id: 'plugin.audit.consumer',
    contractVersion: AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
    eventTypes: ['model.phase'],
    listener(value) {
      received.push(value)
      return { forgedDecision: 'replace-turn-result' }
    },
  })
  const source = envelope()
  const published = host.publish(source)
  source.event.payload.usage.promptTokens = 999
  source.event.payload.phase = 'mutated-after-publish'

  const receipt = await published
  assert.deepEqual(receipt, {
    eventId: 'event-1',
    eventType: 'model.phase',
    eventSequence: 0,
    attempted: 1,
    delivered: 1,
    failed: 0,
  })
  assert.equal(Object.isFrozen(receipt), true)
  assert.equal(received.length, 1)
  assert.notEqual(received[0], source)
  assert.notEqual(received[0].event.payload, source.event.payload)
  assert.equal(received[0].v, 1)
  assert.equal(received[0].type, 'turn.event')
  assert.equal(received[0].event.payload.phase, 'requesting')
  assert.equal(received[0].event.payload.usage.promptTokens, 12)
  assert.equal(Object.isFrozen(received[0]), true)
  assert.equal(Object.isFrozen(received[0].event), true)
  assert.equal(Object.isFrozen(received[0].event.payload), true)
  assert.equal(Object.isFrozen(received[0].event.payload.usage), true)

  const skipped = await host.publish(envelope({
    id: 'event-2',
    sequence: 1,
    type: 'heartbeat',
    payload: { at: 101 },
  }))
  assert.equal(skipped.attempted, 0)
  assert.equal(received.length, 1)
  assert.equal(await handle.revoke(), true)
})

test('agent event consumer failures are isolated and do not stop later ordered delivery', async () => {
  const failures = []
  const delivered = []
  const host = createAgentEventConsumerHost({
    onListenerError(failure) {
      failures.push(failure)
      throw new Error('observer failure must stay non-authoritative')
    },
  })
  host.register({
    id: 'plugin.failing.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
    async listener(value) {
      if (value.event.sequence === 0) throw new Error('expected listener failure')
      delivered.push(`failing:${value.event.sequence}`)
    },
  })
  host.register({
    id: 'plugin.healthy.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
    listener(value) {
      delivered.push(`healthy:${value.event.sequence}`)
    },
  })

  const first = await host.publish(envelope({
    id: 'heartbeat-0',
    type: 'heartbeat',
    payload: { at: 100 },
  }))
  const second = await host.publish(envelope({
    id: 'heartbeat-1',
    sequence: 1,
    type: 'heartbeat',
    payload: { at: 101 },
  }))

  assert.deepEqual([first.delivered, first.failed], [1, 1])
  assert.deepEqual([second.delivered, second.failed], [2, 0])
  assert.deepEqual(delivered, ['healthy:0', 'failing:1', 'healthy:1'])
  assert.equal(failures.length, 1)
  assert.equal(failures[0].code, 'AGENT_EVENT_CONSUMER_LISTENER_FAILED')
  assert.equal(failures[0].consumerId, 'plugin.failing.consumer')
  assert.equal(Object.isFrozen(failures[0]), true)
  await host.shutdown()
})

test('each consumer observes concurrent publications serially in publication order', async () => {
  const host = createAgentEventConsumerHost()
  const order = []
  let releaseFirst
  let markFirstStarted
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  host.register({
    id: 'plugin.serial.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
    async listener(value) {
      order.push(`start:${value.event.sequence}`)
      if (value.event.sequence === 0) {
        markFirstStarted()
        await firstGate
      }
      order.push(`end:${value.event.sequence}`)
    },
  })

  const first = host.publish(envelope({
    id: 'ordered-0',
    type: 'heartbeat',
    payload: { at: 100 },
  }))
  await firstStarted
  const second = host.publish(envelope({
    id: 'ordered-1',
    sequence: 1,
    type: 'heartbeat',
    payload: { at: 101 },
  }))
  await Promise.resolve()
  assert.deepEqual(order, ['start:0'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['start:0', 'end:0', 'start:1', 'end:1'])
  await host.shutdown()
})

test('revoke rejects new delivery immediately, drains accepted work, and fences re-registration', async () => {
  const host = createAgentEventConsumerHost()
  const received = []
  let releaseListener
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const gate = new Promise((resolve) => { releaseListener = resolve })
  const definition = {
    id: 'plugin.revocable.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
    async listener(value) {
      received.push(value.event.id)
      markStarted()
      await gate
    },
  }
  const handle = host.register(definition)
  const accepted = host.publish(envelope({
    id: 'accepted-before-revoke',
    type: 'heartbeat',
    payload: { at: 100 },
  }))
  await started
  const draining = handle.revoke()
  assert.deepEqual(host.listConsumers(), [])
  assert.throws(
    () => host.register(definition),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_DUPLICATE',
  )

  const rejected = await host.publish(envelope({
    id: 'rejected-after-revoke',
    sequence: 1,
    type: 'heartbeat',
    payload: { at: 101 },
  }))
  assert.equal(rejected.attempted, 0)
  let drained = false
  void draining.then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)

  releaseListener()
  assert.equal(await draining, true)
  assert.equal((await accepted).delivered, 1)
  assert.deepEqual(received, ['accepted-before-revoke'])
  const replacement = host.register(definition)
  assert.equal(await replacement.revoke(), true)
  await host.shutdown()
})

test('shutdown also drains consumers already retiring through a manual revoke', async () => {
  const host = createAgentEventConsumerHost()
  let releaseListener
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const gate = new Promise((resolve) => { releaseListener = resolve })
  const handle = host.register({
    id: 'plugin.shutdown-drain.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
    async listener() {
      markStarted()
      await gate
    },
  })
  const accepted = host.publish(envelope({
    id: 'accepted-before-shutdown',
    type: 'heartbeat',
    payload: { at: 100 },
  }))
  await started
  const manualRevoke = handle.revoke()
  const shutdown = host.shutdown()
  let shutdownFinished = false
  void shutdown.then(() => { shutdownFinished = true })
  await Promise.resolve()
  assert.equal(shutdownFinished, false)

  releaseListener()
  assert.equal(await manualRevoke, true)
  assert.equal(await shutdown, true)
  assert.equal((await accepted).delivered, 1)
})

test('invalid versions, undeclared event names, accessors, and non-v1 envelopes fail closed', async () => {
  const host = createAgentEventConsumerHost()
  assert.throws(
    () => host.register({
      id: 'plugin.future.consumer',
      contractVersion: 2,
      eventTypes: ['heartbeat'],
      listener() {},
    }),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => host.register({
      id: 'plugin.wildcard.consumer',
      contractVersion: 1,
      eventTypes: ['*'],
      listener() {},
    }),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_EVENT_UNSUPPORTED',
  )
  const accessorDefinition = {
    id: 'plugin.accessor.consumer',
    contractVersion: 1,
    eventTypes: ['heartbeat'],
  }
  Object.defineProperty(accessorDefinition, 'listener', {
    enumerable: true,
    get() { throw new Error('must not execute') },
  })
  assert.throws(
    () => host.register(accessorDefinition),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
  )
  assert.throws(
    () => host.publish({ ...envelope(), v: 2 }),
    (error) => error?.code === 'AGENT_EVENT_ENVELOPE_INVALID',
  )
  assert.throws(
    () => host.publish({ ...envelope(), extra: true }),
    (error) => error?.code === 'AGENT_EVENT_ENVELOPE_INVALID',
  )
  const eventTypesWithPseudoIndex = ['heartbeat']
  Object.defineProperty(eventTypesWithPseudoIndex, '01', { value: 'model.phase' })
  assert.throws(
    () => host.register({
      id: 'plugin.pseudo-index.consumer',
      contractVersion: 1,
      eventTypes: eventTypesWithPseudoIndex,
      listener() {},
    }),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_DEFINITION_INVALID',
  )
  const envelopeWithPseudoIndex = envelope()
  const tags = ['first']
  Object.defineProperty(tags, '01', { value: 'second' })
  envelopeWithPseudoIndex.event.payload.tags = tags
  assert.throws(
    () => host.publish(envelopeWithPseudoIndex),
    (error) => error?.code === 'AGENT_EVENT_ENVELOPE_INVALID',
  )
  await host.shutdown()
  assert.throws(
    () => host.publish(envelope()),
    (error) => error?.code === 'AGENT_EVENT_CONSUMER_HOST_CLOSED',
  )
})
