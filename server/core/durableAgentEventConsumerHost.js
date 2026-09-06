import { randomUUID } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  MAX_AGENT_EVENT_HOST_DELAY_MS,
  boundedAgentEventHostDelay,
  durableHostError,
  normalizeDurableAgentEventListener,
  observeAgentEventHost,
  positiveHostInteger,
  safeAgentEventFailureCode,
  snapshotDurableAgentEventStore,
} from './durableAgentEventConsumerHostSupport.js'
import { createDurableAgentEventRetentionScheduler } from './durableAgentEventRetentionScheduler.js'
import { createDurableAgentEventConsumerRunner } from './durableAgentEventConsumerRunner.js'

const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_IDLE_POLL_MS = 1_000
const DEFAULT_SCAN_LIMIT = 100
const DEFAULT_LISTENER_DRAIN_TIMEOUT_MS = 30_000
const DEFAULT_RETENTION_INTERVAL_MS = 60_000

function resetToCurrentRegistrationOption(options) {
  if (options === undefined) return false
  if (!options || typeof options !== 'object' || Array.isArray(options) || utilTypes.isProxy(options)) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      'durable Agent Event registration options must be an object',
    )
  }
  let keys
  try { keys = Reflect.ownKeys(options) }
  catch {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      'durable Agent Event registration options cannot be inspected safely',
    )
  }
  if (keys.some((key) => key !== 'resetToCurrent')) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      'durable Agent Event registration options contain unsupported fields',
    )
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'resetToCurrent')
  if (!descriptor) return false
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      'resetToCurrent must be an own boolean data property',
    )
  }
  return descriptor.value
}

function wakeRecord(record) {
  const waiter = record.wake
  record.wake = null
  waiter?.()
}

function markRecordStopping(runtime, record) {
  if (record.stopping) return false
  record.stopping = true
  record.stoppingAt = runtime.now()
  const signalStopping = record.signalStopping
  record.signalStopping = null
  signalStopping?.()
  wakeRecord(record)
  return true
}

function waitForRecordWake(runtime, record, delayMs) {
  if (record.stopping || runtime.state.closed || !runtime.state.started) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) runtime.cancelSchedule(timer)
      if (record.wake === wakeNow) record.wake = null
      resolve(value)
    }
    const wakeNow = () => finish(true)
    record.wake = wakeNow
    timer = runtime.schedule(
      () => finish(false),
      boundedAgentEventHostDelay(delayMs, runtime.pollMs),
    )
  })
}

function scheduledWait(runtime, delayMs) {
  let settled = false
  let timer = null
  let settle
  const promise = new Promise((resolve) => {
    settle = resolve
    timer = runtime.schedule(() => {
      if (settled) return
      settled = true
      resolve(true)
    }, boundedAgentEventHostDelay(delayMs, runtime.pollMs))
  })
  return Object.freeze({
    promise,
    cancel() {
      if (settled) return false
      settled = true
      if (timer !== null) {
        try { runtime.cancelSchedule(timer) } catch { /* best-effort timer cancellation */ }
      }
      settle(false)
      return true
    },
  })
}

function reportRetentionError(runtime, error) {
  observeAgentEventHost(runtime.onHostError, {
    code: safeAgentEventFailureCode(error, 'AGENT_EVENT_RETENTION_FAILED'),
    phase: 'retention',
    subscriptionKey: null,
  })
}

async function releaseRecordLease(runtime, record) {
  const token = record.lease
  record.lease = null
  if (!token) return false
  try {
    await runtime.operations.releaseAgentEventSubscriptionLease(token, { now: runtime.now() })
    return true
  } catch (error) {
    observeAgentEventHost(runtime.onHostError, {
      code: safeAgentEventFailureCode(error),
      phase: 'release',
      subscriptionKey: record.subscriptionKey,
    })
    return false
  }
}

