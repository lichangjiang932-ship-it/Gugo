import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnCancellationRuntime } from '../server/services/turnCancellationRuntime.js'

const SCOPE = Object.freeze({
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
})

function createEmitterFactory(events = []) {
  let closeCount = 0
  return {
    createEmitter(scope) {
      const emit = async (type, payload, options = {}) => {
        const event = {
          ...scope,
          id: `${scope.turnId}:event:${scope.sequence}`,
          type,
          payload,
          createdAt: 1_700_000_000_000,
        }
        await options.beforeAppend?.(event)
        if (typeof options.commitEvent === 'function') {
          await options.commitEvent({ event })
        }
        events.push(event)
        return event
      }
      emit.close = async () => { closeCount += 1 }
      return emit
    },
    get closeCount() { return closeCount },
  }
}

function createPorts(overrides = {}) {
  const emitterFactory = overrides.emitterFactory || createEmitterFactory()
  return {
    readSession: async () => ({ id: SCOPE.sessionId, userId: SCOPE.userId }),
    claimLegacySession: async () => null,
    readActiveTurn: () => null,
    getTurn: async () => ({ ...SCOPE, status: 'cancelled' }),
    requestCancellation: async () => false,
    abortActiveTurn: () => {},
    releaseApproval: () => {},
    lastEvent: async () => ({ ...SCOPE, sequence: 0, type: 'turn.started' }),
    acquireLease: async () => null,
    closeSteeringInbox: async () => {},
    replayEvents: async () => [],
    loadCheckpoint: async () => null,
    now: () => 1_700_000_000_000,
    createEmitter: emitterFactory.createEmitter,
    writeMessage: async () => {},
    ...overrides,
  }
}

test('turn cancellation runtime is frozen and local abort survives lease-port failure', async () => {
  const running = { id: 'local-running-turn' }
  let aborted = null
  let approvalReleases = 0
  let leaseAcquires = 0
  const runtime = createTurnCancellationRuntime(createPorts({
    readActiveTurn: () => running,
    requestCancellation: async () => { throw new Error('lease store unavailable') },
    abortActiveTurn: (active, error) => { aborted = { active, error } },
    releaseApproval: () => { approvalReleases += 1 },
    acquireLease: async () => { leaseAcquires += 1; return null },
    getTurn: async () => ({ ...SCOPE, status: 'running' }),
  }))

  assert.equal(Object.isFrozen(runtime), true)
  const result = await runtime.cancel(SCOPE)

  assert.equal(result.status, 'cancelling')
  assert.equal(aborted.active, running)
  assert.equal(aborted.error.name, 'AbortError')
  assert.equal(aborted.error.code, 'TURN_CANCEL_REQUESTED')
  assert.equal(approvalReleases, 1)
  assert.equal(leaseAcquires, 0)
})

test('turn cancellation runtime fails closed when no worker accepts cancellation and no fence is available', async () => {
  let requestCount = 0
  const runtime = createTurnCancellationRuntime(createPorts({
    requestCancellation: async () => { requestCount += 1; return false },
  }))

  await assert.rejects(
    runtime.cancel(SCOPE),
    (error) => error?.code === 'TURN_CANCELLATION_CONFLICT'
      && error?.status === 409
      && error?.retryable === true,
  )
  assert.equal(requestCount, 2)
})

test('turn cancellation runtime releases its fence exactly once when the turn becomes terminal', async () => {
  let lastEventReads = 0
  let releaseCount = 0
  let replayReads = 0
  const runtime = createTurnCancellationRuntime(createPorts({
    lastEvent: async () => {
      lastEventReads += 1
      return lastEventReads === 1
        ? { ...SCOPE, sequence: 0, type: 'turn.started' }
        : { ...SCOPE, sequence: 1, type: 'turn.completed' }
    },
    acquireLease: async () => ({
      executionLease: { ownerId: 'worker-1', fenceToken: 7 },
      release: async () => { releaseCount += 1 },
    }),
    replayEvents: async () => { replayReads += 1; return [] },
    getTurn: async () => ({ ...SCOPE, status: 'completed' }),
  }))

  const result = await runtime.cancel(SCOPE)

  assert.equal(result.status, 'completed')
  assert.equal(releaseCount, 1)
  assert.equal(replayReads, 0)
})

