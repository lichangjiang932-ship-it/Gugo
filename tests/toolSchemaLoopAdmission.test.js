import assert from 'node:assert/strict'
import test from 'node:test'

import { runToolsLoop } from '../server/services/jobTools.js'
import { closeDb, createUser } from '../server/db.js'
import { _testing as subagent } from '../server/services/subagentRuntime.js'

const userId = 'tool-schema-admission-owner'
createUser({ id: userId, email: 'schema-admission@example.test' })
test.after(() => closeDb())

function spec(valueSchema) {
  return { type: 'function', function: { name: 'read_file', parameters: {
    type: 'object', properties: { path: { type: 'string' }, value: valueSchema }, required: ['path', 'value'],
  } } }
}

let sequence = 0
async function run(valueSchema, value, { edited } = {}) {
  const outcomes = []
  const executions = []
  let approvals = 0
  let modelCalls = 0
  const request = { path: 'fixture.txt', value }
  await runToolsLoop({
    job: { id: `schema-admission-${sequence++}`, userId, origin: 'chat', prompt: 'Read the fixture using the supplied options.' },
    step: { id: 'schema-admission-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Read the fixture using the supplied options.' }],
    toolSpecs: [spec(valueSchema)], fallbackToolSpecs: [], maxIters: 2, enableToolHooks: false,
    requestToolApproval: async ({ args }) => {
      approvals += 1
      return { proceed: true, approvalId: 'isolated-schema-approval', args: edited ? edited(args) : args }
    },
    runModel: async () => modelCalls++ === 0 ? {
      content: '', toolCalls: [{ id: 'fixture-proposal', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(request) } }],
    } : { content: 'The fixture result is recorded.', toolCalls: [] },
    executeTool: async ({ args }) => { executions.push(structuredClone(args)); return { ok: true, content: 'fixture contents' } },
    onToolCompleted: (outcome) => { outcomes.push(outcome.result) },
  })
  return { approvals, executions, outcomes, request }
}

for (const [label, schema, value] of [
  ['union', { type: ['integer', 'null'] }, 'invalid'],
  ['const', { const: 'safe' }, 'invalid'],
  ['allOf', { allOf: [{ type: 'integer' }, { minimum: 1 }] }, 0],
  ['item201', { type: 'array', items: { type: 'integer' } }, [...Array.from({ length: 200 }, () => 1), 'invalid']],
]) {
  test(`actual loop rejects ${label} before approval or dispatcher side effects`, async () => {
    const result = await run(schema, value)
    assert.equal(result.approvals, 0)
    assert.deepEqual(result.executions, [])
    assert.equal(result.outcomes[0]?.code, 'tool_arguments_validation_failed')
  })
}

test('actual loop checks approval-edited parameters again and executes neither old nor edited call', async () => {
  const result = await run({ const: 'safe' }, 'safe', { edited: (args) => ({ ...args, value: 'unsafe' }) })
  assert.equal(result.approvals, 1)
  assert.deepEqual(result.executions, [])
  assert.equal(result.outcomes[0]?.code, 'tool_arguments_validation_failed')
  assert.deepEqual(result.request, { path: 'fixture.txt', value: 'safe' })
})

test('actual loop accepts valid compound arguments and never mutates supplied values', async () => {
  const result = await run({ allOf: [{ type: 'integer' }, { minimum: 1 }] }, 2)
  assert.equal(result.approvals, 1)
  assert.deepEqual(result.executions, [{ path: 'fixture.txt', value: 2 }])
  assert.equal(result.outcomes[0]?.ok, true)
})

test('subagent admission and direct dispatch both share the strict schema validator', async () => {
  const tools = [spec({ const: 'safe' })]
  let approvals = 0
  let executions = 0
  await subagent.subagentToolsLoop({
    userId, tools, messages: [{ role: 'user', content: 'Read the fixture.' }],
    modelRuntimeEnv: { MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-schema-fixture' },
    approveTool: async () => { approvals += 1; return { proceed: true } },
    executeTool: async () => { executions += 1; return { ok: true } },
    runToolLoop: async (options) => {
      const args = { path: 'fixture.txt', value: 'unsafe' }
      await assert.rejects(options.requestToolApproval({ toolName: 'read_file', args }), { code: 'tool_arguments_validation_failed' })
      const result = await options.executeTool({ name: 'read_file', args, toolCallId: 'direct-invalid' })
      assert.equal(result.code, 'tool_arguments_validation_failed')
      return { text: 'Refused invalid fixture parameters.', incomplete: false }
    },
  })
  assert.equal(approvals, 0)
  assert.equal(executions, 0)
})
