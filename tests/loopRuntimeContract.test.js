import assert from 'node:assert/strict'
import test from 'node:test'

import { completeToolBatch } from '../server/services/loop/runtime-completeToolBatch.js'
import { createOutcomeRecorder } from '../server/services/loop/runtime-createOutcomeRecorder.js'
import { executeToolCalls } from '../server/services/loop/runtime-executeToolCalls.js'
import { executeAuthorizedTool } from '../server/services/loop/runtime-toolCallExecution.js'
import { resolveExecutionBudgetOptions } from '../server/services/loop/runtime-initializeSteering.js'
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

test('background Job cost limits never gate ordinary chat or restored chat turns', () => {
  const restored = {
    maxTotalCalls: 120,
    maxModelCalls: 40,
    maxModelTokens: 80_000,
    maxCostUsd: 2,
    initialCostEvidenceComplete: false,
  }

  const chat = resolveExecutionBudgetOptions({ origin: 'chat' }, restored)
  assert.equal(Object.hasOwn(chat, 'maxCostUsd'), false)
  assert.equal(chat.maxTotalCalls, restored.maxTotalCalls)
  assert.equal(chat.maxModelCalls, restored.maxModelCalls)
  assert.equal(chat.maxModelTokens, restored.maxModelTokens)
  assert.equal(chat.initialCostEvidenceComplete, false)
  assert.equal(restored.maxCostUsd, 2, 'checkpoint input must remain immutable')

  assert.equal(resolveExecutionBudgetOptions({ origin: 'chat' }), undefined)
  const background = resolveExecutionBudgetOptions({ origin: 'job' }, restored)
  assert.equal(Object.hasOwn(background, 'maxCostUsd'), false)
  assert.notStrictEqual(background, restored)
})

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

test('authorized Hook provenance is persisted with the executing tool checkpoint', async () => {
  const writes = []
  const provenance = Object.freeze({ kind: 'pre_tool_use_hook', invocationId: 'hook-invocation' })
  const state = {
    job: { id: 'job-hook-checkpoint', userId: 'user-hook-checkpoint' },
    step: { id: 'step-hook-checkpoint' },
    approvalOrigin: 'job',
    approvalSessionId: null,
    signal: null,
    toolRetryMaxAttempts: 1,
    toolRetryBaseDelayMs: 1,
    checkpointBarrier: { beforeSideEffect: async () => {} },
    executeTool: async () => ({ ok: true }),
    subagentApprovalContext: null,
    activeArtifactOutputPrompt: null,
    explicitSkillId: null,
    stepArtifactTools: [],
    requiresLocalArtifactDelivery: false,
  }
  const sideEffectExecution = {
    prepare: () => ({ replayed: false, input: null, resumedExecuting: false }),
    finish: () => {},
    rethrowExecutionError: ({ error }) => { throw error },
  }

  await executeAuthorizedTool({
    state,
    iteration: { markCall: async (_call, update) => writes.push(update) },
    call: { id: 'call-hook-checkpoint', idempotencyKey: 'idem-hook-checkpoint' },
    toolName: 'write_file',
    executionArgs: { path: 'checkpoint.txt', content: 'x' },
    gate: {
      proceed: true,
      hookAuthorized: true,
      hookAuthorizationProvenance: provenance,
      policyProvenance: { id: 'builtin.harness-policy' },
    },
    durableExecution: true,
    checkpointPolicyProvenance: null,
    resumedExecutingSideEffect: false,
    sideEffectExecution,
    expectedDynamicRegistrationId: null,
    dependencies: {
      CHECKPOINT_FLUSH_ERROR_CODE: 'CHECKPOINT_FLUSH_FAILED',
      createToolAbortScope: () => ({ signal: null, dispose: () => {} }),
      executeToolWithRetry: async ({ execute }) => execute({ attempt: 1 }),
      getToolMetadata: () => ({ isReadOnly: false, interruptBehavior: 'cooperative' }),
      isLoopPauseResult: () => false,
      isSuccessfulToolResult: (result) => result?.ok === true,
      normalizeArtifactIdList: () => [],
      rememberApprovedSubagentCall: () => {},
    },
  })

  assert.equal(writes.length, 1)
  assert.equal(writes[0].checkpointStatus, 'executing')
  assert.equal(writes[0].checkpointHookAuthorizationProvenance, provenance)
})

test('resumed write_file receives durable recovery-plan access and commits its verified result', async () => {
  const sideEffectInput = { identity: 'durable-write' }
  const persistedPlan = {
    version: 1,
    kind: 'local-file-write',
    after: { exists: true, type: 'file', bytes: 1, sha256: 'digest' },
  }
  const calls = []
  let finished = null
  const state = {
    job: { id: 'job-write-recovery', userId: 'user-write-recovery' },
    step: { id: 'step-write-recovery' },
    approvalOrigin: 'job',
    approvalSessionId: null,
    signal: null,
    toolRetryMaxAttempts: 1,
    toolRetryBaseDelayMs: 1,
    checkpointBarrier: { beforeSideEffect: async () => {} },
    executeTool: async (request) => {
      calls.push(request)
      assert.equal(request.idempotentResume, true)
      assert.deepEqual(request.sideEffectRecoveryPlan.read(), persistedPlan)
      assert.deepEqual(request.sideEffectRecoveryPlan.prepare(persistedPlan), persistedPlan)
      return { ok: true, path: 'verified.txt', idempotencyRecovered: true }
    },
    subagentApprovalContext: null,
    activeArtifactOutputPrompt: null,
    explicitSkillId: null,
    stepArtifactTools: [],
    requiresLocalArtifactDelivery: false,
  }
  const sideEffectExecution = {
    prepare: (_args, options) => {
      assert.equal(options.resumeExecuting, true)
      return { replayed: false, input: sideEffectInput, resumedExecuting: true }
    },
    prepareRecoveryPlan: (input, plan) => {
      assert.strictEqual(input, sideEffectInput)
      assert.deepEqual(plan, persistedPlan)
      return plan
    },
    readRecoveryPlan: (input) => {
      assert.strictEqual(input, sideEffectInput)
      return persistedPlan
    },
    finish: (input, result, isSuccessful) => {
      finished = { input, result, successful: isSuccessful(result) }
    },
    rethrowExecutionError: ({ error }) => { throw error },
  }

  const execution = await executeAuthorizedTool({
    state,
    iteration: { markCall: async () => {} },
    call: { id: 'call-write-recovery', idempotencyKey: 'idem-write-recovery' },
    toolName: 'write_file',
    executionArgs: { path: 'verified.txt', content: 'x' },
    gate: { proceed: true },
    durableExecution: true,
    checkpointPolicyProvenance: null,
    resumedExecutingSideEffect: true,
    sideEffectExecution,
    expectedDynamicRegistrationId: null,
    dependencies: {
      CHECKPOINT_FLUSH_ERROR_CODE: 'CHECKPOINT_FLUSH_FAILED',
      createToolAbortScope: () => ({ signal: null, dispose: () => {} }),
      executeToolWithRetry: async ({ execute }) => execute({ attempt: 1 }),
      getToolMetadata: () => ({ isReadOnly: false, interruptBehavior: 'cooperative' }),
      isLoopPauseResult: () => false,
      isSuccessfulToolResult: (result) => result?.ok === true,
      normalizeArtifactIdList: () => [],
      rememberApprovedSubagentCall: () => {},
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(execution.result.idempotencyRecovered, true)
  assert.deepEqual(finished, {
    input: sideEffectInput,
    result: execution.result,
    successful: true,
  })
})
