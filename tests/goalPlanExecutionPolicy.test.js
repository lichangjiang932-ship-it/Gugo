import assert from 'node:assert/strict'
import test from 'node:test'
import { goalPlanExecutionDecision, installGoalPlanExecutionGate, restoreGoalPlanBinding } from '../server/services/goalPlanExecutionPolicy.js'
import { executeAuthorizedTool } from '../server/services/loop/runtime-toolCallExecution.js'

function fixture(read) {
  return { job: { userId: 'owner', sessionId: 'session' }, locale: 'en', d: {
    goalToolContextForTurn: read,
    getToolMetadata: (name) => ({ origin: 'builtin', isReadOnly: name === 'read_file' }),
  } }
}

test('goal binding distinguishes none, unavailable, and an immutable plan revision', () => {
  let current = { active: true, planId: 'plan', revision: 1, status: 'awaiting_approval' }
  const state = fixture(() => current)
  installGoalPlanExecutionGate(state)
  const snapshot = structuredClone(state.goalPlanBinding)
  assert.equal(state.goalExecutionValidationError('write_file').code, 'GOAL_PLAN_APPROVAL_REQUIRED')
  assert.equal(state.goalExecutionValidationError('read_file'), null)
  assert.equal(state.goalExecutionValidationError('goal_plan_rewrite'), null)
  current = { ...current, status: 'approved' }
  assert.equal(state.goalExecutionValidationError('write_file'), null)
  const restored = { ...fixture(() => current), restoredState: { goalPlanBinding: snapshot } }
  installGoalPlanExecutionGate(restored)
  assert.equal(restored.goalExecutionValidationError('write_file'), null)
  current = { active: true, planId: 'replacement', revision: 2, status: 'approved' }
  assert.equal(restored.goalExecutionValidationError('write_file').code, 'GOAL_PLAN_CHANGED')
  assert.deepEqual(restored.goalPlanBinding, snapshot, 'live reads cannot silently rebind a running turn')
})

test('a failed plan lookup blocks writes but does not block read-only work or imply no plan', () => {
  const state = fixture(() => { throw new Error('private storage detail') })
  installGoalPlanExecutionGate(state)
  assert.equal(state.goalPlanBinding.unknown, true)
  const denied = state.goalExecutionValidationError('write_file')
  assert.equal(denied.code, 'GOAL_PLAN_STATE_UNAVAILABLE')
  assert.equal(denied.retryable, false)
  assert.equal(state.goalExecutionValidationError('read_file'), null)
  assert.ok(!JSON.stringify(denied).includes('private storage detail'))
})

test('legacy checkpoints capture current state and invalid new bindings fail closed', () => {
  const legacy = { ...fixture(() => ({ active: false })), restoredState: { iterations: 2 } }
  installGoalPlanExecutionGate(legacy)
  assert.deepEqual(legacy.goalPlanBinding, { version: 1, planId: null, revision: null })
  for (const invalid of [{ version: 2 }, { version: 1, planId: 'plan', revision: 0 }, null]) {
    assert.throws(() => restoreGoalPlanBinding(invalid), { code: 'GOAL_PLAN_BINDING_INVALID' })
  }
})

test('tool approval modes never grant goal approval', () => {
  const binding = { version: 1, planId: 'plan', revision: 1 }
  const current = { ...binding, status: 'awaiting_approval' }
  for (const approvalMode of ['normal', 'acceptEdits', 'bypass']) {
    assert.equal(goalPlanExecutionDecision({ binding, current, toolName: 'write_file', approvalMode }).allowed, false)
  }
})

test('goal control exemptions require the actual builtin origin, not a reserved name', () => {
  const binding = { version: 1, planId: 'plan', revision: 1 }
  const current = { ...binding, status: 'awaiting_approval' }
  for (const toolOrigin of ['plugin', 'mcp', 'unknown', undefined]) {
    const decision = goalPlanExecutionDecision({ binding, current, toolName: 'manage_todos', toolOrigin })
    assert.equal(decision.allowed, false, String(toolOrigin))
    assert.equal(decision.code, 'GOAL_PLAN_APPROVAL_REQUIRED')
    const state = fixture(() => ({ active: true, ...current }))
    state.d.getToolMetadata = () => ({ origin: toolOrigin, isReadOnly: false })
    installGoalPlanExecutionGate(state)
    assert.equal(state.goalExecutionValidationError('manage_todos').code, 'GOAL_PLAN_APPROVAL_REQUIRED')
  }
  assert.equal(goalPlanExecutionDecision({ binding, current, toolName: 'manage_todos', toolOrigin: 'builtin' }).allowed, true)
})

function executionInput({ state, sideEffectExecution }) {
  return { state, iteration: { markCall: async () => {} }, call: { id: 'call' }, toolName: 'write_file',
    executionArgs: {}, gate: {}, durableExecution: false, sideEffectExecution, dependencies: {
      createToolAbortScope: (signal) => ({ signal, dispose() {} }),
      executeToolWithRetry: ({ execute }) => execute({ attempt: 1 }),
      getToolMetadata: () => ({ isReadOnly: false }), isLoopPauseResult: () => false,
      isSuccessfulToolResult: (result) => result?.ok === true, normalizeArtifactIdList: () => [],
      rememberApprovedSubagentCall: () => {},
    } }
}

test('goal approval is rechecked after the checkpoint wait immediately before dispatch', async () => {
  let approved = true
  let executed = 0
  const state = { signal: new AbortController().signal, job: { userId: 'owner' },
    checkpointBarrier: { beforeSideEffect: async () => { approved = false } },
    goalExecutionValidationError: () => approved ? null : { ok: false, goalPlanBlocked: true, code: 'GOAL_PLAN_CHANGED' },
    executeTool: async () => { executed += 1; return { ok: true } },
  }
  const sideEffectExecution = { prepare: () => ({ replayed: false, input: null }),
    rethrowExecutionError: ({ error }) => { throw error } }
  const result = await executeAuthorizedTool(executionInput({ state, sideEffectExecution }))
  assert.equal(executed, 0)
  assert.equal(result.toolExecutionAttempted, false)
  assert.equal(result.result.code, 'GOAL_PLAN_CHANGED')
})

test('an in-flight side effect stays outcome-unknown when the goal becomes invalid', async () => {
  let markedUnknown = 0
  let executed = 0
  const state = { signal: new AbortController().signal, job: { userId: 'owner' },
    checkpointBarrier: { beforeSideEffect: async () => {} },
    goalExecutionValidationError: () => ({ ok: false, code: 'GOAL_PLAN_CHANGED', goalPlanBlocked: true }),
    executeTool: async () => { executed += 1 },
  }
  const sideEffectExecution = { prepare: () => ({ replayed: false, input: {}, resumedExecuting: true }),
    blockResumedExecution: () => { markedUnknown += 1 },
    recover: () => ({ result: { ok: false, code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', error: 'Verify the prior operation first.' } }),
    rethrowExecutionError: ({ error }) => { throw error } }
  const outcome = await executeAuthorizedTool(executionInput({ state, sideEffectExecution }))
  assert.equal(executed, 0)
  assert.equal(markedUnknown, 1)
  assert.equal(outcome.result.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
  assert.equal(outcome.result.goalPlanCauseCode, 'GOAL_PLAN_CHANGED')
  assert.equal(outcome.result.requiresUserVerification, true)
})
