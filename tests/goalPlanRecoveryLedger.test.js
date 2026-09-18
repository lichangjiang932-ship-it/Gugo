import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateToV79 } from '../server/migrations/v79SideEffectExecutions.js'
import { migrateToV92 } from '../server/migrations/v92HookSideEffectExecutions.js'
import { migrateToV96 } from '../server/migrations/v96SideEffectRecoveryPlans.js'
import { createSideEffectExecutionLedger, createSideEffectScope, sideEffectRecoveryBlock,
  SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_OUTCOME_UNKNOWN } from '../server/services/sideEffectExecutionLedger.js'
import { createSideEffectExecution } from '../server/services/loop/sideEffectExecution.js'
import { executeAuthorizedTool } from '../server/services/loop/runtime-toolCallExecution.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { executeToolWithRetry } from '../server/utils/toolCallErrors.js'
import { getBuiltinSpec, getToolMetadata } from '../server/utils/toolSchemaCatalog.js'

function fixture() {
  const db = new Database(':memory:')
  migrateToV79(db)
  migrateToV92(db)
  migrateToV96(db)
  const ledger = createSideEffectExecutionLedger({ db })
  const job = { id: 'goal-ledger-job', userId: 'goal-ledger-owner', prompt: 'Continue the recorded operation.' }
  const step = { id: 'goal-ledger-step' }
  const args = { path: 'never-written.txt', content: 'isolated fixture' }
  const call = { id: 'goal-ledger-call', name: 'write_file', args, argumentsText: JSON.stringify(args),
    idempotencyKey: 'goal-ledger-key', checkpointStatus: 'executing', checkpointReadOnly: false,
    checkpointExecutionArgs: args }
  const input = { scope: createSideEffectScope({ job, step, approvalOrigin: 'job' }), toolCallId: call.id,
    toolName: call.name, idempotencyKey: call.idempotencyKey, args }
  ledger.prepare(input)
  ledger.claimExecution(input)
  const execution = createSideEffectExecution({ ledger, toolName: call.name, call, job, step,
    approvalOrigin: 'job', durableToolNames: new Set(['write_file']), createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock, conflictCode: SIDE_EFFECT_LEDGER_CONFLICT, unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN })
  return { db, ledger, job, step, call, input, execution }
}

test('a real ledger preserves unknown outcome as primary when a resumable operation loses goal approval', async () => {
  const { db, ledger, job, step, call, input, execution } = fixture()
  let executions = 0
  try {
    assert.equal(execution.recover(call.args, { allowIdempotentResume: true }).resumedExecuting, true)
    await assert.rejects(executeAuthorizedTool({ state: { job, step, signal: new AbortController().signal,
      checkpointBarrier: { beforeSideEffect: async () => {} },
      goalExecutionValidationError: () => ({ ok: false, goalPlanBlocked: true, code: 'GOAL_PLAN_CHANGED' }),
      executeTool: async () => { executions += 1; return { ok: true } },
    }, iteration: { markCall: async () => {} }, call, toolName: call.name, executionArgs: call.args,
    gate: {}, durableExecution: false, resumedExecutingSideEffect: true, sideEffectExecution: execution,
    dependencies: { executeToolWithRetry, getToolMetadata,
      createToolAbortScope: (signal) => ({ signal, dispose() {} }),
      isSuccessfulToolResult: (value) => value?.ok === true, isLoopPauseResult: () => false,
      normalizeArtifactIdList: () => [], rememberApprovedSubagentCall: () => {},
    } }), (error) => {
      assert.equal(error.code, SIDE_EFFECT_OUTCOME_UNKNOWN)
      assert.equal(error.unsafeToReplay, true)
      assert.equal(error.goalPlanCauseCode, 'GOAL_PLAN_CHANGED')
      return true
    })
    assert.equal(executions, 0)
    assert.equal(ledger.read(input).status, 'unknown')
  } finally { db.close() }
})

test('a real unknown ledger stops a checkpoint before new goal checks, tools, or model wrap-up', async () => {
  const { db, ledger, job, step, call, input } = fixture()
  let executions = 0
  let modelCalls = 0
  try {
    const checkpoint = { iterations: 0, toolCalls: [call], goalPlanBinding: { version: 1, planId: 'obsolete-plan', revision: 1 },
      messages: [{ role: 'user', content: job.prompt }, { role: 'assistant', content: null,
        tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }] }
    await assert.rejects(runToolLoop({ job, step, messages: [], toolSpecs: [getBuiltinSpec('write_file')],
      loadCheckpoint: async () => checkpoint, sideEffectLedger: ledger, enableToolHooks: false,
      executeTool: async () => { executions += 1; return { ok: true } },
      runModel: async () => { modelCalls += 1; return { content: 'must not run', toolCalls: [] } },
    }), (error) => error.code === SIDE_EFFECT_OUTCOME_UNKNOWN && error.requiresUserVerification === true)
    assert.equal(executions, 0)
    assert.equal(modelCalls, 0)
    assert.equal(ledger.read(input).status, 'unknown')
  } finally { db.close() }
})