test('turn cancellation runtime commits the event and evidence message as one fenced boundary', async () => {
  const emitted = []
  const emitterFactory = createEmitterFactory(emitted)
  const started = {
    ...SCOPE,
    id: 'event-started',
    sequence: 0,
    type: 'turn.started',
    payload: { content: 'hello' },
    createdAt: 1_699_999_999_000,
  }
  let releaseCount = 0
  let boundary = null
  const runtime = createTurnCancellationRuntime(createPorts({
    emitterFactory,
    lastEvent: async () => started,
    replayEvents: async () => [started],
    acquireLease: async () => ({
      executionLease: { ownerId: 'worker-1', fenceToken: 8 },
      release: async () => { releaseCount += 1 },
    }),
    commitTurnBoundary: async (input) => { boundary = input },
  }))

  const result = await runtime.cancel(SCOPE)

  assert.equal(result.status, 'cancelled')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'turn.cancelled')
  assert.equal(boundary.event, emitted[0])
  assert.equal(boundary.message.content, '')
  assert.equal(boundary.message.modelContext.turnEvidence, true)
  assert.equal(boundary.message.modelContext.evidenceState, 'cancelled')
  assert.deepEqual(boundary.executionLease, { ownerId: 'worker-1', fenceToken: 8 })
  assert.equal(emitterFactory.closeCount, 1)
  assert.equal(releaseCount, 1)
})

function directoryFixture(overrides = {}) {
  const calls = []
  const emitted = []
  const emitterFactory = createEmitterFactory(emitted)
  const started = { ...SCOPE, id: 'directory-start', sequence: 0, type: 'turn.started',
    payload: { content: 'keep the existing delivery' }, createdAt: 100 }
  const pause = { ...SCOPE, id: 'directory-pause', sequence: 2, type: 'turn.paused',
    payload: { clarification: { request_type: 'directory', access_mode: 'read_only' },
      verifiedLocalFiles: [{ id: 'verified', path: '/fixture/verified.txt', filename: 'verified.txt' }],
      retainedLocalFiles: [{ id: 'retained', path: '/fixture/retained.txt', filename: 'retained.txt' }] },
    createdAt: 200 }
  let latest = pause
  const checkpoint = { eventSequence: 1, state: {
    messages: [{ role: 'user', content: started.payload.content }],
    artifactIds: ['kept-artifact'], deliveryArtifactIds: ['kept-artifact'], iterations: 2,
  } }
  const lease = {
    controller: new AbortController(),
    executionLease: { ownerId: 'directory-cancel-worker', fenceToken: 12 },
    release: async () => { calls.push('release-lease') },
  }
  let boundary
  const ports = createPorts({
    emitterFactory,
    readSession: async ({ userId, sessionId }) => {
      calls.push('session')
      return userId === SCOPE.userId && sessionId === SCOPE.sessionId ? { id: sessionId } : null
    },
    claimLegacySession: async () => { calls.push('claim-legacy'); return null },
    lastEvent: async () => { calls.push('last-event'); return latest },
    readActiveTurn: () => null,
    requestCancellation: async () => { calls.push('request-cancellation'); return true },
    abortActiveTurn: () => { calls.push('abort-active') },
    acquireLease: async () => { calls.push('acquire-lease'); return lease },
    releaseApproval: () => { calls.push('release-approval') },
    closeSteeringInbox: async () => { calls.push('close-inbox') },
    replayEvents: async ({ after }) => [started, pause].filter(event => event.sequence > after),
    loadCheckpoint: async () => checkpoint,
    commitTurnBoundary: async (input) => { calls.push('commit'); boundary = input; latest = input.event },
    getTurn: async () => ({ ...SCOPE, status: latest.type.slice('turn.'.length), lastEvent: latest }),
    ...overrides,
  })
  return {
    calls, emitted, emitterFactory, lease, pause, checkpoint, ports,
    runtime: createTurnCancellationRuntime(ports),
    input: { ...SCOPE, directoryPausedSequence: pause.sequence },
    get boundary() { return boundary },
    setLatest: value => { latest = value },
  }
}

