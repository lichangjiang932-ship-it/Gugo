import assert from 'node:assert/strict'
import test from 'node:test'

import { completeToolBatch } from '../server/services/loop/runtime-completeToolBatch.js'
import { createOutcomeRecorder } from '../server/services/loop/runtime-createOutcomeRecorder.js'
import { executeToolCalls } from '../server/services/loop/runtime-executeToolCalls.js'
import {
  LOOP_RUNTIME_CONTRACT_ERROR_CODE,
  assertRuntimeDependencies,
  assertRuntimeStage,
} from '../server/services/loop/runtimeContract.js'

function isContractError(stage, missingField) {
  return (error) => {
    assert.equal(error?.code, LOOP_RUNTIME_CONTRACT_ERROR_CODE)
    assert.equal(error?.stage, stage)
    assert.ok(error?.missingFields.includes(missingField))
    return true
  }
}

test('runtime dependency bag validates its core bootstrap schema', () => {
  assert.throws(
    () => assertRuntimeDependencies({}),
    isContractError('runtime-dependencies', 'createCheckpointBarrier'),
  )
})

test('checkpoint state fails fast before budget and loop guard initialization', () => {
  assert.throws(
    () => assertRuntimeStage({}, 'checkpoint-state'),
    isContractError('checkpoint-state', 'budget'),
  )
})

test('tool phases report an actionable error when invoked out of order', async () => {
  await assert.rejects(
    executeToolCalls({ iteration: {} }),
    isContractError('execute-tool-calls', 'iteration.toolCalls'),
  )
  await assert.rejects(
    createOutcomeRecorder({ iteration: {} }),
    isContractError('create-outcome-recorder', 'iteration.markCall'),
  )
  await assert.rejects(
    completeToolBatch({ iteration: { toolCalls: [] } }),
    isContractError('complete-tool-batch', 'iteration.executeOne'),
  )
})
