import assert from 'node:assert/strict'
import test from 'node:test'

import { timeoutReplacesResult } from '../../bin/cli/runDeadline.js'

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
})

test('a cancellation with a observed completed terminal keeps that terminal', () => {
  assert.equal(timeoutReplacesResult(
    result('cancelled', { exitCode: 1, lastEvent: TURN_CANCELLED }),
    TURN_COMPLETED,
  ), false)
})

test('failed, blocked, interrupted and unknown terminals survive the deadline', () => {
  for (const status of ['failed', 'blocked', 'interrupted', 'unknown']) {
    const terminal = { type: `turn.${status}`, payload: { code: 'SIDE_EFFECT_UNKNOWN' } }
    assert.equal(timeoutReplacesResult(result(status, { exitCode: 1, lastEvent: terminal }), terminal), false)
  }
})
