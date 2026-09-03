import { createDurableAgentEventConsumerHost } from '../core/durableAgentEventConsumerHost.js'
import * as subscriptionStore from './agentEventSubscriptionStore.js'

let runtimeHost = null
let closing = null

function currentHost() {
  if (!runtimeHost) {
    runtimeHost = createDurableAgentEventConsumerHost({ store: subscriptionStore })
  }
  return runtimeHost
}

/** Stable plugin-facing facade; the process host itself may be recreated in tests. */
export const durableAgentEventConsumerHost = Object.freeze({
  contractVersion: 2,
  register(definition, options) {
    return currentHost().register(definition, options)
  },
})

export function startAgentEventDurableConsumerRuntime() {
  if (closing) {
    const error = new Error('durable Agent Event consumer runtime is shutting down')
    error.code = 'AGENT_EVENT_DURABLE_RUNTIME_SHUTTING_DOWN'
    error.retryable = true
    throw error
  }
  return currentHost().start()
}

export function notifyAgentEventDurableConsumers(eventType = null) {
  return runtimeHost?.notify(eventType) || 0
}

export function listAgentEventDurableConsumers() {
  return runtimeHost?.listConsumers() || Object.freeze([])
}

export function closeAgentEventDurableConsumerRuntime() {
  if (closing) return closing
  if (!runtimeHost) return Promise.resolve(false)
  const closingHost = runtimeHost
  closing = closingHost.shutdown().then(() => {
    if (runtimeHost === closingHost) runtimeHost = null
    closing = null
    return true
  }, (error) => {
    closing = null
    throw error
  })
  return closing
}
