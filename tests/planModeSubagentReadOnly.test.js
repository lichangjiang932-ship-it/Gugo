import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { closeDb, createUser } from '../server/db.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { runSubagentToolLoop } from '../server/services/subagentToolLoop.js'
import { SUBAGENT_TYPES } from '../server/services/subagentRuntime.js'
import { getSubagentExecutionPolicy } from '../server/services/subagentExecutionPolicy.js'
import { getBuiltinSpec } from '../server/services/toolRegistry.js'
import { getToolMetadata } from '../server/utils/toolSchemaCatalog.js'

// Plan mode tells the user it may "start read-only subagents". That promise is
// kept by two links that live in different files: the parent's plan gate only
// admits explore/plan Agent calls, and the approval context the parent hands
// to the Agent tool carries readOnly, which the child loop uses to narrow its
// tools and to refuse a forged write. This test walks the whole chain with the
// real approval gate on the parent side and a real child loop.

const USER = 'plan-mode-subagent-owner'
createUser({ id: USER, email: 'plan-mode-subagent@example.test' })
// The stored permission mode is what the gate reads; the loop argument is what
// shapes the schema and the child binding. A real turn sets both from one value.
setApprovalMode({ userId: USER, mode: 'plan' })
after(() => closeDb())
const ENV = Object.freeze({ MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-plan-model' })

function agentCall(id, args) {
  return { id, type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args) } }
}

async function parentTurnInPlanMode() {
  const executions = []
  const completed = []
  let modelCalls = 0
  await runToolLoop({
    job: { id: 'plan-mode-parent', userId: USER, origin: 'chat', prompt: 'Research the router before planning.' },
    step: { id: 'plan-mode-parent-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Research the router before planning.' }],
    toolSpecs: [getBuiltinSpec('Agent'), getBuiltinSpec('read_file')],
    approvalMode: 'plan',
    maxIters: 3,
    enableToolHooks: false,
    onToolCompleted: (outcome) => completed.push(outcome),
    runModel: async () => (++modelCalls === 1 ? { content: '', toolCalls: [
      agentCall('agent-general', { subagent_type: 'general', prompt: 'Edit the router.' }),
      agentCall('agent-explore', { subagent_type: 'explore', prompt: 'Find the router.' }),
    ] } : { content: 'The plan is ready.', toolCalls: [] }),
    executeTool: async ({ name, args, approvalContext }) => {
      executions.push({ name, type: args.subagent_type, approvalContext })
      return { ok: true, result: 'fixture child report' }
    },
  })
  return { executions, completed }
}

test('plan mode admits only a read-only subagent, and hands it a read-only context', async () => {
  const { executions, completed } = await parentTurnInPlanMode()
  const general = completed.find((outcome) => outcome.call?.id === 'agent-general')
  assert.equal(general?.result?.ok, false)
  assert.equal(general.result.code, 'policy_denied_plan_mode', JSON.stringify(general.result))
  assert.equal(general.result.executed === true, false)
  assert.deepEqual(executions.map((entry) => entry.type), ['explore'], 'a general subagent never starts in plan mode')
  const policy = getSubagentExecutionPolicy(executions[0].approvalContext, { userId: USER })
  assert.equal(policy?.readOnly, true, 'the context handed to the Agent tool is bound read-only')
})

test('a child started with that context cannot write, even with the general tool set', async () => {
  const { executions } = await parentTurnInPlanMode()
  const childExecutions = []
  const presented = []
  let modelCalls = 0
  await runSubagentToolLoop({
    userId: USER, sessionId: 'subagent:plan-mode-child', runId: 'plan-mode-child', locale: 'en',
    messages: [{ role: 'user', content: 'Change the router.' }],
    // The widest tool set on purpose: only the inherited policy narrows it.
    tools: SUBAGENT_TYPES.general.tools,
    modelRuntimeEnv: ENV, approvalContext: executions[0].approvalContext, runToolLoop, maxIters: 3,
    approveTool: async ({ args }) => ({ proceed: true, args, approvalId: 'plan-mode-child-approval' }),
    callModel: async ({ tools }) => {
      presented.push(tools.map((tool) => tool.function.name))
      return ++modelCalls === 1 ? { content: '', toolCalls: [
        { id: 'forged-write', type: 'function', function: { name: 'write_file',
          arguments: JSON.stringify({ path: 'router.js', content: 'overwritten' }) } },
        { id: 'forged-shell', type: 'function', function: { name: 'bash_exec',
          arguments: JSON.stringify({ command: 'echo overwritten > router.js' }) } },
      ] } : { content: 'Reported back.', toolCalls: [] }
    },
    executeTool: async (name) => { childExecutions.push(name); return { ok: true } },
  })
  for (const names of presented) {
    for (const name of names) {
      assert.equal(getToolMetadata(name, { userId: USER }).isReadOnly, true, `${name} is shown to a plan-mode child`)
    }
  }
  assert.equal(presented[0].includes('write_file'), false)
  assert.deepEqual(childExecutions, [], 'a forged write or command never reaches a dispatcher')
})