async function renewRecordLease(runtime, record) {
  const token = record.lease
  if (!token) return null
  const timestamp = runtime.now()
  if (Number(token.expiresAt) - timestamp > Math.floor(runtime.leaseMs / 2)) return token
  record.lease = await runtime.operations.renewAgentEventSubscriptionLease(token, {
    now: timestamp,
    leaseDurationMs: runtime.leaseMs,
  })
  return record.lease
}

async function invokeListenerWithHeartbeat(runtime, record, envelope) {
  let completion
  try { completion = record.listener(envelope) }
  catch (error) { return Object.freeze({ listenerFailure: error, leaseFailure: null }) }
  if (!utilTypes.isPromise(completion)) {
    return Object.freeze({ listenerFailure: null, leaseFailure: null })
  }
  const listenerOutcome = Promise.prototype.then.call(
    completion,
    () => Object.freeze({ listenerFailure: null }),
    (error) => Object.freeze({ listenerFailure: error }),
  )
  const stoppingOutcome = Promise.prototype.then.call(
    record.stoppingPromise,
    () => Object.freeze({ kind: 'stopping', error: null }),
  )
  let drain = null
  let leaseFailure = null
  let heartbeat = null
  while (true) {
    heartbeat = leaseFailure
      ? null
      : heartbeat || scheduledWait(runtime, Math.max(
          1,
          Math.floor(Math.max(1, Number(record.lease?.expiresAt) - runtime.now()) / 2),
        ))
    const outcomes = [
      listenerOutcome.then((result) => Object.freeze({ kind: 'listener', result })),
    ]
    if (heartbeat) {
      outcomes.push(heartbeat.promise.then(
        () => Object.freeze({ kind: 'heartbeat', error: null }),
        (error) => Object.freeze({ kind: 'heartbeat', error }),
      ))
    }
    if (drain) {
      outcomes.push(drain.promise.then(
        () => Object.freeze({ kind: 'drain-timeout', error: null }),
        (error) => Object.freeze({ kind: 'drain-timeout', error }),
      ))
    } else outcomes.push(stoppingOutcome)
    const outcome = await Promise.race(outcomes)
    if (outcome.kind === 'listener') {
      heartbeat?.cancel()
      drain?.cancel()
      return Object.freeze({
        listenerFailure: outcome.result.listenerFailure,
        leaseFailure,
        abandoned: false,
      })
    }
    if (outcome.kind === 'stopping') {
      const elapsed = Math.max(0, runtime.now() - Number(record.stoppingAt ?? runtime.now()))
      drain ||= scheduledWait(runtime, Math.max(0, runtime.drainMs - elapsed))
      continue
    }
    if (outcome.kind === 'drain-timeout') {
      heartbeat?.cancel()
      return Object.freeze({ listenerFailure: null, leaseFailure, abandoned: true })
    }
    if (outcome.error) {
      leaseFailure ||= outcome.error
      drain ||= scheduledWait(runtime, runtime.drainMs)
      continue
    }
    heartbeat = null
    try {
      record.lease = await runtime.operations.renewAgentEventSubscriptionLease(record.lease, {
        now: runtime.now(),
        leaseDurationMs: runtime.leaseMs,
      })
    } catch (error) {
      leaseFailure ||= error
      drain ||= scheduledWait(runtime, runtime.drainMs)
    }
  }
}

function launchRecord(runtime, record) {
  if (!runtime.state.started || runtime.state.closed
    || record.stopping || record.abandoned || record.runPromise) return
  record.runPromise = runtime.runRecord(record).finally(() => { record.runPromise = null })
}

function revokeRecord(runtime, record, { disable = true } = {}) {
  if (record.revokePromise) return record.revokePromise
  if (record.revoked) return Promise.resolve(true)
  if (disable && !runtime.state.closed) record.disableRequested = true
  markRecordStopping(runtime, record)
  const operation = (async () => {
    await record.runPromise
    await releaseRecordLease(runtime, record)
    if (record.disableRequested) {
      await runtime.operations.disableAgentEventSubscription(record.subscriptionKey, {
        now: runtime.now(),
      })
    }
    return true
  })()
  record.revokePromise = operation.then((value) => {
    record.revoked = true
    if (runtime.records.get(record.subscriptionKey) === record) {
      runtime.records.delete(record.subscriptionKey)
    }
    return value
  }, (error) => {
    record.revokePromise = null
    throw error
  })
  return record.revokePromise
}

