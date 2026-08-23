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
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('../server/adapters/sqliteTurnPersistenceAdapter.js')

const sqliteRecovery = SQLITE_TURN_PERSISTENCE_ADAPTER.recovery
const explicitSqliteRecoveryDependencies = Object.freeze({
  readRecoveryState: sqliteRecovery.getTurnRecoveryState,
  writeRecoveryFailure: sqliteRecovery.recordTurnRecoveryFailure,
  clearRecovery: sqliteRecovery.clearTurnRecoveryState,
  listRecoveryStates: sqliteRecovery.listTurnRecoveryStates,
  pruneResolvedRecovery: sqliteRecovery.pruneResolvedTurnRecoveryStates,
})

function createRecoveryRuntime(options) {
  return new TurnRecoveryRuntime({
    ...explicitSqliteRecoveryDependencies,
    ...options,
  })
}

function createRecoveryStateHarness() {
  const states = new Map()
  const key = ({ userId, sessionId, turnId }) => `${userId}\u0000${sessionId}\u0000${turnId}`
  return {
    states,
    readRecoveryState(scope) {
      return states.get(key(scope)) || null
    },
    writeRecoveryFailure(input) {
      const stateKey = key(input)
      const previous = states.get(stateKey)
      const attemptCount = previous?.candidateVersion === input.candidateVersion
        ? previous.attemptCount + 1
        : 1
      const deadLetter = input.retryable === false || attemptCount >= input.maxAttempts
      const exponent = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** (attemptCount - 1))
      const delayMs = Math.max(25, Math.floor(exponent * 0.5))
      const state = {
        userId: input.userId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        candidateVersion: input.candidateVersion,
        status: deadLetter ? 'dead_letter' : 'retrying',
        attemptCount,
        retryable: input.retryable !== false,
        firstFailedAt: previous?.candidateVersion === input.candidateVersion
          ? previous.firstFailedAt
          : input.now,
        lastFailedAt: input.now,
        nextRetryAt: deadLetter ? null : input.now + delayMs,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      }
      states.set(stateKey, state)
      return state
    },
    clearRecovery(scope, { candidateVersion = null } = {}) {
      const stateKey = key(scope)
      const state = states.get(stateKey)
      if (!state || (candidateVersion != null && state.candidateVersion !== candidateVersion)) return false
      return states.delete(stateKey)
    },
    listRecoveryStates() {
      return [...states.values()]
    },
    pruneResolvedRecovery() {
      return 0
    },
  }
}

