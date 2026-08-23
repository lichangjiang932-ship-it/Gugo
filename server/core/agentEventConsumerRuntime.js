import {
  createTurnEventTransportEnvelope,
  parseTurnEventTransportEnvelope,
} from '../../shared/turnEvents.js'
import { projectTurnEventForClient } from '../../shared/turnEventProjection.js'
import { createAgentEventConsumerHost } from './agentEventConsumerHost.js'

const MAX_LIVE_EVENT_IDENTITIES = 100_000
const publishedEventIdentities = new Map()

// One process-level host is the only live Agent Event fan-out authority. Runtime
// plugin registries may receive an isolated host through their explicit host
// options in tests, while production persistence and plugins share this one.
export const agentEventConsumerHost = createAgentEventConsumerHost()

function scopedEventIdentity(userId, event) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId is required to publish an Agent Event')
  }
  return JSON.stringify([
    userId,
    event.sessionId,
    event.turnId,
    event.sequence,
    event.id,
  ])
}

export function publishAgentEventEnvelope(envelope, { userId } = {}) {
  const canonical = parseTurnEventTransportEnvelope(envelope)
  const event = canonical.event
  // Tenant identity is deliberately kept outside the plugin-facing envelope.
  // It only scopes the in-process suppression of Store/emitter double publish.
  const identity = scopedEventIdentity(userId, event)
  if (publishedEventIdentities.has(identity)) {
    return Promise.resolve(Object.freeze({
      eventId: event.id,
      eventType: event.type,
      eventSequence: event.sequence,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }))
  }
  const delivery = agentEventConsumerHost.publish(canonical)
  publishedEventIdentities.set(identity, true)
  if (publishedEventIdentities.size > MAX_LIVE_EVENT_IDENTITIES) {
    const oldest = publishedEventIdentities.keys().next().value
    publishedEventIdentities.delete(oldest)
  }
  return delivery
}

export function publishCommittedAgentEvent({ userId, event } = {}) {
  const clientEvent = projectTurnEventForClient(event)
  return publishAgentEventEnvelope(createTurnEventTransportEnvelope(clientEvent), { userId })
}
