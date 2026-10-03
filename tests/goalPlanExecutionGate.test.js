import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { createGoalPlan, rewriteGoalPlan } from '../server/services/goalPlanService.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { executeAuthorizedTool } from '../server/services/loop/runtime-toolCallExecution.js'

after(() => closeDb())
const issued = issueEmailCode({ email: 'goal-gate@example.invalid' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
const spec = { type: 'function', function: { name: 'echo_tool', description: 'Fixture side effect.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }

async function runFixture({ sessionId, approvalMode = 'normal', duringApproval = () => {} }) {
  let modelCalls = 0
  let executions = 0
  const checkpoints = []
  const result = await runToolLoop({
    job: { id: `turn-${sessionId}`, userId, sessionId, origin: 'chat', prompt: 'Use echo_tool once, then answer.' },
    step: { id: `step-${sessionId}`, kind: 'chat' },
    messages: [{ role: 'user', content: 'Use echo_tool once, then answer.' }],
    toolSpecs: [spec], enableToolHooks: false, maxIters: 3, approvalMode,
    saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint?.state || checkpoint)) },
    requestToolApproval: async ({ args }) => {
      duringApproval()
      return { proceed: true, args, approvalId: 'fixture-approval' }
    },
    runModel: async () => {
      modelCalls += 1
      return modelCalls === 1 ? { content: '', toolCalls: [{ id: 'fixture-call', type: 'function',
        function: { name: 'echo_tool', arguments: JSON.stringify({ text: 'hello' }) } }] }
        : { content: 'The requested fixture action completed.', toolCalls: [] }
    },
    executeTool: async () => { executions += 1; return { ok: true, value: 'hello' } },
  })
  return { result, executions, modelCalls, checkpoints }
}

test('unapproved goal blocks new side effects in every tool approval mode without model wrap-up', async () => {
  for (const approvalMode of ['normal', 'acceptEdits', 'bypass']) {
    const sessionId = `gate-${approvalMode}`
    upsertSession({ id: sessionId, userId, title: sessionId })
    createGoalPlan({ userId, sessionId, objective: 'Fixture work needs plan approval', steps: [{ title: 'Execute fixture' }] })
    const outcome = await runFixture({ sessionId, approvalMode })
    assert.equal(outcome.executions, 0, approvalMode)
    assert.equal(outcome.modelCalls, 1, 'waiting for goal approval must not call a wrap-up model')
    assert.equal(outcome.result.code, 'GOAL_PLAN_APPROVAL_REQUIRED')
    assert.equal(outcome.result.incomplete, true)
    assert.ok(outcome.checkpoints.some((checkpoint) => checkpoint.goalPlanBinding?.planId))
  }
})

test('an approved plan rewritten during tool approval cannot execute the obsolete call', async () => {
  const sessionId = 'gate-revision'
  upsertSession({ id: sessionId, userId, title: sessionId })
  const plan = createGoalPlan({ userId, sessionId, objective: 'Original work', requireApproval: false,
    steps: [{ title: 'Execute original fixture' }] })
  let rewritten = false
  const outcome = await runFixture({ sessionId, duringApproval: () => {
    if (rewritten) return
    rewritten = true
    rewriteGoalPlan({ userId, planId: plan.id, objective: 'Changed work', requireApproval: false,
      steps: [{ title: 'Different fixture' }] })
  } })
  assert.equal(rewritten, true)
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.modelCalls, 1)
  assert.equal(outcome.result.code, 'GOAL_PLAN_CHANGED')
})

test('no active plan preserves the ordinary tool loop', async () => {
  const sessionId = 'gate-no-plan'
  upsertSession({ id: sessionId, userId, title: sessionId })
  const outcome = await runFixture({ sessionId })
  assert.equal(outcome.executions, 1)
  assert.ok(!String(outcome.result.code || '').startsWith('GOAL_PLAN_'))
})

test('already confirmed ledger output is returned without a new goal authorization or execution', async () => {
  let goalChecks = 0
  const execution = await executeAuthorizedTool({ state: {
    goalExecutionValidationError: () => { goalChecks += 1; throw new Error('must not reauthorize completed output') },
  }, executionArgs: {}, sideEffectExecution: { prepare: () => ({ replayed: true, result: { ok: true, receipt: 'existing' } }) },
  dependencies: {} })
  assert.equal(execution.result.receipt, 'existing')
  assert.equal(execution.toolExecutionAttempted, false)
  assert.equal(goalChecks, 0)
})
