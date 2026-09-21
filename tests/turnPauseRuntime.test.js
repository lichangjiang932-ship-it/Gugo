import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnCancellationRuntime } from '../server/services/turnCancellationRuntime.js'

const SCOPE = Object.freeze({ userId: 'user-1', sessionId: 'session-1', turnId: 'turn-1' })

function createPorts(overrides = {}) {
  return {
    readSession: async () => ({ id: SCOPE.sessionId, userId: SCOPE.userId }),
    claimLegacySession: async () => null,
    readActiveTurn: () => null,
    getTurn: async () => ({ ...SCOPE, status: 'running' }),
    requestCancellation: async () => false,
    abortActiveTurn: () => {},
    releaseApproval: () => {},
    lastEvent: async () => ({ ...SCOPE, sequence: 0, type: 'turn.started' }),
    acquireLease: async () => null,
    closeSteeringInbox: async () => {},
    replayEvents: async () => [],
    loadCheckpoint: async () => null,
    now: () => 1_700_000_000_000,
    createEmitter: () => { const emit = async () => {}; emit.close = async () => {}; return emit },
    writeMessage: async () => {},
    ...overrides,
  }
}

test('pausing a running turn aborts it with a pause reason, never a cancel reason', async () => {
  const aborts = []
  const runtime = createTurnCancellationRuntime(createPorts({
    readActiveTurn: () => ({ controller: { abort: (error) => aborts.push(error) } }),
    abortActiveTurn: (running, error) => running.controller.abort(error),
  }))
  const turn = await runtime.pause({ ...SCOPE })
  assert.equal(aborts.length, 1)
  // The loop keys the "finish as paused (resumable)" decision on this code.
  // A TURN_CANCEL_REQUESTED here would make the turn terminal and unresumable.
  assert.equal(aborts[0].code, 'TURN_PAUSE_REQUESTED')
  assert.notEqual(aborts[0].code, 'TURN_CANCEL_REQUESTED')
  assert.equal(aborts[0].name, 'AbortError')
  assert.equal(turn.status, 'pausing')
})

test('pausing already-settled work reports the settled status instead of pretending to pause', async () => {
  const runtime = createTurnCancellationRuntime(createPorts({
    lastEvent: async () => ({ ...SCOPE, sequence: 9, type: 'turn.cancelled' }),
    getTurn: async () => ({
      ...SCOPE, status: 'cancelled', lastEvent: { ...SCOPE, sequence: 9, type: 'turn.cancelled' },
    }),
  }))
  const turn = await runtime.pause({ ...SCOPE })
  assert.equal(turn.status, 'cancelled')
  assert.notEqual(turn.status, 'pausing')
})

test('a turn this process does not own cannot be paused, and says so', async () => {
  // Pause has to reach the live loop so it can persist a resumable checkpoint.
  // Reporting a conflict is honest; silently succeeding would leave a button
  // that appears to work while the turn keeps running.
  const runtime = createTurnCancellationRuntime(createPorts())
  await assert.rejects(
    () => runtime.pause({ ...SCOPE }),
    (error) => error.code === 'TURN_PAUSE_UNAVAILABLE' && error.retryable === false,
  )
})

test('a missing turn is not found, matching cancellation semantics', async () => {
  const runtime = createTurnCancellationRuntime(createPorts({ lastEvent: async () => null }))
  await assert.rejects(() => runtime.pause({ ...SCOPE }), (error) => error.code === 'TURN_NOT_FOUND')
})
