import assert from 'node:assert/strict'
import test from 'node:test'

import { createDurableAgentEventConsumerHost } from '../server/core/durableAgentEventConsumerHost.js'
import { createTurnEventTransportEnvelope } from '../shared/turnEvents.js'

const SUBSCRIPTION_KEY = 'a'.repeat(64)

function eventEntry(index, type = 'turn.started') {
  const event = {
    id: `event-${index}`,
    sessionId: 'session-durable-host',
    turnId: `turn-${index}`,
    sequence: index,
    type,
    payload: {},
    createdAt: 1_000 + index,
  }
  return Object.freeze({
    cursor: index,
    eventId: event.id,
    eventType: type,
    userId: 'tenant-private',
    envelope: createTurnEventTransportEnvelope(event),
  })
}

function storeFailure(code) {
  return Object.assign(new Error(code), { code, retryable: false })
}

function createMemoryStore({
  entries = [],
  maxAttempts = 3,
  retryDelayMs = 5,
  ackFailures = 0,
  status = 'active',
  disableFailures = 0,
  emptyBacklogPages = 0,
  renewFailures = 0,
  retentionFailures = 0,
} = {}) {
  const state = {
    entries: [...entries],
    acknowledged: [],
    failed: [],
    deadLetters: [],
    generation: 0,
    lease: null,
    retryCursor: null,
    retryAttempts: 0,
    retryAt: null,
    ackFailures,
    status,
    enableCalls: [],
    disableCalls: 0,
    disableFailures,
    emptyBacklogPages,
    renewCalls: 0,
    renewFailures,
    scanCalls: 0,
    retentionCalls: [],
    retentionFailures,
  }

  const assertLease = (token, now) => {
    if (!state.lease
      || token?.subscriptionKey !== SUBSCRIPTION_KEY
      || token.owner !== state.lease.owner
      || token.generation !== state.lease.generation
      || state.lease.expiresAt <= now) {
      throw storeFailure('AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED')
    }
  }

  const store = {
    ensureAgentEventSubscription(definition) {
      return Object.freeze({
        subscriptionKey: SUBSCRIPTION_KEY,
        contractVersion: 2,
        eventType: definition.eventType,
        status: state.status,
      })
    },
    enableAgentEventSubscription(key, { resetToCurrent, now }) {
      assert.equal(key, SUBSCRIPTION_KEY)
      state.enableCalls.push({ resetToCurrent, now })
      state.status = 'active'
      return Object.freeze({
        subscriptionKey: SUBSCRIPTION_KEY,
        contractVersion: 2,
        eventType: entries[0]?.eventType || 'turn.started',
        status: state.status,
      })
    },
    disableAgentEventSubscription(key) {
      assert.equal(key, SUBSCRIPTION_KEY)
      state.disableCalls += 1
      if (state.disableFailures > 0) {
        state.disableFailures -= 1
        throw storeFailure('AGENT_EVENT_SUBSCRIPTION_DISABLE_FAILED')
      }
      state.status = 'disabled'
      return Object.freeze({ subscriptionKey: SUBSCRIPTION_KEY, status: state.status })
    },
    acquireAgentEventSubscriptionLease(_key, { owner, now, leaseDurationMs }) {
      if (state.status !== 'active') return null
      if (state.lease && state.lease.expiresAt > now && state.lease.owner !== owner) return null
      state.generation += 1
      state.lease = Object.freeze({
        subscriptionKey: SUBSCRIPTION_KEY,
        owner,
        generation: state.generation,
        expiresAt: now + leaseDurationMs,
      })
      return state.lease
    },
    renewAgentEventSubscriptionLease(token, { now, leaseDurationMs }) {
      assertLease(token, now)
      state.renewCalls += 1
      if (state.renewFailures > 0) {
        state.renewFailures -= 1
        throw storeFailure('AGENT_EVENT_SUBSCRIPTION_RENEW_FAILED')
      }
      state.lease = Object.freeze({ ...token, expiresAt: now + leaseDurationMs })
      return state.lease
    },
    releaseAgentEventSubscriptionLease(token, { now }) {
      assertLease(token, now)
      state.lease = null
      return true
    },
    scanAgentEventSubscription(token, { now }) {
      assertLease(token, now)
      state.scanCalls += 1
      if (state.retryAt !== null && state.retryAt > now) {
        return Object.freeze({ entry: null, retryAt: state.retryAt, hasMore: true })
      }
      if (state.emptyBacklogPages > 0) {
        state.emptyBacklogPages -= 1
        return Object.freeze({ entry: null, retryAt: null, hasMore: true })
      }
      return Object.freeze({
        entry: state.entries[0] || null,
        retryAt: null,
        hasMore: state.entries.length > 0,
      })
    },
    acknowledgeAgentEventSubscription(token, { cursor, now }) {
      assertLease(token, now)
      if (state.ackFailures > 0) {
        state.ackFailures -= 1
        throw storeFailure('AGENT_EVENT_SUBSCRIPTION_LEASE_FENCED')
      }
      assert.equal(state.entries[0]?.cursor, cursor)
      state.acknowledged.push(cursor)
      state.entries.shift()
      state.retryCursor = null
      state.retryAttempts = 0
      state.retryAt = null
      return Object.freeze({ subscriptionKey: SUBSCRIPTION_KEY, ackedCursor: cursor })
    },
    failAgentEventSubscription(token, { cursor, failureCode, now }) {
      assertLease(token, now)
      assert.equal(state.entries[0]?.cursor, cursor)
      state.retryAttempts = state.retryCursor === cursor ? state.retryAttempts + 1 : 1
      state.retryCursor = cursor
      state.failed.push({ cursor, failureCode, attempt: state.retryAttempts })
      if (state.retryAttempts < maxAttempts) {
        state.retryAt = now + retryDelayMs
        return Object.freeze({
          deadLettered: false,
          attempt: state.retryAttempts,
          retryAt: state.retryAt,
        })
      }
      state.deadLetters.push({ cursor, failureCode, attempts: state.retryAttempts })
      state.entries.shift()
      state.retryCursor = null
      state.retryAttempts = 0
      state.retryAt = null
      return Object.freeze({
        deadLettered: true,
        attempt: maxAttempts,
        retryAt: null,
      })
    },
    truncateAgentEventOutboxToSafeWatermark({ now }) {
      state.retentionCalls.push(now)
      if (state.retentionFailures > 0) {
        state.retentionFailures -= 1
        throw storeFailure('AGENT_EVENT_RETENTION_TEST_FAILED')
      }
      return Object.freeze({ truncated: false, reason: 'at_watermark', deleted: 0 })
    },
  }
  return { store, state }
}

