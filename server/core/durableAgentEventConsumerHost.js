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
  try {
    keys = Reflect.ownKeys(options)
  } catch {
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

/**
 * Host for the v2 durable Agent Event contract.
 *
 * The host owns only orchestration. The injected store remains the sole
 * authority for immutable subscription identity, cursor state, fencing,
 * retries, DLQ transitions, and retention. A listener receives only the
 * detached plugin-safe transport envelope; tenant identity stays inside the
 * host/store boundary.
 */
export function createDurableAgentEventConsumerHost({
  store,
  ownerId = `agent-event-consumer:${process.pid}:${randomUUID()}`,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  idlePollMs = DEFAULT_IDLE_POLL_MS,
  scanLimit = DEFAULT_SCAN_LIMIT,
  listenerDrainTimeoutMs = DEFAULT_LISTENER_DRAIN_TIMEOUT_MS,
  retentionIntervalMs = DEFAULT_RETENTION_INTERVAL_MS,
  now = Date.now,
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
  const pollMs = positiveHostInteger(
    idlePollMs,
    'idlePollMs',
    MAX_AGENT_EVENT_HOST_DELAY_MS,
  )
  const pageLimit = positiveHostInteger(scanLimit, 'scanLimit', 1_000)
  const drainMs = positiveHostInteger(
    listenerDrainTimeoutMs,
    'listenerDrainTimeoutMs',
    MAX_AGENT_EVENT_HOST_DELAY_MS,
  )
  const retentionMs = positiveHostInteger(
    retentionIntervalMs,
    'retentionIntervalMs',
    MAX_AGENT_EVENT_HOST_DELAY_MS,
  )
  for (const [field, value] of Object.entries({ now, schedule, cancelSchedule })) {
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

  const records = new Map()
  let started = false
  let closed = false
  let shutdownPromise = null

  const wake = (record) => {
    const waiter = record.wake
    record.wake = null
    waiter?.()
  }

  const markStopping = (record) => {
    if (record.stopping) return false
    record.stopping = true
    record.stoppingAt = now()
    const signalStopping = record.signalStopping
    record.signalStopping = null
    signalStopping?.()
    wake(record)
    return true
  }

  const waitForWake = (record, delayMs) => {
    if (record.stopping || closed || !started) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer !== null) cancelSchedule(timer)
        if (record.wake === wakeNow) record.wake = null
        resolve(value)
      }
      const wakeNow = () => finish(true)
      record.wake = wakeNow
      timer = schedule(() => finish(false), boundedAgentEventHostDelay(delayMs, pollMs))
    })
  }

  const scheduledWait = (delayMs) => {
    let settled = false
    let timer = null
    let settle
    const promise = new Promise((resolve) => {
      settle = resolve
      timer = schedule(() => {
        if (settled) return
        settled = true
        resolve(true)
      }, boundedAgentEventHostDelay(delayMs, pollMs))
    })
    return Object.freeze({
      promise,
      cancel() {
        if (settled) return false
        settled = true
        if (timer !== null) {
          try {
            cancelSchedule(timer)
          } catch {
            // Cancelling an already-settled heartbeat is best effort only.
          }
        }
        settle(false)
        return true
      },
    })
  }

  const reportRetentionError = (error) => {
    observeAgentEventHost(onHostError, {
      code: safeAgentEventFailureCode(error, 'AGENT_EVENT_RETENTION_FAILED'),
      phase: 'retention',
      subscriptionKey: null,
    })
  }
  const retentionScheduler = createDurableAgentEventRetentionScheduler({
    truncate: operations.truncateAgentEventOutboxToSafeWatermark,
    now,
    schedule,
    cancelSchedule,
    intervalMs: retentionMs,
    onError: reportRetentionError,
  })

  const releaseLease = async (record) => {
    const token = record.lease
    record.lease = null
    if (!token) return false
    try {
      await operations.releaseAgentEventSubscriptionLease(token, { now: now() })
      return true
    } catch (error) {
      // An expired/fenced token is already unusable. Report it without
      // replacing a more useful listener or scan failure.
      observeAgentEventHost(onHostError, {
        code: safeAgentEventFailureCode(error),
        phase: 'release',
        subscriptionKey: record.subscriptionKey,
      })
      return false
    }
  }

  const renewLeaseIfNeeded = async (record) => {
    const token = record.lease
    if (!token) return null
    const timestamp = now()
    if (Number(token.expiresAt) - timestamp > Math.floor(leaseMs / 2)) return token
    record.lease = await operations.renewAgentEventSubscriptionLease(token, {
      now: timestamp,
      leaseDurationMs: leaseMs,
    })
    return record.lease
  }

  const invokeListenerWithLeaseHeartbeat = async (record, envelope) => {
    let completion
    try {
      completion = record.listener(envelope)
    } catch (error) {
      return Object.freeze({ listenerFailure: error, leaseFailure: null })
    }
    if (!utilTypes.isPromise(completion)) {
      return Object.freeze({ listenerFailure: null, leaseFailure: null })
    }

    // Attach both handlers before starting the heartbeat so a plugin Promise
    // can never surface as an unhandled rejection while a renewal is pending.
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
        : heartbeat || scheduledWait(Math.max(
          1,
          Math.floor(Math.max(1, Number(record.lease?.expiresAt) - now()) / 2),
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
      } else {
        outcomes.push(stoppingOutcome)
      }
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
        const elapsed = Math.max(0, now() - Number(record.stoppingAt ?? now()))
        drain ||= scheduledWait(Math.max(0, drainMs - elapsed))
        continue
      }
      if (outcome.kind === 'drain-timeout') {
        heartbeat?.cancel()
        return Object.freeze({
          listenerFailure: null,
          leaseFailure,
          abandoned: true,
        })
      }
      if (outcome.error) {
        leaseFailure ||= outcome.error
        drain ||= scheduledWait(drainMs)
        continue
      }
      heartbeat = null
      try {
        record.lease = await operations.renewAgentEventSubscriptionLease(record.lease, {
          now: now(),
          leaseDurationMs: leaseMs,
        })
      } catch (error) {
        // The callback cannot be cancelled safely. Stop renewing and give it
        // the same bounded drain window before the event becomes replayable.
        leaseFailure ||= error
        drain ||= scheduledWait(drainMs)
      }
    }
  }

  const runRecord = async (record) => {
    while (started && !closed && !record.stopping && !record.abandoned) {
      let nextDelay = pollMs
      try {
        record.lease = await operations.acquireAgentEventSubscriptionLease(
          record.subscriptionKey,
          { owner, now: now(), leaseDurationMs: leaseMs },
        )
        if (!record.lease) {
          await waitForWake(record, pollMs)
          continue
        }

        while (started && !closed && !record.stopping && !record.abandoned) {
          const token = await renewLeaseIfNeeded(record)
          const page = await operations.scanAgentEventSubscription(token, {
            now: now(),
            limit: pageLimit,
          })
          if (!page?.entry) {
            if (page?.retryAt == null && page?.hasMore === true) {
              // scannedCursor already advanced past this page. Continue under
              // the same lease instead of adding one idle poll per unrelated
              // page in a large global backlog.
              continue
            }
            nextDelay = page?.retryAt == null
              ? pollMs
              : boundedAgentEventHostDelay(Number(page.retryAt) - now(), pollMs)
            break
          }

          const entry = page.entry
          const { listenerFailure, leaseFailure, abandoned } = await invokeListenerWithLeaseHeartbeat(
            record,
            entry.envelope,
          )
          if (abandoned) {
            record.abandoned = true
            markStopping(record)
            observeAgentEventHost(onHostError, {
              code: 'AGENT_EVENT_LISTENER_DRAIN_TIMEOUT',
              phase: 'drain',
              subscriptionKey: record.subscriptionKey,
            })
            break
          }
          if (leaseFailure) throw leaseFailure
          if (listenerFailure) {
            const failureCode = safeAgentEventFailureCode(listenerFailure)
            const failed = await operations.failAgentEventSubscription(record.lease, {
              cursor: entry.cursor,
              failureCode,
              now: now(),
            })
            observeAgentEventHost(onDeliveryFailure, {
              code: 'AGENT_EVENT_DURABLE_DELIVERY_FAILED',
              failureCode,
              subscriptionKey: record.subscriptionKey,
              eventId: entry.eventId,
              eventType: entry.eventType,
              cursor: entry.cursor,
              attempt: failed.attempt,
              deadLettered: failed.deadLettered === true,
            })
            if (!failed.deadLettered) {
              nextDelay = boundedAgentEventHostDelay(Number(failed.retryAt) - now(), pollMs)
              break
            }
            continue
          }
          // ACK errors (especially a fenced lease) deliberately escape to the
          // outer host boundary. Recording them as listener failures could
          // consume or dead-letter an event whose callback actually succeeded.
          await operations.acknowledgeAgentEventSubscription(record.lease, {
            cursor: entry.cursor,
            now: now(),
          })
        }
      } catch (error) {
        observeAgentEventHost(onHostError, {
          code: safeAgentEventFailureCode(error),
          phase: 'consume',
          subscriptionKey: record.subscriptionKey,
        })
      } finally {
        await releaseLease(record)
      }
      if (started && !closed && !record.stopping && !record.abandoned) {
        await waitForWake(record, nextDelay)
      }
    }
    await releaseLease(record)
    return true
  }

  const launch = (record) => {
    if (!started || closed || record.stopping || record.abandoned || record.runPromise) return
    record.runPromise = runRecord(record).finally(() => {
      record.runPromise = null
    })
  }

  const revokeRecord = (record, { disable = true } = {}) => {
    if (record.revokePromise) return record.revokePromise
    if (record.revoked) return Promise.resolve(true)
    // Once an explicit uninstall starts, shutdown cannot downgrade it into a
    // process-only drain. Retain this intent across cleanup failures/retries.
    if (disable && !closed) record.disableRequested = true
    markStopping(record)
    const operation = (async () => {
      await record.runPromise
      await releaseLease(record)
      if (record.disableRequested) {
        await operations.disableAgentEventSubscription(record.subscriptionKey, { now: now() })
      }
      return true
    })()
    record.revokePromise = operation.then((value) => {
      record.revoked = true
      if (records.get(record.subscriptionKey) === record) records.delete(record.subscriptionKey)
      return value
    }, (error) => {
      record.revokePromise = null
      throw error
    })
    return record.revokePromise
  }

  const register = (definition = {}, options = undefined) => {
    if (closed) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_HOST_CLOSED',
        'durable Agent Event consumer host is closed',
      )
    }
    const resetToCurrent = resetToCurrentRegistrationOption(options)
    const listener = normalizeDurableAgentEventListener(definition.listener)
    let subscription = operations.ensureAgentEventSubscription(definition)
    const subscriptionKey = subscription?.subscriptionKey
    if (typeof subscriptionKey !== 'string' || !/^[a-f0-9]{64}$/u.test(subscriptionKey)) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_STORE_INVALID',
        'durable Agent Event store returned an invalid subscription key',
      )
    }
    if (subscription.status === 'disabled') {
      subscription = operations.enableAgentEventSubscription(subscriptionKey, {
        now: now(),
        resetToCurrent,
      })
    }
    if (records.has(subscriptionKey)) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_CONSUMER_DUPLICATE',
        `durable Agent Event subscription ${subscriptionKey} is already registered`,
      )
    }
    let signalStopping
    const stoppingPromise = new Promise((resolve) => {
      signalStopping = resolve
    })
    const record = {
      subscriptionKey,
      eventType: subscription.eventType,
      listener,
      lease: null,
      runPromise: null,
      revokePromise: null,
      revoked: false,
      disableRequested: false,
      stopping: false,
      stoppingAt: null,
      abandoned: false,
      stoppingPromise,
      signalStopping,
      wake: null,
    }
    records.set(subscriptionKey, record)
    launch(record)
    return Object.freeze({
      subscriptionKey,
      contractVersion: subscription.contractVersion,
      eventType: subscription.eventType,
      ...(subscription.reset ? { reset: subscription.reset } : {}),
      revoke: () => revokeRecord(record),
    })
  }

  const start = () => {
    if (closed) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_HOST_CLOSED',
        'durable Agent Event consumer host is closed',
      )
    }
    if (started) return false
    started = true
    retentionScheduler.start()
    for (const record of records.values()) launch(record)
    return true
  }

  const notify = (eventType = null) => {
    if (!started || closed) return 0
    let notified = 0
    for (const record of records.values()) {
      if (eventType === null || record.eventType === eventType) {
        notified += 1
        wake(record)
        launch(record)
      }
    }
    return notified
  }

  const listConsumers = () => Object.freeze([...records.values()]
    .filter((record) => !record.stopping)
    .map((record) => Object.freeze({
      subscriptionKey: record.subscriptionKey,
      eventType: record.eventType,
      running: Boolean(record.runPromise),
      leased: Boolean(record.lease),
    })))

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise
    closed = true
    started = false
    retentionScheduler.stop()
    const active = [...records.values()]
    const operation = Promise.all(active.map((record) => (
      revokeRecord(record, { disable: false })
    ))).then(() => true)
    const tracked = operation.catch((error) => {
      if (shutdownPromise === tracked) shutdownPromise = null
      throw error
    })
    shutdownPromise = tracked
    return shutdownPromise
  }

  return Object.freeze({
    contractVersion: 2,
    register,
    start,
    notify,
    listConsumers,
    shutdown,
  })
}
