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