async function waitFor(predicate, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for durable consumer state')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function createControlledClock(start = 0) {
  let current = start
  let nextTimerId = 0
  const timers = new Map()
  const flush = async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  }
  return Object.freeze({
    now: () => current,
    schedule(callback, delay) {
      const id = ++nextTimerId
      timers.set(id, { callback, at: current + delay })
      return id
    },
    cancelSchedule(id) {
      timers.delete(id)
    },
    async advanceBy(duration) {
      const target = current + duration
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        current = timer.at
        timer.callback()
        await flush()
      }
      current = target
      await flush()
    },
    flush,
    pending: () => timers.size,
  })
}

function registration(listener, eventType = 'turn.started') {
  return {
    contractVersion: 2,
    eventType,
    listener,
  }
}

test('durable consumers receive only envelopes serially and ACK in cursor order', async () => {
  const { store, state } = createMemoryStore({ entries: [eventEntry(1), eventEntry(2)] })
  let active = 0
  let maxActive = 0
  const observed = []
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
  })
  host.register(registration(async (envelope) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    observed.push(envelope.event.id)
    assert.equal(Object.hasOwn(envelope, 'userId'), false)
    assert.equal(JSON.stringify(envelope).includes('tenant-private'), false)
    await new Promise((resolve) => setTimeout(resolve, 3))
    active -= 1
  }))

  assert.equal(host.start(), true)
  await waitFor(() => state.acknowledged.length === 2)
  assert.deepEqual(observed, ['event-1', 'event-2'])
  assert.deepEqual(state.acknowledged, [1, 2])
  assert.equal(maxActive, 1)
  await host.shutdown()
})