function registerConsumer(runtime, definition = {}, options = undefined) {
  if (runtime.state.closed) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_CLOSED',
      'durable Agent Event consumer host is closed',
    )
  }
  const resetToCurrent = resetToCurrentRegistrationOption(options)
  const listener = normalizeDurableAgentEventListener(definition.listener)
  let subscription = runtime.operations.ensureAgentEventSubscription(definition)
  const subscriptionKey = subscription?.subscriptionKey
  const subscriptionUserId = subscription?.userId
  if (typeof subscriptionKey !== 'string' || !/^[a-f0-9]{64}$/u.test(subscriptionKey)) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_STORE_INVALID',
      'durable Agent Event store returned an invalid subscription key',
    )
  }
  if (typeof subscriptionUserId !== 'string' || !subscriptionUserId) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_STORE_INVALID',
      'durable Agent Event store returned a subscription without an owner',
    )
  }
  if (subscription.status === 'disabled') {
    subscription = runtime.operations.enableAgentEventSubscription(subscriptionKey, {
      now: runtime.now(), resetToCurrent,
    })
  }
  if (runtime.records.has(subscriptionKey)) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_CONSUMER_DUPLICATE',
      `durable Agent Event subscription ${subscriptionKey} is already registered`,
    )
  }
  let signalStopping
  const stoppingPromise = new Promise((resolve) => { signalStopping = resolve })
  const record = {
    subscriptionKey,
    userId: subscriptionUserId,
    eventType: subscription.eventType,
    listener,
    lease: null,
    runPromise: null,
    revokePromise: null,
    revoked: false,
    disableRequested: false,
    infrastructureFailures: 0,
    stopping: false,
    stoppingAt: null,
    abandoned: false,
    stoppingPromise,
    signalStopping,
    wake: null,
  }
  runtime.records.set(subscriptionKey, record)
  launchRecord(runtime, record)
  return Object.freeze({
    subscriptionKey,
    contractVersion: subscription.contractVersion,
    eventType: subscription.eventType,
    ...(subscription.reset ? { reset: subscription.reset } : {}),
    revoke: () => revokeRecord(runtime, record),
  })
}

function startHost(runtime) {
  if (runtime.state.closed) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_CLOSED',
      'durable Agent Event consumer host is closed',
    )
  }
  if (runtime.state.started) return false
  runtime.state.started = true
  runtime.retentionScheduler.start()
  for (const record of runtime.records.values()) launchRecord(runtime, record)
  return true
}

function notifyConsumers(runtime, eventType = null) {
  if (!runtime.state.started || runtime.state.closed) return 0
  let notified = 0
  for (const record of runtime.records.values()) {
    if (eventType === null || record.eventType === eventType) {
      notified += 1
      wakeRecord(record)
      launchRecord(runtime, record)
    }
  }
  return notified
}

function shutdownHost(runtime) {
  if (runtime.state.shutdownPromise) return runtime.state.shutdownPromise
  runtime.state.closed = true
  runtime.state.started = false
  runtime.retentionScheduler.stop()
  const operation = Promise.all([...runtime.records.values()].map((record) => (
    revokeRecord(runtime, record, { disable: false })
  ))).then(() => true)
  const tracked = operation.catch((error) => {
    if (runtime.state.shutdownPromise === tracked) runtime.state.shutdownPromise = null
    throw error
  })
  runtime.state.shutdownPromise = tracked
  return tracked
}