function persist(userId, sessionId, turnId, sequence, type, createdAt = sequence + 1) {
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:${sequence}`,
      sessionId,
      turnId,
      sequence,
      type,
      payload: type === 'turn.started'
        ? { content: 'resume' }
        : type === 'turn.checkpoint'
          ? { storage: 'turn_checkpoints', checkpointVersion: 1 }
          : {},
      createdAt,
    }),
    checkpointState: type === 'turn.checkpoint' ? { iterations: sequence } : null,
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

test('recovery runtime fails closed without a complete active or injected backend', () => {
  assert.throws(
    () => new TurnRecoveryRuntime({
      engine: { recoverTurn: async () => ({ terminal: true }) },
      listUnfinished: () => [],
    }),
    (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
      && error?.retryable === false,
  )
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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
  const runtime = createRecoveryRuntime({
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

test('retryable recovery failures use bounded backoff and clear after success', async () => {
  let now = 1_000
  let attempts = 0
  const state = createRecoveryStateHarness()
  const candidate = {
    userId: 'backoff-user', sessionId: 'backoff-session', turnId: 'backoff-turn',
    lastSequence: 2, lastEventType: 'turn.checkpoint', lastEventAt: 900, lease: null,
  }
  const runtime = createRecoveryRuntime({
    engine: {
      async recoverTurn() {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('temporary outage'), { retryable: true })
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    random: () => 0,
    failureBaseDelayMs: 100,
    failureMaxDelayMs: 200,
    ...state,
  })

  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 1 })
  assert.equal(attempts, 1)
  assert.equal(state.readRecoveryState(candidate).nextRetryAt, 1_050)

  now = 1_049
  await runtime.scan()
  assert.equal(attempts, 1, 'a retry must not run before its durable due time')

  now = 1_050
  await runtime.scan()
  assert.equal(attempts, 2)
  assert.equal(state.readRecoveryState(candidate).nextRetryAt, 1_150)

  now = 1_150
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(attempts, 3)
  assert.equal(state.readRecoveryState(candidate), null)
  runtime.stop()
})

test('retry budget opens a durable dead letter and survives runtime restart', async () => {
  let now = 2_000
  let attempts = 0
  const state = createRecoveryStateHarness()
  const candidate = {
    userId: 'dead-user', sessionId: 'dead-session', turnId: 'dead-turn',
    lastSequence: 1, lastEventType: 'turn.started', lastEventAt: 1_900, lease: null,
  }
  const options = {
    engine: {
      async recoverTurn() {
        attempts += 1
        throw Object.assign(new Error('still unavailable'), { retryable: true, code: 'UPSTREAM_DOWN' })
      },
    },
    listUnfinished: () => [candidate],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    random: () => 0,
    failureMaxAttempts: 3,
    failureBaseDelayMs: 100,
    failureMaxDelayMs: 200,
    ...state,
  }
  const runtime = createRecoveryRuntime(options)
  runtime.start()
  await runtime.scan()
  now = 2_050
  await runtime.scan()
  now = 2_150
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(attempts, 3)
  assert.equal(state.readRecoveryState(candidate).status, 'dead_letter')
  assert.equal(runtime.diagnostics().deadLetters.length, 1)
  runtime.stop()

  const restarted = createRecoveryRuntime(options)
  restarted.start()
  now = 20_000
  assert.deepEqual(await restarted.scan(), { resumed: 0, waiting: 0 })
  assert.equal(attempts, 3, 'a restart must not reset the durable recovery budget')
  restarted.stop()
})

test('unknown model outcome is dead-lettered immediately without replay', async () => {
  let attempts = 0
  const state = createRecoveryStateHarness()
  const candidate = {
    userId: 'unknown-user', sessionId: 'unknown-session', turnId: 'unknown-turn',
    lastSequence: 4, lastEventType: 'turn.checkpoint', lastEventAt: 10, lease: null,
  }
  const runtime = createRecoveryRuntime({
    engine: {
      async recoverTurn() {
        attempts += 1
        throw Object.assign(new Error('provider outcome is unknown'), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN' })
      },
    },
    listUnfinished: () => [candidate],
    now: () => 100,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...state,
  })
  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(attempts, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(state.readRecoveryState(candidate)).filter(([name]) => (
      ['status', 'attemptCount', 'retryable', 'errorCode'].includes(name)
    ))),
    {
      status: 'dead_letter',
      attemptCount: 1,
      retryable: false,
      errorCode: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    },
  )
  await runtime.scan()
  assert.equal(attempts, 1)
  runtime.stop()
})

test('provider configuration drift is dead-lettered after the first recovery attempt', async () => {
  let attempts = 0
  const state = createRecoveryStateHarness()
  const candidate = {
    userId: 'config-drift-user', sessionId: 'config-drift-session', turnId: 'config-drift-turn',
    lastSequence: 2, lastEventType: 'turn.checkpoint', lastEventAt: 10, lease: null,
  }
  const runtime = createRecoveryRuntime({
    engine: {
      async recoverTurn() {
        attempts += 1
        throw Object.assign(new Error('provider revision changed'), {
          code: 'MODEL_PROVIDER_CONFIG_CHANGED',
          statusCode: 409,
        })
      },
    },
    listUnfinished: () => [candidate],
    now: () => 100,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...state,
  })
  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  const deadLetter = state.readRecoveryState(candidate)
  assert.equal(attempts, 1)
  assert.equal(deadLetter.status, 'dead_letter')
  assert.equal(deadLetter.attemptCount, 1)
  assert.equal(deadLetter.retryable, false)
  assert.equal(deadLetter.nextRetryAt, null)
  assert.equal(deadLetter.errorCode, 'MODEL_PROVIDER_CONFIG_CHANGED')
  await runtime.scan()
  assert.equal(attempts, 1)
  runtime.stop()
})

test('a durable blocked turn is never replayed by automatic recovery', async () => {
  let attempts = 0
  const candidate = {
    userId: 'blocked-user',
    sessionId: 'blocked-session',
    turnId: 'blocked-turn',
    lastSequence: 3,
    lastEventType: 'turn.blocked',
    lastEventAt: 20,
    lease: null,
  }
  const runtime = createRecoveryRuntime({
    engine: {
      async recoverTurn() {
        attempts += 1
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate],
    now: () => 100,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...createRecoveryStateHarness(),
  })
  runtime.start()
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.deepEqual(await runtime.scan(), { resumed: 0, waiting: 0 })
  assert.equal(attempts, 0)
  runtime.stop()
})

test('a new durable event version clears an old dead letter and becomes recoverable', async () => {
  let now = 100
  let attempts = 0
  const state = createRecoveryStateHarness()
  let candidate = {
    userId: 'version-user', sessionId: 'version-session', turnId: 'version-turn',
    lastSequence: 1, lastEventType: 'turn.started', lastEventAt: 10, lease: null,
  }
  const runtime = createRecoveryRuntime({
    engine: {
      async recoverTurn() {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('unsafe replay'), { retryable: false })
        return { scheduled: true, locallyActive: true, terminal: false }
      },
    },
    listUnfinished: () => [candidate],
    now: () => now,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    ...state,
  })
  runtime.start()
  await runtime.scan()
  assert.equal(state.readRecoveryState(candidate).status, 'dead_letter')

  candidate = { ...candidate, lastSequence: 2, lastEventType: 'turn.resumed', lastEventAt: 11 }
  now = 101
  assert.deepEqual(await runtime.scan(), { resumed: 1, waiting: 0 })
  assert.equal(attempts, 2)
  assert.equal(state.readRecoveryState(candidate), null)
  runtime.stop()
})
