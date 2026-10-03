import assert from 'node:assert/strict'
import test from 'node:test'

import { timeoutReplacesResult } from '../../bin/cli/runDeadline.js'
import { runResultSucceeded } from '../../bin/cli/runDiagnostics.js'

const TURN_COMPLETED = Object.freeze({ type: 'turn.completed', payload: {} })
const TURN_CANCELLED = Object.freeze({ type: 'turn.cancelled', payload: {} })

function result(status, extra = {}) {
  return { status, ...extra }
}

test('a tripped deadline never replaces a successful terminal', () => {
  assert.equal(timeoutReplacesResult(
    result('completed', { exitCode: 0, lastEvent: TURN_COMPLETED }),
    TURN_COMPLETED,
  ), false)
  // Success proven by the observed turn terminal alone is equally specific.
  assert.equal(timeoutReplacesResult(result('completed', { exitCode: 0 }), TURN_COMPLETED), false)
  assert.equal(timeoutReplacesResult(result('completed', { exitCode: 0 }), null), false)
})

test('an explicitly incomplete completed result is not a success to preserve, but is still kept', () => {
  const incomplete = result('completed', { exitCode: 0, incomplete: true })
  assert.equal(timeoutReplacesResult(incomplete, TURN_COMPLETED), false)
})

test('only a cooperative cancellation without terminal evidence is replaced by the deadline', () => {
  assert.equal(timeoutReplacesResult(
    result('cancelled', { exitCode: 1, lastEvent: TURN_CANCELLED }),
    TURN_CANCELLED,
  ), true)
  assert.equal(timeoutReplacesResult(result('cancelled', { exitCode: 1 }), null), true)
  assert.equal(timeoutReplacesResult(result('cancelled', { exitCode: 1 }), { type: 'turn.cancelled', payload: null }), true)
})

test('a cancellation with an observed completed terminal cannot be relabelled as a pure timeout', () => {
  assert.equal(timeoutReplacesResult(
    result('cancelled', { exitCode: 1, lastEvent: TURN_CANCELLED }),
    TURN_COMPLETED,
  ), false)
})

test('a returned completed event cannot override an observed final failure or a different completion', () => {
  const completed = { type: 'turn.completed', turnId: 'turn-a', payload: { text: 'answer-a' } }
  for (const observed of [
    { type: 'turn.failed', payload: { code: 'TURN_PERSISTENCE_FAILED' } },
    { type: 'turn.completed', turnId: 'turn-b', payload: { text: 'answer-a' } },
    { type: 'turn.completed', turnId: 'turn-a', payload: { text: 'answer-b' } },
  ]) assert.equal(runResultSucceeded(result('completed', { exitCode: 0, lastEvent: completed }), observed), false)
})

test('waiting and approval observations do not turn a subsequent cooperative cancellation into a final outcome', () => {
  for (const type of ['turn.waiting', 'turn.awaiting_approval']) {
    assert.equal(timeoutReplacesResult(result('cancelled', { exitCode: 1, lastEvent: TURN_CANCELLED }), { type, payload: {} }), true)
  }
})

test('cancelled envelopes with specific unknown-result evidence cannot be simplified to a deadline', () => {
  for (const payload of [{ code: 'MODEL_REQUEST_RESULT_UNKNOWN' }, { incompleteReason: 'side_effect_outcome_unknown' },
    { recoveryKind: 'model_request_outcome_unknown' }, { unsafeToReplay: true }]) {
    assert.equal(timeoutReplacesResult(result('cancelled', { exitCode: 1 }), { type: 'turn.cancelled', payload }), false)
  }
})

test('a historical interrupted state followed by the actual completed observer remains a success', () => {
  assert.equal(runResultSucceeded(result('completed', { exitCode: 0, lastEvent: TURN_COMPLETED }), TURN_COMPLETED), true)
})

test('completed evidence checks explicit envelope identity without requiring identities on legacy results', () => {
  const event = { type: 'turn.completed', sessionId: 'session-one', turnId: 'turn-one', payload: {} }
  assert.equal(runResultSucceeded(result('completed', { exitCode: 0 }), event), true)
  assert.equal(runResultSucceeded(result('completed', { exitCode: 0, sessionId: 'session-one', turnId: 'turn-one' }), event), true)
  for (const field of ['sessionId', 'turnId']) {
    assert.equal(runResultSucceeded(result('completed', { exitCode: 0, [field]: 'other' }), event), false)
    assert.equal(runResultSucceeded(result('completed', { exitCode: 0, [field]: 'other', lastEvent: event })), false)
  }
})

test('failed, blocked, interrupted and unknown terminals survive the deadline', () => {
  for (const status of ['failed', 'blocked', 'interrupted', 'unknown']) {
    const terminal = { type: `turn.${status}`, payload: { code: 'SIDE_EFFECT_UNKNOWN' } }
    assert.equal(timeoutReplacesResult(result(status, { exitCode: 1, lastEvent: terminal }), terminal), false)
  }
})
