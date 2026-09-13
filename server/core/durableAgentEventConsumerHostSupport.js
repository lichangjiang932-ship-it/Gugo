// @ts-check

import { types as utilTypes } from 'node:util'

/** @typedef {import('../../types/kernel-ports.js').DurableAgentEventHostError} DurableAgentEventHostError */
/** @typedef {import('../../types/kernel-ports.js').DurableAgentEventListener} DurableAgentEventListener */
/** @typedef {import('../../types/kernel-ports.js').DurableAgentEventObserver} DurableAgentEventObserver */
/** @typedef {import('../../types/kernel-ports.js').DurableAgentEventStore} DurableAgentEventStore */
/** @typedef {import('../../types/kernel-ports.js').DurableAgentEventStoreSnapshot} DurableAgentEventStoreSnapshot */

export const MAX_AGENT_EVENT_HOST_DELAY_MS = 2_147_483_647

/** @type {readonly (keyof DurableAgentEventStore)[]} */
const REQUIRED_STORE_METHODS = Object.freeze([
  'ensureAgentEventSubscription',
  'enableAgentEventSubscription',
  'disableAgentEventSubscription',
  'acquireAgentEventSubscriptionLease',
  'renewAgentEventSubscriptionLease',
  'releaseAgentEventSubscriptionLease',
  'scanAgentEventSubscription',
  'acknowledgeAgentEventSubscription',
  'failAgentEventSubscription',
  'truncateAgentEventOutboxToSafeWatermark',
])

/** @param {string} code @param {string} message @returns {DurableAgentEventHostError} */
export function durableHostError(code, message) {
  return Object.assign(new TypeError(message), { code, retryable: /** @type {const} */ (false) })
}

/** @param {unknown} value @param {string} field @param {number} [maximum] */
export function positiveHostInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      `${field} must be a positive safe integer`,
    )
  }
  return number
}

/** @param {DurableAgentEventStore} store @returns {DurableAgentEventStoreSnapshot} */
export function snapshotDurableAgentEventStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store) || utilTypes.isProxy(store)) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_HOST_INVALID',
      'durable Agent Event consumer host requires a non-Proxy store',
    )
  }
  const snapshot = /** @type {Partial<DurableAgentEventStore>} */ ({})
  for (const name of REQUIRED_STORE_METHODS) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(store, name)
    } catch {
      descriptor = null
    }
    if (!descriptor
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function'
      || utilTypes.isProxy(descriptor.value)) {
      throw durableHostError(
        'AGENT_EVENT_DURABLE_HOST_INVALID',
        `durable Agent Event store requires own function ${name}`,
      )
    }
    snapshot[name] = descriptor.value
  }
  return Object.freeze(/** @type {DurableAgentEventStore} */ (snapshot))
}

/** @param {unknown} value @returns {DurableAgentEventListener} */
export function normalizeDurableAgentEventListener(value) {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    throw durableHostError(
      'AGENT_EVENT_DURABLE_CONSUMER_INVALID',
      'durable Agent Event listener must be a non-Proxy function',
    )
  }
  return /** @type {DurableAgentEventListener} */ (value)
}

/** @param {unknown} error @param {string} [fallback] @returns {string} */
export function safeAgentEventFailureCode(error, fallback = 'AGENT_EVENT_DELIVERY_FAILED') {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')
    || utilTypes.isProxy(error)) return fallback
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    const value = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : null
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
      ? value
      : fallback
  } catch {
    return fallback
  }
}

/** @param {DurableAgentEventObserver} callback @param {Record<string, unknown>} entry */
export function observeAgentEventHost(callback, entry) {
  if (!callback) return
  try {
    const result = callback(Object.freeze(entry))
    if (utilTypes.isPromise(result)) {
      Promise.prototype.then.call(result, undefined, () => {})
    }
  } catch {
    // Observability cannot change delivery correctness.
  }
}

/** @param {unknown} value @param {number} fallback @returns {number} */
export function boundedAgentEventHostDelay(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(MAX_AGENT_EVENT_HOST_DELAY_MS, Math.floor(number)))
}
