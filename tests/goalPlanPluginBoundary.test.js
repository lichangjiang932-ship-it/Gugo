import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { prepareRuntimeCapabilitySnapshot } from '../server/core/runtimeCapabilityHost.js'
import { registerPlugin, unregisterPlugin } from '../server/plugins/pluginRegistry.js'
import { createGoalPlan } from '../server/services/goalPlanService.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { getToolMetadata, listAllSpecs } from '../server/utils/toolSchemaCatalog.js'

const toolName = 'manage_todos'
const spec = { type: 'function', function: { name: toolName, description: 'Offline replacement fixture.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } } }
let userId
before(async () => {
  await prepareRuntimeCapabilitySnapshot({ env: { APP_DATA_DIR: process.env.APP_DATA_DIR, GUGO_LOAD_DOTENV: '0' } })
  const issued = issueEmailCode({ email: 'goal-plugin-gate@example.invalid' })
  userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
})
after(() => closeDb())

for (const approvalMode of ['normal', 'bypass']) {
  test(`a real control-name plugin cannot bypass an unapproved goal in ${approvalMode} mode`, async () => {
    const sessionId = `goal-plugin-${approvalMode}`
    upsertSession({ id: sessionId, userId, title: sessionId })
    createGoalPlan({ userId, sessionId, objective: 'Review before executing the fixture', steps: [{ title: 'Run fixture' }] })
    let executions = 0
    let modelCalls = 0
    const pluginId = `goal-control-${approvalMode}`
    await registerPlugin({ id: pluginId, name: pluginId, version: '1.0.0', contributes: [`tool:${toolName}`] }, (context) => {
      context.tools.register({ name: toolName, spec, replaces: `builtin.tool.${toolName}`, priority: 100,
        exec: async () => { executions += 1; return { ok: true, value: 'offline fixture' } } })
    })
    try {
      assert.equal(getToolMetadata(toolName, { userId }).origin, 'plugin')
      assert.equal(getToolMetadata(toolName, { userId }).isReadOnly, false)
      const dynamicSpec = listAllSpecs().find((entry) => entry.name === toolName && entry.origin === 'plugin')?.tool
      assert.ok(dynamicSpec)
      // Prove that the exact selected registry entry reaches the real dispatcher.
      assert.equal((await executeServerTool({ name: toolName, args: { note: 'direct fixture' }, job: { userId } })).ok, true)
      assert.equal(executions, 1)
      executions = 0
      const result = await runToolLoop({ job: { id: sessionId, userId, sessionId, origin: 'chat',
        prompt: 'Use manage_todos once and report its returned value.' }, step: { id: sessionId, kind: 'chat' },
      messages: [{ role: 'user', content: 'Use manage_todos once and report its returned value.' }],
      toolSpecs: [dynamicSpec], approvalMode, enableToolHooks: false, maxIters: 2,
      requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture-approved' }),
      executeTool: executeServerTool,
      runModel: async () => ++modelCalls === 1 ? { content: '', toolCalls: [{ id: 'plugin-goal-call', type: 'function',
        function: { name: toolName, arguments: JSON.stringify({ note: 'fixture' }) } }] }
        : { content: 'The fixture returned a value.', toolCalls: [] },
      })
      assert.equal(executions, 0)
      assert.equal(modelCalls, 1, 'a blocked goal must not request model wrap-up')
      assert.equal(result.code, 'GOAL_PLAN_APPROVAL_REQUIRED')
    } finally {
      await unregisterPlugin(pluginId)
    }
    assert.equal(getToolMetadata(toolName, { userId }).origin, 'builtin')
  })
}
