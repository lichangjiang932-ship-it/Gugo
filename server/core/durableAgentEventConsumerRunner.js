import {
  boundedAgentEventHostDelay,
  observeAgentEventHost,
  safeAgentEventFailureCode,
} from './durableAgentEventConsumerHostSupport.js'

const INFRASTRUCTURE_FAILURE_LIMIT = 5
const MAX_INFRASTRUCTURE_BACKOFF_MS = 300_000
const POISON_EVENT_CODES = new Set(['AGENT_EVENT_OUTBOX_CORRUPT'])

function infrastructureDelay({ failures, pollMs, random }) {
  const exponential = Math.min(
    MAX_INFRASTRUCTURE_BACKOFF_MS,
    pollMs * (2 ** Math.min(20, Math.max(0, failures - 1))),
  )
  const jitter = 0.75 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5)
  return boundedAgentEventHostDelay(Math.max(1, Math.round(exponential * jitter)), pollMs)
}

export function createDurableAgentEventConsumerRunner({
  operations,
  owner,
  leaseMs,
  pollMs,
  pageLimit,
  now,
  random,
  isRunning,
  waitForWake,
  renewLeaseIfNeeded,
  invokeListenerWithLeaseHeartbeat,
  releaseLease,
  markStopping,
  onDeliveryFailure,
  onHostError,
}) {
  return async function runRecord(record) {
    while (isRunning(record)) {
      let nextDelay = pollMs
      try {
        record.lease = await operations.acquireAgentEventSubscriptionLease(
          record.subscriptionKey,
          { userId: record.userId, owner, now: now(), leaseDurationMs: leaseMs },
        )
        if (!record.lease) {
          record.infrastructureFailures = 0
          await waitForWake(record, pollMs)
          continue
        }

        while (isRunning(record)) {
          const token = await renewLeaseIfNeeded(record)
          const page = await operations.scanAgentEventSubscription(token, {
            now: now(),
            limit: pageLimit,
          })
          record.infrastructureFailures = 0
          if (!page?.entry) {
            if (page?.retryAt == null && page?.hasMore === true) continue
            nextDelay = page?.retryAt == null
              ? pollMs
              : boundedAgentEventHostDelay(Number(page.retryAt) - now(), pollMs)
            break
          }

          const entry = page.entry
          const outcome = await invokeListenerWithLeaseHeartbeat(record, entry.envelope)
          if (outcome.abandoned) {
            record.abandoned = true
            record.disableRequested = true
            markStopping(record)
            observeAgentEventHost(onHostError, {
              code: 'AGENT_EVENT_LISTENER_DRAIN_TIMEOUT',
              phase: 'drain',
              subscriptionKey: record.subscriptionKey,
            })
            break
          }
          if (outcome.leaseFailure) throw outcome.leaseFailure
          if (outcome.listenerFailure) {
            const failureCode = safeAgentEventFailureCode(outcome.listenerFailure)
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
          await operations.acknowledgeAgentEventSubscription(record.lease, {
            cursor: entry.cursor,
            now: now(),
          })
          record.infrastructureFailures = 0
        }
      } catch (error) {
        const code = safeAgentEventFailureCode(error)
        record.infrastructureFailures += 1
        const poisonEvent = POISON_EVENT_CODES.has(code)
        const circuitOpen = record.infrastructureFailures >= INFRASTRUCTURE_FAILURE_LIMIT
        if (poisonEvent || circuitOpen) {
          record.abandoned = true
          record.disableRequested = true
          markStopping(record)
        } else {
          nextDelay = infrastructureDelay({
            failures: record.infrastructureFailures,
            pollMs,
            random,
          })
        }
        observeAgentEventHost(onHostError, {
          code,
          phase: poisonEvent ? 'poison-event' : circuitOpen ? 'consume-circuit-open' : 'consume',
          subscriptionKey: record.subscriptionKey,
          attempt: record.infrastructureFailures,
          retryInMs: poisonEvent || circuitOpen ? null : nextDelay,
        })
      } finally {
        await releaseLease(record)
      }
      if (record.abandoned && record.disableRequested) {
        try {
          await operations.disableAgentEventSubscription(record.subscriptionKey, { now: now() })
          record.disableRequested = false
        } catch (error) {
          observeAgentEventHost(onHostError, {
            code: safeAgentEventFailureCode(error, 'AGENT_EVENT_SUBSCRIPTION_DISABLE_FAILED'),
            phase: 'abandon-disable',
            subscriptionKey: record.subscriptionKey,
          })
        }
      }
      if (isRunning(record)) await waitForWake(record, nextDelay)
    }
    await releaseLease(record)
    return true
  }
}

export { INFRASTRUCTURE_FAILURE_LIMIT, MAX_INFRASTRUCTURE_BACKOFF_MS }
