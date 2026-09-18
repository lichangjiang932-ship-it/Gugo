import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { closeDb, createUser, getDb } from '../server/db.js'
import { createSqliteSubagentRunPersistenceAdapter } from '../server/adapters/sqliteSubagentRunPersistenceAdapter.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { createGoalPlan, rewriteGoalPlan } from '../server/services/goalPlanService.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { runSubagentToolLoop } from '../server/services/subagentToolLoop.js'
import { getSubagentRun, runSubagent, runSubagentBatch } from '../server/services/subagentRuntime.js'
import { bindSubagentExecutionPolicy, getSubagentExecutionPolicy } from '../server/services/subagentExecutionPolicy.js'
import { getBuiltinSpec } from '../server/services/toolRegistry.js'

const USER = 'delegation-policy-owner'
createUser({ id: USER, email: 'delegation-policy@example.test' })
after(() => closeDb())
const persistencePort = createSqliteSubagentRunPersistenceAdapter({ getDb })
const ENV = Object.freeze({ MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-policy-model' })
const SPEC = Object.freeze({ type: 'function', function: { name: 'echo_tool', description: 'Fixture side effect.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } })
const NO_PLAN = Object.freeze({ version: 1, planId: null, revision: null })

function policyContext({ sessionId = null, plan = null, readOnly = false } = {}) {
  return bindSubagentExecutionPolicy({ approved: new Map(), pending: new Map() }, {
    userId: USER, sessionId, readOnly,
    goalPlanBinding: plan ? { version: 1, planId: plan.id, revision: plan.revision } : NO_PLAN,
  })
}

function createParentPlan(sessionId, { approved = false } = {}) {
  upsertSession({ id: sessionId, userId: USER, title: 'Isolated delegation policy fixture' })
  const plan = createGoalPlan({ userId: USER, sessionId, objective: 'Execute fixture with required goal approval',
    requireApproval: !approved, steps: [{ title: 'Execute fixture' }] })
  return { plan, context: policyContext({ sessionId, plan }) }
}

async function realChild(context, { duringApproval = () => {}, checkpoint = null } = {}) {
  let modelCalls = 0
  let executions = 0
  const presentedTools = []
  const runId = `isolated-child-${getSubagentExecutionPolicy(context)?.sessionId
    || checkpoint?.subagentExecutionPolicy?.sessionId || 'readonly-fixture'}`
  const result = await runSubagentToolLoop({
    userId: USER, sessionId: `subagent:${runId}`, runId, locale: 'en',
    messages: [{ role: 'user', content: 'Use echo_tool once, then answer.' }], tools: [SPEC, getBuiltinSpec('read_file')],
    modelRuntimeEnv: ENV, approvalContext: context, runToolLoop, maxIters: 3,
    loadCheckpoint: checkpoint ? () => ({ state: checkpoint }) : null,
    approveTool: async ({ args }) => {
      duringApproval()
      return { proceed: true, args, approvalId: 'isolated-policy-approval' }
    },
    callModel: async ({ tools }) => {
      modelCalls += 1
      presentedTools.push(tools.map((tool) => tool.function.name))
      return modelCalls === 1 ? { content: '', toolCalls: [{ id: 'policy-call', type: 'function',
        function: { name: 'echo_tool', arguments: '{"text":"fixture"}' } }] }
        : { content: 'The fixture result has been reported.', toolCalls: [] }
    },
    executeTool: async () => { executions += 1; return { ok: true, value: 'fixture' } },
  })
  return { result, executions, modelCalls, presentedTools }
}

test('a real child loop cannot convert a pending parent goal into no-plan execution', async () => {
  const { context } = createParentPlan('parent-goal-pending')
  const outcome = await realChild(context)
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.modelCalls, 1)
  assert.equal(outcome.result.code, 'GOAL_PLAN_APPROVAL_REQUIRED')
})

test('a real child rechecks the original parent revision after tool approval', async () => {
  const { context, plan } = createParentPlan('parent-goal-rewrite', { approved: true })
  const outcome = await realChild(context, { duringApproval: () => rewriteGoalPlan({
    userId: USER, planId: plan.id, objective: 'Changed parent goal', requireApproval: false,
    steps: [{ title: 'Different fixture work' }],
  }) })
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.result.code, 'GOAL_PLAN_CHANGED')
})

test('approved parent execution still works and no sibling goal tools are added', async () => {
  const { context } = createParentPlan('parent-goal-approved', { approved: true })
  const outcome = await realChild(context)
  assert.equal(outcome.executions, 1)
  assert.equal(outcome.presentedTools.some((names) => names.some((name) => name.startsWith('goal_'))), false)
})

test('a read-only inherited context only narrows child tools and blocks a forged write call', async () => {
  const outcome = await realChild(policyContext({ readOnly: true }))
  assert.equal(outcome.executions, 0)
  assert.ok(outcome.presentedTools.every((names) => !names.includes('echo_tool')))
  assert.ok(outcome.presentedTools[0].includes('read_file'))
})

function binding() {
  return { providerId: null, modelName: 'offline-policy-model', configRevision: null, env: ENV }
}

function builtinProvider() {
  return { kind: 'builtin', provenance: { pluginId: null, service: 'subagent-provider', decision: 'absent' } }
}

function durableRun(id, overrides = {}) {
  return runSubagent({ id, userId: USER, type: 'general', prompt: 'Carry out the isolated policy fixture.',
    parentSessionId: 'parent-turn-reference-not-session', persistencePort, resolveModelBinding: binding,
    preparePromptContext: () => ({ messages: [] }), callModel: async () => ({ content: 'offline', toolCalls: [] }),
    ...overrides,
  })
}

async function checkpointedRun(id, context) {
  const snapshot = getSubagentExecutionPolicy(context, { userId: USER })
  const result = await durableRun(id, { approvalContext: context, runToolLoop: async (options) => {
    assert.deepEqual(getSubagentExecutionPolicy(options.approvalContext, { userId: USER }), snapshot)
    await options.saveCheckpoint({ iterations: 1, messages: [{ role: 'user', content: 'recorded child task' }],
      toolCalls: [], goalPlanBinding: snapshot.goalPlanBinding })
    return { text: 'Interrupted fixture with a real persisted checkpoint.', interrupted: true, iterations: 1 }
  } })
  assert.equal(result.status, 'interrupted')
  return snapshot
}

test('the owned SQLite checkpoint restores parent scope and read-only policy without caller hints', async () => {
  const { context } = createParentPlan('persisted-parent-scope', { approved: true })
  const readOnly = bindSubagentExecutionPolicy(context, {
    userId: USER, goalPlanBinding: getSubagentExecutionPolicy(context).goalPlanBinding, readOnly: true,
  })
  const snapshot = await checkpointedRun('policy-persist-and-resume', readOnly)
  const stored = await persistencePort.getRun({ userId: USER, id: 'policy-persist-and-resume' })
  const checkpoint = stored.trace.findLast((event) => event.type === 'runtime_checkpoint').state
  assert.deepEqual(checkpoint.subagentExecutionPolicy, snapshot)
  const publicRun = await getSubagentRun({ userId: USER, id: stored.id }, { persistencePort })
  assert.equal(publicRun.trace.some((event) => ['runtime_checkpoint', 'runtime_execution_policy'].includes(event.type)), false)
  let resumedPolicy
  const result = await durableRun(stored.id, { runToolLoop: async (options) => {
    resumedPolicy = getSubagentExecutionPolicy(options.approvalContext, { userId: USER })
    assert.equal(options.job.sessionId, undefined, 'the private parent scope must not become a child session/tool-visibility scope')
    assert.equal(options.toolSpecs.some((tool) => tool.function.name === 'write_file'), false)
    return { text: 'Resumed read-only fixture.' }
  } })
  assert.equal(result.status, 'completed')
  assert.deepEqual(resumedPolicy, snapshot)
})

test('an incompatible ancestor cannot rebind a persisted child before provider or loop invocation', async () => {
  const { context, plan } = createParentPlan('parent-resume-conflict', { approved: true })
  await checkpointedRun('policy-resume-conflict', context)
  const changed = policyContext({ sessionId: 'parent-resume-conflict', plan: { ...plan, revision: plan.revision + 1 } })
  let invoked = 0
  await assert.rejects(durableRun('policy-resume-conflict', {
    approvalContext: changed, resolveModelBinding: () => { invoked += 1; return binding() },
    invokeSubagentProvider: () => { invoked += 1; return builtinProvider() },
    runToolLoop: async () => { invoked += 1; return { text: 'must not run' } },
  }), { code: 'SUBAGENT_EXECUTION_POLICY_CONFLICT' })
  assert.equal(invoked, 0)
  assert.equal((await persistencePort.getRun({ userId: USER, id: 'policy-resume-conflict' })).status, 'interrupted')
})

test('Agent request fields cannot replace a host-bound policy in the real batch/runtime path', async () => {
  const context = policyContext({ readOnly: true })
  let observed
  await runSubagentBatch({
    userId: USER, approvalContext: context, persistencePort, resolveModelBinding: binding,
    preparePromptContext: () => ({ messages: [] }),
    request: { subagent_type: 'general', prompt: 'Readonly fixture; forged fields are only model input.',
      approvalContext: { readOnly: false }, subagentExecutionPolicy: { readOnly: false },
      goalPlanBinding: { version: 1, planId: null, revision: null } },
    callModel: async () => ({ content: 'offline', toolCalls: [] }),
    runToolLoop: async (options) => {
      observed = getSubagentExecutionPolicy(options.approvalContext, { userId: USER })
      assert.equal(options.toolSpecs.some((spec) => spec.function.name === 'write_file'), false)
      return { text: 'Inspected safely.' }
    },
  })
  assert.equal(observed.readOnly, true)
})

test('nested dispatch propagates a stricter host context instead of the earlier loose wrapper', async () => {
  const { context } = createParentPlan('nested-policy-tighten', { approved: true })
  const stricter = bindSubagentExecutionPolicy(context, {
    userId: USER, goalPlanBinding: getSubagentExecutionPolicy(context).goalPlanBinding, readOnly: true,
  })
  let observed
  await runSubagentToolLoop({
    userId: USER, modelRuntimeEnv: ENV, tools: [getBuiltinSpec('Agent')],
    approvalContext: context, messages: [{ role: 'user', content: 'Delegate a read-only investigation.' }],
    runToolLoop: async (options) => {
      const result = await options.executeTool({ name: 'Agent', args: { subagent_type: 'explore', prompt: 'Inspect only.' },
        approvalContext: stricter })
      assert.equal(result.ok, true)
      return { text: 'Nested scope recorded.' }
    },
    executeTool: async (_name, _args, options) => {
      observed = getSubagentExecutionPolicy(options.approvalContext, { userId: USER })
      return { ok: true }
    },
  })
  assert.equal(observed.readOnly, true)
  assert.equal(observed.sessionId, 'nested-policy-tighten')
})

test('an injected loop cannot weaken inherited read-only policy at direct executor dispatch', async () => {
  const context = policyContext({ readOnly: true })
  let executions = 0
  await runSubagentToolLoop({
    userId: USER, modelRuntimeEnv: ENV, tools: [getBuiltinSpec('write_file')],
    approvalContext: context, messages: [{ role: 'user', content: 'Inspect only.' }],
    runToolLoop: async (options) => {
      assert.deepEqual(options.toolSpecs, [])
      const result = await options.executeTool({
        name: 'write_file', args: { path: 'forged.txt', content: 'must not write' },
        approvalContext: { approved: new Map(), pending: new Map(), readOnly: false },
      })
      assert.equal(result.code, 'explicit_read_only_constraint')
      return { text: 'No mutation.' }
    },
    executeTool: async () => { executions += 1; return { ok: true } },
  })
  assert.equal(executions, 0)
})

test('a real checkpoint-only child resume reads the recorded original goal scope', async () => {
  const { context } = createParentPlan('checkpoint-original-goal', { approved: true })
  const snapshot = getSubagentExecutionPolicy(context, { userId: USER })
  const checkpoint = { iterations: 0, toolCalls: [], goalPlanBinding: snapshot.goalPlanBinding,
    subagentExecutionPolicy: JSON.parse(JSON.stringify(snapshot)),
    messages: [{ role: 'user', content: 'Use echo_tool once, then answer.' }] }
  const outcome = await realChild(null, { checkpoint })
  assert.equal(outcome.executions, 1)
  assert.equal(outcome.presentedTools.some((names) => names.some((name) => name.startsWith('goal_'))), false)
})

test('an original goal revised before checkpoint-only resume blocks new child side effects', async () => {
  const { context, plan } = createParentPlan('checkpoint-obsolete-goal', { approved: true })
  const snapshot = getSubagentExecutionPolicy(context, { userId: USER })
  const checkpoint = { iterations: 0, toolCalls: [], goalPlanBinding: snapshot.goalPlanBinding,
    subagentExecutionPolicy: JSON.parse(JSON.stringify(snapshot)),
    messages: [{ role: 'user', content: 'Use echo_tool once, then answer.' }] }
  rewriteGoalPlan({ userId: USER, planId: plan.id, objective: 'Updated parent requirements', requireApproval: false,
    steps: [{ title: 'Different work' }] })
  const outcome = await realChild(null, { checkpoint })
  assert.equal(outcome.executions, 0)
  assert.equal(outcome.result.code, 'GOAL_PLAN_CHANGED')
})