test('directory rejection commits a real fenced cancellation and preserves checkpoint delivery evidence', async () => {
  const f = directoryFixture()
  const checkpointBefore = structuredClone(f.checkpoint)
  const result = await f.runtime.cancel(f.input)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.lastEvent, f.emitted[0])
  assert.equal(result.lastEvent.type, 'turn.cancelled')
  assert.equal(result.lastEvent.sequence, f.pause.sequence + 1)
  assert.deepEqual(result.lastEvent.payload.artifactIds, ['kept-artifact'])
  assert.deepEqual(result.lastEvent.payload.deliveryArtifactIds, ['kept-artifact'])
  assert.equal(result.lastEvent.payload.verifiedLocalFiles[0].id, 'verified')
  assert.equal(result.lastEvent.payload.retainedLocalFiles[0].id, 'retained')
  assert.equal(f.boundary.message.modelContext.evidenceState, 'cancelled')
  assert.equal(f.boundary.executionLease, f.lease.executionLease)
  assert.deepEqual(f.checkpoint, checkpointBefore)
  assert.equal(f.calls.includes('request-cancellation'), false)
  assert.equal(f.calls.includes('abort-active'), false)
  assert.ok(f.calls.indexOf('commit') < f.calls.indexOf('release-approval'))
  assert.ok(f.calls.indexOf('commit') < f.calls.indexOf('close-inbox'))
  assert.equal(f.calls.filter(call => call === 'release-lease').length, 1)
  assert.equal(f.emitterFactory.closeCount, 1)
})

