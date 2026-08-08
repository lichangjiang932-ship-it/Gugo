import assert from 'node:assert/strict'
import test from 'node:test'
import { pollTurnSubscriptions, subscribeTurnSubscription } from '../server/services/turnWebSocket.js'

test('turn WebSocket polling isolates a failed subscription and continues delivering others', () => {
  const broken = { sessionId: 'session-broken', turnId: 'turn-broken', cursor: 3 }
  const healthy = { sessionId: 'session-healthy', turnId: 'turn-healthy', cursor: 7 }
  const subscriptions = new Map([
    ['broken', broken],
    ['healthy', healthy],
  ])
  const failure = new Error('database temporarily unavailable')
  const errors = []
  const deliveries = []

  assert.doesNotThrow(() => pollTurnSubscriptions({
    subscriptions,
    userId: 'user-1',
    listEvents: ({ turnId }) => {
      if (turnId === 'turn-broken') throw failure
      return [{ id: 'event-8', sequence: 8 }]
    },
    deliver: (subscription, event) => deliveries.push([subscription.turnId, event.id]),
    onError: (error, subscription) => errors.push([error, subscription.turnId]),
  }))

  assert.deepEqual(errors, [[failure, 'turn-broken']])
  assert.deepEqual(deliveries, [['turn-healthy', 'event-8']])
})

test('turn WebSocket subscription cleans up when the initial durable replay fails', () => {
  let previousUnsubscribes = 0
  let newUnsubscribes = 0
  const key = 'session-1\u0000turn-1'
  const subscriptions = new Map([[
    key,
    { unsubscribe: () => { previousUnsubscribes += 1 } },
  ]])
  const failure = new Error('database temporarily unavailable')

  assert.throws(() => subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    after: -1,
    deliver: () => {},
    subscribe: () => () => { newUnsubscribes += 1 },
    listEvents: () => { throw failure },
  }), failure)

  assert.equal(previousUnsubscribes, 1)
  assert.equal(newUnsubscribes, 1)
  assert.equal(subscriptions.has(key), false)
})

test('turn WebSocket subscription leaves no stale entry when listener setup fails', () => {
  const key = 'session-2\u0000turn-2'
  const subscriptions = new Map()
  const failure = new Error('listener unavailable')

  assert.throws(() => subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-2',
    turnId: 'turn-2',
    after: -1,
    deliver: () => {},
    subscribe: () => { throw failure },
    listEvents: () => [],
  }), failure)

  assert.equal(subscriptions.has(key), false)
})