/** Host for the v2 durable Agent Event contract. */
export function createDurableAgentEventConsumerHost({
  store,
  ownerId = `agent-event-consumer:${process.pid}:${randomUUID()}`,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  idlePollMs = DEFAULT_IDLE_POLL_MS,
  scanLimit = DEFAULT_SCAN_LIMIT,
  listenerDrainTimeoutMs = DEFAULT_LISTENER_DRAIN_TIMEOUT_MS,
  retentionIntervalMs = DEFAULT_RETENTION_INTERVAL_MS,
  now = Date.now,
  random = Math.random,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  onDeliveryFailure = null,
  onHostError = null,
} = {}) {
  const operations = snapshotDurableAgentEventStore(store)
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 256) {
    throw durableHostError('AGENT_EVENT_DURABLE_HOST_INVALID', 'ownerId is invalid')
  }
  const owner = ownerId.trim()
  const leaseMs = positiveHostInteger(leaseDurationMs, 'leaseDurationMs', 3_600_000)
  const pollMs = positiveHostInteger(idlePollMs, 'idlePollMs', MAX_AGENT_EVENT_HOST_DELAY_MS)
  const pageLimit = positiveHostInteger(scanLimit, 'scanLimit', 1_000)
  const drainMs = positiveHostInteger(
    listenerDrainTimeoutMs, 'listenerDrainTimeoutMs', MAX_AGENT_EVENT_HOST_DELAY_MS,
  )
  const retentionMs = positiveHostInteger(
    retentionIntervalMs, 'retentionIntervalMs', MAX_AGENT_EVENT_HOST_DELAY_MS,
  )
  for (const [field, value] of Object.entries({ now, random, schedule, cancelSchedule })) {
    if (typeof value !== 'function' || utilTypes.isProxy(value)) {
      throw durableHostError('AGENT_EVENT_DURABLE_HOST_INVALID', `${field} must be a function`)
    }
  }
  for (const [field, value] of Object.entries({ onDeliveryFailure, onHostError })) {
    if (value !== null && (typeof value !== 'function' || utilTypes.isProxy(value))) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_HOST_INVALID',
        `${field} must be a non-Proxy function or null`,
      )
    }
  }
  const runtime = {
    operations, owner, leaseMs, pollMs, pageLimit, drainMs, now, random,
    schedule, cancelSchedule, onDeliveryFailure, onHostError,
    records: new Map(),
    state: { started: false, closed: false, shutdownPromise: null },
    retentionScheduler: null,
    runRecord: null,
  }
  runtime.retentionScheduler = createDurableAgentEventRetentionScheduler({
    truncate: operations.truncateAgentEventOutboxToSafeWatermark,
    now,
    schedule,
    cancelSchedule,
    intervalMs: retentionMs,
    onError: (error) => reportRetentionError(runtime, error),
  })
  runtime.runRecord = createDurableAgentEventConsumerRunner({
    operations,
    owner,
    leaseMs,
    pollMs,
    pageLimit,
    now,
    random,
    isRunning: (record) => runtime.state.started
      && !runtime.state.closed && !record.stopping && !record.abandoned,
    waitForWake: (record, delay) => waitForRecordWake(runtime, record, delay),
    renewLeaseIfNeeded: (record) => renewRecordLease(runtime, record),
    invokeListenerWithLeaseHeartbeat: (record, envelope) => (
      invokeListenerWithHeartbeat(runtime, record, envelope)
    ),
    releaseLease: (record) => releaseRecordLease(runtime, record),
    markStopping: (record) => markRecordStopping(runtime, record),
    onDeliveryFailure,
    onHostError,
  })
  return Object.freeze({
    contractVersion: 2,
    register: (definition, options) => registerConsumer(runtime, definition, options),
    start: () => startHost(runtime),
    notify: (eventType = null) => notifyConsumers(runtime, eventType),
    listConsumers: () => Object.freeze([...runtime.records.values()]
      .filter((record) => !record.stopping)
      .map((record) => Object.freeze({
        subscriptionKey: record.subscriptionKey,
        eventType: record.eventType,
        running: Boolean(record.runPromise),
        leased: Boolean(record.lease),
      }))),
    shutdown: () => shutdownHost(runtime),
  })
}