test('unrelated full pages continue under one lease without an idle poll per page', async () => {
  const clock = createControlledClock()
  const { store, state } = createMemoryStore({
    entries: [eventEntry(1)],
    emptyBacklogPages: 3,
  })
  let generationAtDelivery = null
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 1_000,
    leaseDurationMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  })
  host.register(registration(() => {
    generationAtDelivery = state.generation
  }))

  host.start()
  await clock.flush()

  assert.deepEqual(state.acknowledged, [1])
  assert.equal(state.scanCalls, 5)
  assert.equal(generationAtDelivery, 1)
  await host.shutdown()
  assert.equal(clock.pending(), 0)
})

test('retention maintenance runs immediately, repeats, reports errors, and stops at shutdown', async () => {
  const clock = createControlledClock(100)
  const { store, state } = createMemoryStore({ retentionFailures: 1 })
  const hostFailures = []
  const deliveryFailures = []
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 1_000,
    leaseDurationMs: 1_000,
    retentionIntervalMs: 25,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    onHostError: (failure) => hostFailures.push(failure),
    onDeliveryFailure: (failure) => deliveryFailures.push(failure),
  })

  assert.equal(host.start(), true)
  await clock.flush()
  assert.deepEqual(state.retentionCalls, [100])
  assert.deepEqual(hostFailures, [{
    code: 'AGENT_EVENT_RETENTION_TEST_FAILED',
    phase: 'retention',
    subscriptionKey: null,
  }])

  await clock.advanceBy(24)
  assert.deepEqual(state.retentionCalls, [100])
  await clock.advanceBy(1)
  assert.deepEqual(state.retentionCalls, [100, 125])
  await clock.advanceBy(50)
  assert.deepEqual(state.retentionCalls, [100, 125, 150, 175])
  assert.deepEqual(deliveryFailures, [])

  assert.equal(await host.shutdown(), true)
  const callsAtShutdown = state.retentionCalls.length
  await clock.advanceBy(100)
  assert.equal(state.retentionCalls.length, callsAtShutdown)
  assert.equal(clock.pending(), 0)
})

test('listener failures retry with stable state and reach the DLQ without blocking later events', async () => {
  const { store, state } = createMemoryStore({
    entries: [eventEntry(1), eventEntry(2)],
    maxAttempts: 2,
    retryDelayMs: 3,
  })
  const failures = []
  const delivered = []
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
    onDeliveryFailure: (failure) => failures.push(failure),
  })
  host.register(registration((envelope) => {
    if (envelope.event.id === 'event-1') {
      throw Object.assign(new Error('private plugin failure'), { code: 'PLUGIN_CALLBACK_FAILED' })
    }
    delivered.push(envelope.event.id)
  }))
  host.start()

  await waitFor(() => state.deadLetters.length === 1 && state.acknowledged.length === 1)
  assert.deepEqual(state.deadLetters, [{
    cursor: 1,
    failureCode: 'PLUGIN_CALLBACK_FAILED',
    attempts: 2,
  }])
  assert.deepEqual(delivered, ['event-2'])
  assert.deepEqual(state.acknowledged, [2])
  assert.deepEqual(failures.map(({ attempt, deadLettered }) => [attempt, deadLettered]), [
    [1, false],
    [2, true],
  ])
  assert.equal(JSON.stringify(failures).includes('private plugin failure'), false)
  await host.shutdown()
})

test('an unacknowledged event is replayed after host restart', async () => {
  const memory = createMemoryStore({ entries: [eventEntry(1)], ackFailures: 100 })
  let firstDeliveries = 0
  let hostFailure = null
  const first = createDurableAgentEventConsumerHost({
    store: memory.store,
    idlePollMs: 25,
    leaseDurationMs: 1_000,
    onHostError: (failure) => { hostFailure ||= failure },
  })
  first.register(registration(() => { firstDeliveries += 1 }))
  first.start()
  await waitFor(() => hostFailure !== null)
  await first.shutdown()

  assert.equal(firstDeliveries, 1)
  assert.deepEqual(memory.state.acknowledged, [])
  assert.equal(memory.state.entries.length, 1)

  memory.state.ackFailures = 0
  let recoveredDeliveries = 0
  const second = createDurableAgentEventConsumerHost({
    store: memory.store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
  })
  second.register(registration(() => { recoveredDeliveries += 1 }))
  second.start()
  await waitFor(() => memory.state.acknowledged.length === 1)

  assert.equal(recoveredDeliveries, 1)
  assert.deepEqual(memory.state.acknowledged, [1])
  await second.shutdown()
})

