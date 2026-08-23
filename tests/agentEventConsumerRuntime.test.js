import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
} from '../server/core/agentEventConsumerHost.js'
import {
  agentEventConsumerHost,
  publishAgentEventEnvelope,
  publishCommittedAgentEvent,
} from '../server/core/agentEventConsumerRuntime.js'
import {
  createTurnEvent,
  createTurnEventTransportEnvelope,
} from '../shared/turnEvents.js'

test('Agent Event live deduplication is scoped by user without exposing userId', async () => {
  const received = []
  const event = createTurnEvent({
    id: 'tenant-scoped-live-event',
    sessionId: 'shared-imported-session',
    turnId: 'shared-imported-turn',
    sequence: 0,
    type: 'turn.started',
    payload: { content: 'local event', userMessageId: 'shared-user-message' },
    createdAt: 1_000,
  })
  const registration = agentEventConsumerHost.register({
    id: 'test.agent-event.tenant-scope',
    contractVersion: AGENT_EVENT_CONSUMER_CONTRACT_VERSION,
    eventTypes: ['turn.started'],
    listener: (envelope) => received.push(envelope),
  })

  try {
    const envelope = createTurnEventTransportEnvelope(event)
    await publishAgentEventEnvelope(envelope, { userId: 'tenant-a' })
    await publishCommittedAgentEvent({ userId: 'tenant-a', event })
    await publishCommittedAgentEvent({ userId: 'tenant-b', event })

    assert.equal(received.length, 2)
    assert.deepEqual(received.map((value) => value.event.id), [event.id, event.id])
    for (const value of received) {
      assert.equal(Object.hasOwn(value, 'userId'), false)
      assert.equal(Object.hasOwn(value.event, 'userId'), false)
    }
  } finally {
    await registration.revoke()
  }
})

test('Agent Event publication fails closed without an explicit user scope', () => {
  const event = createTurnEvent({
    id: 'missing-tenant-live-event',
    sessionId: 'missing-tenant-session',
    turnId: 'missing-tenant-turn',
    sequence: 0,
    type: 'turn.started',
    payload: { content: 'local event', userMessageId: 'missing-tenant-message' },
    createdAt: 1_001,
  })

  assert.throws(
    () => publishAgentEventEnvelope(createTurnEventTransportEnvelope(event)),
    /userId is required to publish an Agent Event/u,
  )
})
