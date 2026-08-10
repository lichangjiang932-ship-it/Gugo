import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-turn-recovery-tests', String(process.pid))

const { issueTestSession } = await import('./helpers/testAuth.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const {
  claimTurnExecutionLease,
  listUnfinishedTurnExecutions,
} = await import('../server/services/turnExecutionLeaseStore.js')
const { TurnRecoveryRuntime } = await import('../server/services/turnRecoveryRuntime.js')

function persist(userId, sessionId, turnId, sequence, type, createdAt = sequence + 1) {
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:${sequence}`,
      sessionId,
      turnId,
      sequence,
      type,
      payload: type === 'turn.started' ? { content: 'resume' } : {},
      createdAt,
    }),
  })
}

test('unfinished turn scan excludes terminal turns and exposes lease ownership', () => {
  const { userId } = issueTestSession()
  const sessionId = 'turn-recovery-store-session'
  upsertSession({ id: sessionId, userId, title: 'recovery' })
  persist(userId, sessionId, 'recoverable', 0, 'turn.started', 10)
  persist(userId, sessionId, 'recoverable', 1, 'turn.checkpoint', 11)
  persist(userId, sessionId, 'terminal', 0, 'turn.started', 12)
  persist(userId, sessionId, 'terminal', 1, 'turn.completed', 13)
  claimTurnExecutionLease({
    userId,
    sessionId,
    turnId: 'recoverable',
    ownerId: 'live-worker',
    now: 20,
    leaseMs: 2_000,
  })

  const candidates = listUnfinishedTurnExecutions({ before: 100 })
    .filter((candidate) => candidate.sessionId === sessionId)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].turnId, 'recoverable')
  assert.equal(candidates[0].lastSequence, 1)
  assert.equal(candidates[0].lastEventType, 'turn.checkpoint')
  assert.equal(candidates[0].lease.ownerId, 'live-worker')
  assert.equal(candidates[0].lease.expiresAt, 2_020)
})

test('paused turns wait without recovery polling and resume even within the same millisecond', async () => {
  let candidate = {
    userId: 'paused-user',
    sessionId: 'paused-session',
    turnId: 'paused-turn',
    lastSequence: 3,
    lastEventType: 'turn.paused',
    lastEventAt: 100,
    lease: null,
  }
  let recoveries = 0
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn() {
        recoveries += 1
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate],
    now: () => 100,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })

  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(recoveries, 0)

  candidate = {
    ...candidate,
    lastSequence: 4,
    lastEventType: 'turn.resumed',
    // SQLite event timestamps have millisecond precision, so pause and resume
    // can legitimately share a timestamp.
    lastEventAt: 100,
  }
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(recoveries, 1)
  runtime.stop()
})

test('startup recovery waits for a live lease then resumes exactly once', async () => {
  let now = 1_000
  let resumes = 0
  const candidate = {
    userId: 'u1', sessionId: 's1', turnId: 't1', lastEventAt: 10,
    lease: { ownerId: 'other-process', expiresAt: 2_000 },
  }
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn(scope) {
        resumes += 1
        assert.deepEqual(scope, { userId: 'u1', sessionId: 's1', turnId: 't1' })
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })

  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 1 })
  assert.equal(resumes, 0)
  now = 2_025
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(resumes, 1)
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  runtime.stop()
})

test('startup recovery keeps observing when another process wins the claim race', async () => {
  let now = 1_000
  let claims = 0
  let lease = null
  const candidate = () => ({
    userId: 'race-user', sessionId: 'race-session', turnId: 'race-turn', lastEventAt: 10, lease,
  })
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn() {
        claims += 1
        if (claims === 1) {
          lease = { ownerId: 'winner-a', expiresAt: 2_000 }
          return { scheduled: false, locallyActive: false, terminal: false }
        }
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate()],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })

  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 1 })
  assert.equal(claims, 1)
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 1 })
  assert.equal(claims, 1)
  now = 2_025
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(claims, 2)
  runtime.stop()
})

test('locally scheduled recovery is removed before a provider interruption can trigger retries', async () => {
  let claims = 0
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn() {
        claims += 1
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [{ userId: 'u', sessionId: 's', turnId: 'interrupted', lastEventAt: 1, lease: null }],
    now: () => 10,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })
  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(claims, 1)
  runtime.stop()
})

test('an unchanged recovered turn becomes eligible again after the discovery interval', async () => {
  let now = 10
  let recoveries = 0
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn() {
        recoveries += 1
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [{ userId: 'u', sessionId: 's', turnId: 'orphan', lastEventAt: 1, lease: null }],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    discoveryIntervalMs: 25,
  })
  runtime.start()
  await runtime.scan()
  assert.equal(recoveries, 1)
  now = 34
  await runtime.scan()
  assert.equal(recoveries, 1)
  now = 35
  await runtime.scan()
  assert.equal(recoveries, 2)
  runtime.stop()
})

test('recovery discovers unfinished turns created after startup without replaying an unchanged candidate', async () => {
  let now = 100
  let candidates = []
  const recovered = []
  const runtime = new TurnRecoveryRuntime({
    engine: {
      async recoverTurn(scope) {
        recovered.push(scope)
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => candidates,
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    discoveryIntervalMs: 25,
  })

  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })

  candidates = [{
    userId: 'late-user',
    sessionId: 'late-session',
    turnId: 'late-turn',
    lastEventAt: 110,
    lease: null,
  }]
  now = 120
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(recovered.length, 1)

  now = 130
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(recovered.length, 1)

  candidates = [{ ...candidates[0], lastEventAt: 140 }]
  now = 150
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(recovered.length, 2)
  runtime.stop()
})

test('stopping startup recovery clears pending work without claiming it', async () => {
  let resumes = 0
  const runtime = new TurnRecoveryRuntime({
    engine: { async resumeTurn() { resumes += 1 } },
    listUnfinished: () => [{ userId: 'u', sessionId: 's', turnId: 't', lastEventAt: 1, lease: null }],
    now: () => 10,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  })
  runtime.start()
  runtime.stop()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(resumes, 0)
})
