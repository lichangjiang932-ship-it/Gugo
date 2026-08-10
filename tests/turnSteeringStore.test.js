import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'gugo-turn-steering-store-tests',
  `${process.pid}-${Date.now()}`,
)

const { closeDb } = await import('../server/db.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { claimTurnExecutionLease, tryCloseTurnSteeringInbox } = await import(
  '../server/services/turnExecutionLeaseStore.js'
)
const {
  acknowledgeAppliedTurnSteering,
  acknowledgeTurnSteering,
  claimTurnSteering,
  enqueueTurnSteering,
  listTurnSteering,
  releaseTurnSteeringLease,
  releaseTurnSteeringLeasesForTurn,
} = await import('../server/services/turnSteeringStore.js')

function createRunningTurn({
  userId,
  sessionId,
  turnId,
  ownerId,
  now = 1_000,
  leaseMs = 10_000,
}) {
  upsertSession({ id: sessionId, userId, title: `Session ${turnId}`, createdAt: now, updatedAt: now })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:started`,
      sessionId,
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: `start ${turnId}` },
      createdAt: now,
    }),
  })
  assert.equal(claimTurnExecutionLease({ userId, sessionId, turnId, ownerId, now, leaseMs }), true)
  return { userId, sessionId, turnId, ownerId }
}

test('enqueue is idempotent and atomically persists the canonical steering message', () => {
  const { userId } = issueTestSession()
  const scope = createRunningTurn({
    userId,
    sessionId: 'steering-idempotent-session',
    turnId: 'steering-idempotent-turn',
    ownerId: 'worker-idempotent',
  })

  const first = enqueueTurnSteering({
    ...scope,
    content: '只生成 CSV，不要生成 PDF。',
    clientRequestId: 'client-request-1',
    now: 1_100,
  })
  const replay = enqueueTurnSteering({
    ...scope,
    content: '只生成 CSV，不要生成 PDF。',
    clientRequestId: 'client-request-1',
    now: 1_200,
  })

  assert.equal(replay.id, first.id)
  assert.equal(replay.messageId, first.messageId)
  assert.equal(replay.clientRequestId, 'client-request-1')
  assert.equal(replay.content, '只生成 CSV，不要生成 PDF。')
  assert.equal(replay.createdAt, 1_100)
  assert.equal(listTurnSteering(scope).length, 1)
  assert.throws(
    () => enqueueTurnSteering({
      ...scope,
      content: '改成另一个请求',
      clientRequestId: 'client-request-1',
      now: 1_300,
    }),
    (error) => error?.code === 'TURN_STEERING_IDEMPOTENCY_CONFLICT' && error?.status === 409,
  )

  const stored = listMessages({ userId, sessionId: scope.sessionId })
    .filter((message) => message.id === first.messageId)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].role, 'user')
  assert.equal(stored[0].content, first.content)
  assert.deepEqual(stored[0].modelContext, {
    version: 1,
    turnId: scope.turnId,
    modelContent: first.content,
    liveSteering: true,
    steeringId: first.id,
    steeringClientRequestId: first.clientRequestId,
  })
})

test('only the active execution owner can lease, release, and acknowledge steering', () => {
  const { userId } = issueTestSession()
  const scope = createRunningTurn({
    userId,
    sessionId: 'steering-owner-session',
    turnId: 'steering-owner-turn',
    ownerId: 'worker-owner',
  })
  enqueueTurnSteering({ ...scope, content: 'first', clientRequestId: 'owner-1', now: 1_100 })
  enqueueTurnSteering({ ...scope, content: 'second', clientRequestId: 'owner-2', now: 1_200 })

  assert.deepEqual(
    claimTurnSteering({ ...scope, ownerId: 'worker-other', now: 1_300 }),
    { leaseId: null, messages: [] },
  )
  const firstLease = claimTurnSteering({ ...scope, limit: 1, now: 1_300 })
  assert.equal(firstLease.messages.length, 1)
  assert.equal(firstLease.messages[0].content, 'first')
  assert.equal(releaseTurnSteeringLease({
    ...scope,
    ownerId: 'worker-other',
    leaseId: firstLease.leaseId,
    now: 1_400,
  }), 0)
  assert.equal(releaseTurnSteeringLease({ ...scope, leaseId: firstLease.leaseId, now: 1_400 }), 1)

  const secondLease = claimTurnSteering({ ...scope, limit: 2, now: 1_500 })
  assert.deepEqual(secondLease.messages.map((message) => message.content), ['first', 'second'])
  assert.equal(acknowledgeTurnSteering({ ...scope, leaseId: secondLease.leaseId, now: 1_600 }), 2)
  assert.equal(listTurnSteering({ ...scope, status: 'consumed' }).length, 2)
})

test('checkpoint recovery acknowledges only the exact applied steering ids for the active owner', () => {
  const { userId } = issueTestSession()
  const original = createRunningTurn({
    userId,
    sessionId: 'steering-applied-recovery-session',
    turnId: 'steering-applied-recovery-turn',
    ownerId: 'worker-applied-old',
    leaseMs: 1_000,
  })
  const steering = ['leased-applied', 'leased-pending', 'queued-applied', 'queued-pending']
    .map((content, index) => enqueueTurnSteering({
      ...original,
      content,
      clientRequestId: `applied-recovery-${index}`,
      now: 1_100 + index,
    }))
  const oldLease = claimTurnSteering({ ...original, limit: 2, now: 1_200 })
  assert.deepEqual(oldLease.messages.map(({ id }) => id), steering.slice(0, 2).map(({ id }) => id))

  assert.equal(claimTurnExecutionLease({
    ...original,
    ownerId: 'worker-applied-new',
    now: 2_000,
    leaseMs: 5_000,
  }), true)
  const recovered = { ...original, ownerId: 'worker-applied-new' }
  const applied = {
    messageIds: [steering[0].messageId, steering[0].messageId],
    steeringIds: [steering[2].id],
  }

  assert.equal(acknowledgeAppliedTurnSteering({
    ...original,
    ...applied,
    now: 2_100,
  }), 0, 'the expired owner cannot reconcile checkpoint state')
  assert.equal(acknowledgeAppliedTurnSteering({
    ...recovered,
    ...applied,
    now: 2_100,
  }), 2)

  const afterFirstAck = listTurnSteering(recovered)
  assert.deepEqual(afterFirstAck.map(({ status }) => status), [
    'consumed',
    'leased',
    'consumed',
    'queued',
  ])
  assert.equal(afterFirstAck[0].consumedAt, 2_100)
  assert.equal(afterFirstAck[2].consumedAt, 2_100)

  assert.equal(acknowledgeAppliedTurnSteering({
    ...recovered,
    ...applied,
    now: 2_200,
  }), 0, 'replaying the same checkpoint acknowledgement is idempotent')
  const afterReplay = listTurnSteering(recovered)
  assert.equal(afterReplay[0].consumedAt, 2_100)
  assert.equal(afterReplay[2].consumedAt, 2_100)
  assert.equal(afterReplay[1].status, 'leased', 'an unlisted leased update must remain pending')
  assert.equal(afterReplay[3].status, 'queued', 'an unlisted queued update must remain pending')
})

test('a recovered execution owner releases steering leases only for its exact turn', () => {
  const { userId } = issueTestSession()
  const first = createRunningTurn({
    userId,
    sessionId: 'steering-recovery-a-session',
    turnId: 'steering-recovery-a-turn',
    ownerId: 'worker-old-a',
    leaseMs: 1_000,
  })
  const second = createRunningTurn({
    userId,
    sessionId: 'steering-recovery-b-session',
    turnId: 'steering-recovery-b-turn',
    ownerId: 'worker-old-b',
    leaseMs: 10_000,
  })
  enqueueTurnSteering({ ...first, content: 'recover a', clientRequestId: 'recover-a', now: 1_100 })
  enqueueTurnSteering({ ...second, content: 'keep b', clientRequestId: 'recover-b', now: 1_100 })
  const firstLease = claimTurnSteering({ ...first, now: 1_200 })
  const secondLease = claimTurnSteering({ ...second, now: 1_200 })
  assert.ok(firstLease.leaseId)
  assert.ok(secondLease.leaseId)

  assert.equal(claimTurnExecutionLease({
    userId,
    sessionId: first.sessionId,
    turnId: first.turnId,
    ownerId: 'worker-new-a',
    now: 2_000,
    leaseMs: 5_000,
  }), true)
  const recoveredScope = { ...first, ownerId: 'worker-new-a' }
  assert.equal(releaseTurnSteeringLeasesForTurn({ ...recoveredScope, now: 2_000 }), 1)
  assert.equal(listTurnSteering({ ...first, status: 'queued' }).length, 1)
  assert.equal(listTurnSteering({ ...second, status: 'leased' }).length, 1)
  assert.equal(releaseTurnSteeringLeasesForTurn({
    ...second,
    ownerId: 'worker-new-a',
    now: 2_000,
  }), 0)
  assert.equal(acknowledgeTurnSteering({
    ...first,
    leaseId: firstLease.leaseId,
    now: 2_100,
  }), 0)
})

test('enqueue and inbox closing have deterministic serialized outcomes', () => {
  const { userId } = issueTestSession()
  const queuedFirst = createRunningTurn({
    userId,
    sessionId: 'steering-close-pending-session',
    turnId: 'steering-close-pending-turn',
    ownerId: 'worker-close-pending',
  })
  enqueueTurnSteering({
    ...queuedFirst,
    content: 'accepted before close',
    clientRequestId: 'close-pending',
    now: 1_100,
  })
  assert.deepEqual(tryCloseTurnSteeringInbox({ ...queuedFirst, now: 1_200 }), {
    closed: false,
    reason: 'pending',
    pendingCount: 1,
  })

  const closedFirst = createRunningTurn({
    userId,
    sessionId: 'steering-close-first-session',
    turnId: 'steering-close-first-turn',
    ownerId: 'worker-close-first',
  })
  assert.deepEqual(tryCloseTurnSteeringInbox({ ...closedFirst, now: 1_100 }), {
    closed: true,
    reason: 'closed',
    pendingCount: 0,
  })
  assert.throws(
    () => enqueueTurnSteering({
      ...closedFirst,
      content: 'too late',
      clientRequestId: 'close-first',
      now: 1_200,
    }),
    (error) => error?.code === 'TURN_STEERING_INBOX_CLOSED' && error?.status === 409,
  )
  assert.equal(listTurnSteering(closedFirst).length, 0)
})

test('cross-user and terminal turns cannot accept new steering', () => {
  const owner = issueTestSession()
  const outsider = issueTestSession()
  const scope = createRunningTurn({
    userId: owner.userId,
    sessionId: 'steering-isolation-session',
    turnId: 'steering-isolation-turn',
    ownerId: 'worker-isolation',
  })
  assert.throws(
    () => enqueueTurnSteering({
      ...scope,
      userId: outsider.userId,
      content: 'cross-user',
      clientRequestId: 'cross-user',
      now: 1_100,
    }),
    (error) => error?.code === 'TURN_NOT_FOUND' && error?.status === 404,
  )

  appendTurnEvent({
    userId: owner.userId,
    event: createTurnEvent({
      id: `${scope.turnId}:completed`,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      sequence: 1,
      type: 'turn.completed',
      payload: { text: 'done' },
      createdAt: 1_200,
    }),
  })
  assert.throws(
    () => enqueueTurnSteering({
      ...scope,
      content: 'after completion',
      clientRequestId: 'after-completion',
      now: 1_300,
    }),
    (error) => error?.code === 'TURN_STEERING_TURN_FINISHED' && error?.status === 409,
  )
})

test.after(() => closeDb())