test('shutdown drains an accepted callback before releasing its lease', async () => {
  const { store, state } = createMemoryStore({ entries: [eventEntry(1)] })
  let resolveListener
  let listenerStarted = false
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
  })
  host.register(registration(() => new Promise((resolve) => {
    listenerStarted = true
    resolveListener = resolve
  })))
  host.start()
  await waitFor(() => listenerStarted)

  let settled = false
  const shutdown = host.shutdown().then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  assert.ok(state.lease)

  resolveListener()
  await shutdown
  assert.equal(settled, true)
  assert.deepEqual(state.acknowledged, [1])
  assert.equal(state.lease, null)
})

test('shutdown keeps renewing a long async callback lease through its final ACK', async () => {
  const clock = createControlledClock()
  const { store, state } = createMemoryStore({ entries: [eventEntry(1)] })
  const hostFailures = []
  let resolveListener
  let listenerStarted = false
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 1_000,
    leaseDurationMs: 100,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    onHostError: (failure) => hostFailures.push(failure),
  })
  host.register(registration(() => new Promise((resolve) => {
    listenerStarted = true
    resolveListener = resolve
  })))
  host.start()
  await clock.flush()
  assert.equal(listenerStarted, true)

  const shutdown = host.shutdown()
  await clock.advanceBy(250)
  assert.ok(state.renewCalls >= 5)
  assert.ok(state.lease.expiresAt > clock.now())

  resolveListener()
  await clock.flush()
  assert.equal(await shutdown, true)
  assert.deepEqual(state.acknowledged, [1])
  assert.deepEqual(hostFailures, [])
  assert.equal(state.lease, null)
  assert.equal(clock.pending(), 0)
})

test('shutdown abandons a hanging listener at the drain deadline and restart replays it', async () => {
  const clock = createControlledClock()
  const memory = createMemoryStore({ entries: [eventEntry(1)] })
  const hostFailures = []
  let rejectListener
  let listenerStarted = false
  const first = createDurableAgentEventConsumerHost({
    store: memory.store,
    idlePollMs: 1_000,
    leaseDurationMs: 100,
    listenerDrainTimeoutMs: 25,
    retentionIntervalMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    onHostError: (failure) => hostFailures.push(failure),
  })
  first.register(registration(() => new Promise((_resolve, reject) => {
    listenerStarted = true
    rejectListener = reject
  })))
  first.start()
  await clock.flush()
  assert.equal(listenerStarted, true)

  let shutdownSettled = false
  const shutdown = first.shutdown().then(() => { shutdownSettled = true })
  await clock.flush()
  await clock.advanceBy(24)
  assert.equal(shutdownSettled, false)
  assert.ok(memory.state.lease)

  await clock.advanceBy(1)
  assert.equal(await shutdown, undefined)
  assert.equal(shutdownSettled, true)
  assert.deepEqual(memory.state.acknowledged, [])
  assert.deepEqual(memory.state.failed, [])
  assert.equal(memory.state.entries.length, 1)
  assert.equal(memory.state.lease, null)
  assert.deepEqual(hostFailures, [{
    code: 'AGENT_EVENT_LISTENER_DRAIN_TIMEOUT',
    phase: 'drain',
    subscriptionKey: SUBSCRIPTION_KEY,
  }])

  rejectListener(storeFailure('LATE_PLUGIN_REJECTION'))
  await clock.flush()

  let replayed = 0
  const second = createDurableAgentEventConsumerHost({
    store: memory.store,
    idlePollMs: 1_000,
    leaseDurationMs: 100,
    retentionIntervalMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  })
  second.register(registration(() => { replayed += 1 }))
  second.start()
  await clock.flush()

  assert.equal(replayed, 1)
  assert.deepEqual(memory.state.acknowledged, [1])
  assert.equal(await second.shutdown(), true)
  assert.equal(clock.pending(), 0)
})

