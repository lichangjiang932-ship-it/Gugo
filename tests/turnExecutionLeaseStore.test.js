import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-turn-execution-lease-tests', String(process.pid))

const { issueTestSession } = await import('./helpers/testAuth.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const {
  claimTurnExecutionLease,
  getTurnExecutionLease,
  isTurnExecutionLeaseActive,
  releaseTurnExecutionLease,
  renewTurnExecutionLease,
  requestTurnExecutionCancellation,
  tryCloseTurnSteeringInbox,
} = await import('../server/services/turnExecutionLeaseStore.js')
const {
  acknowledgeTurnSteering,
  claimTurnSteering,
  enqueueTurnSteering,
} = await import('../server/services/turnSteeringStore.js')

test('turn execution lease is exclusive, renewable, cancellable, and recoverable', () => {
  const { userId } = issueTestSession()
  const scope = { userId, sessionId: 'turn-lease-session', turnId: 'turn-lease' }
  upsertSession({ id: scope.sessionId, userId, title: 'lease' })

  assert.equal(claimTurnExecutionLease({ ...scope, ownerId: 'worker-a', now: 1_000, leaseMs: 2_000 }), true)
  assert.equal(getTurnExecutionLease(scope).acceptingSteering, true)
  assert.equal(claimTurnExecutionLease({ ...scope, ownerId: 'worker-b', now: 2_000, leaseMs: 2_000 }), false)
  assert.equal(isTurnExecutionLeaseActive(scope, 2_999), true)
  assert.deepEqual(
    renewTurnExecutionLease({ ...scope, ownerId: 'worker-a', now: 2_000, leaseMs: 2_000 }),
    { renewed: true, cancelRequested: false },
  )
  assert.equal(requestTurnExecutionCancellation({ ...scope, now: 2_500 }), true)
  assert.deepEqual(
    renewTurnExecutionLease({ ...scope, ownerId: 'worker-a', now: 3_000, leaseMs: 2_000 }),
    { renewed: true, cancelRequested: true },
  )
  assert.equal(claimTurnExecutionLease({ ...scope, ownerId: 'worker-b', now: 5_000, leaseMs: 2_000 }), true)
  assert.equal(getTurnExecutionLease(scope).cancelRequestedAt, 2_500)
  assert.equal(releaseTurnExecutionLease({ ...scope, ownerId: 'worker-a' }), false)
  assert.equal(releaseTurnExecutionLease({ ...scope, ownerId: 'worker-b' }), true)
  assert.equal(isTurnExecutionLeaseActive(scope, 5_001), false)
})

test('cancellation cannot be injected into an expired turn lease', () => {
  const { userId } = issueTestSession()
  const scope = { userId, sessionId: 'expired-turn-lease-session', turnId: 'expired-turn' }
  upsertSession({ id: scope.sessionId, userId, title: 'expired lease' })
  assert.equal(claimTurnExecutionLease({ ...scope, ownerId: 'worker-a', now: 1_000, leaseMs: 1_000 }), true)
  assert.equal(requestTurnExecutionCancellation({ ...scope, now: 2_000 }), false)
})

test('steering inbox closing is atomic and a replacement owner reopens it', () => {
  const { userId } = issueTestSession()
  const scope = { userId, sessionId: 'turn-steering-inbox-session', turnId: 'turn-steering-inbox' }
  upsertSession({ id: scope.sessionId, userId, title: 'steering inbox' })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${scope.turnId}:started`,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'start' },
      createdAt: 1_000,
    }),
  })
  assert.equal(claimTurnExecutionLease({
    ...scope,
    ownerId: 'worker-a',
    now: 1_000,
    leaseMs: 1_000,
  }), true)
  assert.deepEqual(tryCloseTurnSteeringInbox({ ...scope, ownerId: 'worker-a', now: 1_100 }), {
    closed: true,
    reason: 'closed',
    pendingCount: 0,
  })
  assert.equal(getTurnExecutionLease(scope).acceptingSteering, false)
  assert.throws(
    () => enqueueTurnSteering({
      ...scope,
      content: 'closed inbox',
      clientRequestId: 'closed-inbox',
      now: 1_200,
    }),
    (error) => error?.code === 'TURN_STEERING_INBOX_CLOSED',
  )

  assert.equal(claimTurnExecutionLease({
    ...scope,
    ownerId: 'worker-a',
    now: 1_200,
    leaseMs: 1_000,
  }), true)
  assert.equal(getTurnExecutionLease(scope).acceptingSteering, false)
  assert.equal(claimTurnExecutionLease({
    ...scope,
    ownerId: 'worker-b',
    now: 2_200,
    leaseMs: 2_000,
  }), true)
  assert.equal(getTurnExecutionLease(scope).acceptingSteering, true)

  enqueueTurnSteering({
    ...scope,
    content: 'new owner accepted this',
    clientRequestId: 'replacement-owner',
    now: 2_300,
  })
  assert.deepEqual(tryCloseTurnSteeringInbox({ ...scope, ownerId: 'worker-b', now: 2_400 }), {
    closed: false,
    reason: 'pending',
    pendingCount: 1,
  })
  const claimed = claimTurnSteering({ ...scope, ownerId: 'worker-b', now: 2_400 })
  assert.equal(claimed.messages.length, 1)
  assert.equal(acknowledgeTurnSteering({
    ...scope,
    ownerId: 'worker-b',
    leaseId: claimed.leaseId,
    now: 2_500,
  }), 1)
  assert.equal(tryCloseTurnSteeringInbox({ ...scope, ownerId: 'worker-b', now: 2_600 }).closed, true)
})