test('invalid directory pause sequences fail before reading or mutating any scoped state', async () => {
  for (const directoryPausedSequence of [null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', true, {}, []]) {
    const f = directoryFixture()
    await assert.rejects(f.runtime.cancel({ ...f.input, directoryPausedSequence }),
      error => error.code === 'TURN_DIRECTORY_PAUSE_SEQUENCE_INVALID' && error.status === 400)
    assert.deepEqual(f.calls, [])
  }
})

test('directory rejection cannot claim a legacy session or cross owner and session scopes', async () => {
  for (const change of [{ userId: 'other-user' }, { sessionId: 'other-session' }, { turnId: 'other-turn' }]) {
    const f = directoryFixture()
    await assert.rejects(f.runtime.cancel({ ...f.input, ...change, authMode: 'local' }),
      error => ['TURN_NOT_FOUND', 'TURN_DIRECTORY_PAUSE_STALE'].includes(error.code))
    assert.equal(f.calls.includes('claim-legacy'), false)
    assert.equal(f.calls.includes('acquire-lease'), false)
    assert.equal(f.calls.includes('request-cancellation'), false)
    assert.deepEqual(f.emitted, [])
  }
  const foreign = directoryFixture({ readSession: async () => ({ id: SCOPE.sessionId, userId: 'other-owner' }) })
  await assert.rejects(foreign.runtime.cancel(foreign.input), error => error.code === 'TURN_NOT_FOUND')
  assert.equal(foreign.calls.includes('acquire-lease'), false)
})

test('directory rejection validates exact scope before reading its session', async () => {
  for (const key of ['userId', 'sessionId', 'turnId']) {
    for (const value of ['', ' ', 42, null]) {
      const f = directoryFixture()
      await assert.rejects(f.runtime.cancel({ ...f.input, [key]: value }),
        error => error.code === 'TURN_DIRECTORY_CANCELLATION_SCOPE_INVALID' && error.status === 400)
      assert.deepEqual(f.calls, [])
    }
  }
})

test('only the exact latest directory pause may acquire the cancellation lease', async () => {
  const changes = [
    { type: 'turn.resumed' }, { type: 'turn.started' }, { type: 'turn.interrupted' },
    { type: 'turn.completed' }, { type: 'turn.cancelled' }, { type: 'turn.failed' },
    { sequence: 3 }, { sequence: 1 }, { sessionId: 'other-session' }, { turnId: 'other-turn' },
    { userId: 'other-user' }, { payload: { clarification: { request_type: 'question' } } },
    { payload: { clarification: 'directory' } },
  ]
  for (const change of changes) {
    const f = directoryFixture()
    f.setLatest({ ...f.pause, ...change })
    await assert.rejects(f.runtime.cancel(f.input), error => error.code === 'TURN_DIRECTORY_PAUSE_STALE' && error.status === 409)
    assert.equal(f.calls.includes('acquire-lease'), false)
    assert.equal(f.calls.includes('request-cancellation'), false)
    assert.equal(f.calls.includes('release-approval'), false)
    assert.deepEqual(f.emitted, [])
  }
})

test('a directory card cannot abort a local active worker or signal a remote lease owner', async () => {
  const local = directoryFixture({ readActiveTurn: () => ({ controller: new AbortController() }) })
  await assert.rejects(local.runtime.cancel(local.input), error => error.code === 'TURN_CANCELLATION_CONFLICT')
  assert.equal(local.calls.includes('acquire-lease'), false)
  const remote = directoryFixture({ acquireLease: async () => null })
  await assert.rejects(remote.runtime.cancel(remote.input), error => error.code === 'TURN_CANCELLATION_CONFLICT')
  for (const f of [local, remote]) {
    assert.equal(f.calls.includes('request-cancellation'), false)
    assert.equal(f.calls.includes('abort-active'), false)
    assert.equal(f.calls.includes('release-approval'), false)
    assert.deepEqual(f.emitted, [])
  }
})

test('a pause that resumes during lease acquisition is not cancelled and its lease is released', async () => {
  let f
  f = directoryFixture({ acquireLease: async () => {
    f.setLatest({ ...f.pause, sequence: 3, type: 'turn.resumed' })
    return f.lease
  } })
  await assert.rejects(f.runtime.cancel(f.input), error => error.code === 'TURN_DIRECTORY_PAUSE_STALE')
  assert.equal(f.calls.filter(call => call === 'release-lease').length, 1)
  assert.equal(f.calls.includes('request-cancellation'), false)
  assert.equal(f.calls.includes('close-inbox'), false)
  assert.equal(f.calls.includes('release-approval'), false)
  assert.deepEqual(f.emitted, [])
})

test('directory cancellation rechecks the pending sequence after asynchronous evidence reads', async () => {
  let f
  f = directoryFixture({ loadCheckpoint: async () => {
    f.setLatest({ ...f.pause, sequence: 4 })
    return f.checkpoint
  } })
  await assert.rejects(f.runtime.cancel(f.input), error => error.code === 'TURN_DIRECTORY_PAUSE_STALE')
  assert.equal(f.calls.filter(call => call === 'release-lease').length, 1)
  assert.equal(f.calls.includes('commit'), false)
  assert.equal(f.calls.includes('close-inbox'), false)
  assert.equal(f.calls.includes('release-approval'), false)
})

test('an active entry appearing after claim or an aborted cancellation lease cannot cross the boundary', async () => {
  let reads = 0
  const active = directoryFixture({ readActiveTurn: () => ++reads === 1 ? null : { id: 'new-execution' } })
  const aborted = directoryFixture()
  aborted.lease.controller.abort(Object.assign(new Error('lease lost'), { code: 'TURN_LEASE_LOST' }))
  for (const f of [active, aborted]) {
    await assert.rejects(f.runtime.cancel(f.input), error => error.code === 'TURN_CANCELLATION_CONFLICT')
    assert.equal(f.calls.filter(call => call === 'release-lease').length, 1)
    assert.equal(f.calls.includes('request-cancellation'), false)
    assert.equal(f.calls.includes('release-approval'), false)
    assert.deepEqual(f.emitted, [])
  }
})

test('a stale-owner commit failure is not presented as directory cancellation success', async () => {
  const failure = Object.assign(new Error('lease expired before commit'), { code: 'TURN_EXECUTION_LEASE_STALE' })
  const f = directoryFixture({ commitTurnBoundary: async () => { throw failure } })
  await assert.rejects(f.runtime.cancel(f.input), error => error === failure)
  assert.equal(f.calls.filter(call => call === 'release-lease').length, 1)
  assert.equal(f.emitterFactory.closeCount, 1)
  assert.equal(f.calls.includes('release-approval'), false)
  assert.equal(f.calls.includes('close-inbox'), false)
  assert.deepEqual(f.emitted, [])
})