test('registration explicitly re-enables a disabled subscription without resetting its cursor', async () => {
  const { store, state } = createMemoryStore({
    entries: [eventEntry(1)],
    status: 'disabled',
  })
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
    now: () => 1_000,
  })
  host.register(registration(() => {}))

  assert.deepEqual(state.enableCalls, [{ resetToCurrent: false, now: 1_000 }])
  assert.equal(state.status, 'active')
  host.start()
  await waitFor(() => state.acknowledged.length === 1)
  await host.shutdown()
})

test('explicit revoke drains before disabling and a failed disable can be retried', async () => {
  const { store, state } = createMemoryStore({
    entries: [eventEntry(1)],
    disableFailures: 1,
  })
  let releaseListener
  let listenerStarted = false
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
  })
  const consumer = host.register(registration(() => new Promise((resolve) => {
    listenerStarted = true
    releaseListener = resolve
  })))
  host.start()
  await waitFor(() => listenerStarted)

  const firstRevoke = consumer.revoke()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(state.disableCalls, 0)
  assert.equal(state.status, 'active')
  assert.ok(state.lease)

  releaseListener()
  await assert.rejects(
    firstRevoke,
    (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_DISABLE_FAILED',
  )
  assert.deepEqual(state.acknowledged, [1])
  assert.equal(state.lease, null)
  assert.equal(state.status, 'active')
  assert.equal(state.disableCalls, 1)

  assert.equal(await consumer.revoke(), true)
  assert.equal(state.disableCalls, 2)
  assert.equal(state.status, 'disabled')
  await host.shutdown()
})

test('shutdown tracks an in-flight uninstall and retries its locked disable intent', async () => {
  const clock = createControlledClock()
  const { store, state } = createMemoryStore({
    entries: [eventEntry(1)],
    disableFailures: 1,
  })
  let resolveListener
  let listenerStarted = false
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 1_000,
    leaseDurationMs: 1_000,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  })
  const consumer = host.register(registration(() => new Promise((resolve) => {
    listenerStarted = true
    resolveListener = resolve
  })))
  host.start()
  await clock.flush()
  assert.equal(listenerStarted, true)

  const revoke = consumer.revoke()
  revoke.catch(() => {})
  assert.throws(
    () => host.register(registration(() => {})),
    (error) => error?.code === 'AGENT_EVENT_DURABLE_CONSUMER_DUPLICATE',
  )
  let shutdownSettled = false
  const firstShutdown = host.shutdown()
  firstShutdown.then(
    () => { shutdownSettled = true },
    () => { shutdownSettled = true },
  )
  await clock.flush()
  assert.equal(shutdownSettled, false)
  assert.equal(host.listConsumers().length, 0)

  resolveListener()
  await clock.flush()
  await assert.rejects(
    revoke,
    (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_DISABLE_FAILED',
  )
  await assert.rejects(
    firstShutdown,
    (error) => error?.code === 'AGENT_EVENT_SUBSCRIPTION_DISABLE_FAILED',
  )
  assert.equal(state.status, 'active')
  assert.equal(state.disableCalls, 1)
  assert.equal(state.generation, 1)

  assert.equal(await host.shutdown(), true)
  assert.equal(state.status, 'disabled')
  assert.equal(state.disableCalls, 2)
  assert.equal(state.generation, 1)
  assert.equal(await consumer.revoke(), true)
})

test('host shutdown and later registration revoke preserve the active subscription for restart', async () => {
  const { store, state } = createMemoryStore()
  const host = createDurableAgentEventConsumerHost({
    store,
    idlePollMs: 5,
    leaseDurationMs: 1_000,
  })
  const consumer = host.register(registration(() => {}))
  host.start()

  assert.equal(await host.shutdown(), true)
  assert.equal(state.status, 'active')
  assert.equal(state.disableCalls, 0)
  assert.equal(state.lease, null)

  assert.equal(await consumer.revoke(), true)
  assert.equal(state.status, 'active')
  assert.equal(state.disableCalls, 0)
})
