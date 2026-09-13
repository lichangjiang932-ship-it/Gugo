import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import '../server/services/loop/index.js'
import { closeDb, createUser } from '../server/db.js'
import { revalidateToolPermission } from '../server/services/approvalGate.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { setWorkspaceTrust } from '../server/services/workspaceTrustService.js'
import { SUBAGENT_TYPES, _testing } from '../server/services/subagentRuntime.js'
import { getBuiltinSpec } from '../server/services/toolRegistry.js'
import { validateToolCall } from '../server/utils/toolCallArguments.js'

const userId = 'subagent-schema-owner'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-subagent-schema-'))
createUser({ id: userId, email: 'subagent-schema@example.test' })

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

function fixture(t, content, accessMode = 'read_write') {
  const directory = fs.mkdtempSync(path.join(root, 'project-'))
  const filepath = path.join(directory, 'sample.txt')
  fs.writeFileSync(filepath, content)
  grantLocalPath({ userId, rootPath: directory, accessMode })
  setWorkspaceTrust({
    userId,
    rootPath: directory,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
  })
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Subagent schema tests must not use the network')
  })
  return filepath
}

function wireCall(name, args, index) {
  return {
    content: '',
    toolCalls: [{
      id: `schema-call-${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

async function runScript(script, { type = 'general', tools = SUBAGENT_TYPES[type].tools } = {}) {
  const outcomes = []
  const modelTools = []
  const approvals = []
  const dispatches = []
  let index = 0
  const result = await _testing.subagentToolsLoop({
    userId,
    locale: 'en',
    messages: [{ role: 'user', content: 'Carry out the requested focused tool operation and inspect its result.' }],
    tools,
    maxIters: 5,
    modelRuntimeEnv: { MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-schema-model' },
    approveTool: async (request) => {
      approvals.push(request.toolName)
      const gate = revalidateToolPermission({ ...request, allowAsk: true })
      assert.equal(gate.proceed, true, gate.reason)
      return { ...gate, approvalId: `schema-approval-${index}` }
    },
    executeTool: (name, args, options) => {
      dispatches.push(name)
      return _testing.executeSubagentTool(name, args, options)
    },
    callModel: async ({ tools }) => {
      modelTools.push(tools)
      const operation = script[index++]
      return operation
        ? wireCall(operation.name, operation.args(tools), index)
        : { content: 'The focused tool results are recorded.', toolCalls: [] }
    },
    onTranscriptEvent: (event) => {
      if (event.type === 'tool_result') outcomes.push({
        name: event.name,
        result: JSON.parse(event.result),
      })
    },
  })
  return { result, outcomes, modelTools, approvals, dispatches }
}

// Act on the contract the model actually receives. With the old local copy,
// validation accepts oldText/newText but the real file dispatcher rejects it.
function editArguments(tools, filepath, oldText, newText, options = {}) {
  const spec = tools.find((tool) => tool.function.name === 'edit_file')
  const oldKey = spec.function.parameters.required.find((name) => name.startsWith('old'))
  const newKey = spec.function.parameters.required.find((name) => name.startsWith('new'))
  const args = { path: filepath, [oldKey]: oldText, [newKey]: newText, ...options }
  assert.equal(validateToolCall({ name: 'edit_file', args }, tools), null)
  return args
}

test('general subagent executes its advertised edit contract and reads back the changed line', async (t) => {
  const filepath = fixture(t, 'header\nold value\nfooter\n')
  const { outcomes } = await runScript([
    { name: 'edit_file', args: (tools) => editArguments(tools, filepath, 'old value', 'new value') },
    { name: 'read_file', args: () => ({ path: filepath, offset: 1, limit: 1 }) },
  ])
  const edit = outcomes.find((outcome) => outcome.name === 'edit_file')?.result
  const read = outcomes.find((outcome) => outcome.name === 'read_file')?.result
  assert.equal(edit?.ok, true, edit?.error)
  assert.equal(edit.replacedCount, 1)
  assert.equal(read?.ok, true, read?.error)
  assert.equal(read.content, 'new value')
  assert.equal(read.offset, 1)
  assert.equal(read.returnedLines, 1)
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'header\nnew value\nfooter\n')
})

test('general subagent replace_all supports an empty replacement without overwriting other text', async (t) => {
  const filepath = fixture(t, 'remove:one\nremove:two\n')
  const { outcomes } = await runScript([
    { name: 'edit_file', args: (tools) => editArguments(tools, filepath, 'remove:', '', { replace_all: true }) },
    { name: 'read_file', args: () => ({ path: filepath }) },
  ])
  const edit = outcomes.find((outcome) => outcome.name === 'edit_file')?.result
  assert.equal(edit?.ok, true, edit?.error)
  assert.equal(edit.replacedCount, 2)
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'one\ntwo\n')
})

test('general subagent can execute and verify a bounded command through the shared dispatcher', async (t) => {
  const filepath = fixture(t, 'command fixture')
  const cwd = path.dirname(filepath)
  const { outcomes, approvals, dispatches } = await runScript([
    { name: 'run_command', args: () => ({
      command: `node -e "process.stdout.write('subagent-command-ok')"`,
      cwd,
      timeout_ms: 30_000,
    }) },
  ])
  const command = outcomes.find((outcome) => outcome.name === 'run_command')?.result
  assert.equal(command?.ok, true, command?.error || command?.stderr)
  assert.equal(command.stdout, 'subagent-command-ok')
  assert.deepEqual(approvals, ['run_command'])
  assert.deepEqual(dispatches, ['run_command'])
})

test('legacy edit aliases fail schema validation before any file mutation', async (t) => {
  const filepath = fixture(t, 'unchanged')
  const { outcomes, approvals, dispatches } = await runScript([
    { name: 'edit_file', args: () => ({ path: filepath, oldText: 'unchanged', newText: 'wrong' }) },
  ])
  assert.equal(outcomes[0]?.result?.code, 'tool_arguments_validation_failed')
  assert.deepEqual(approvals, [])
  assert.deepEqual(dispatches, [])
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'unchanged')
})

test('canonical edit arguments still enforce the existing directory write grant', async (t) => {
  const filepath = fixture(t, 'read only', 'read_only')
  await assert.rejects(runScript([
    { name: 'edit_file', args: (tools) => editArguments(tools, filepath, 'read only', 'denied') },
  ]), (error) => {
    assert.equal(error.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
    assert.equal(error.cause?.code, 'PATH_NOT_AUTHORIZED')
    return true
  })
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'read only')
})

test('subagent policies reuse canonical catalog objects without expanding their tool names', () => {
  const readonlyNames = [
    'web_search', 'fetch_url', 'list_directory', 'read_file',
    'grep_code', 'find_symbol', 'list_imports', 'lsp',
    'reflect', 'request_clarification', 'request_directory', 'sleep_until',
  ]
  for (const [type, policy] of Object.entries(SUBAGENT_TYPES)) {
    const expected = type === 'general'
      ? [
          ...readonlyNames,
          'remember', 'write_file', 'edit_file',
          'bash_exec', 'run_command', 'run_test', 'run_project_check', 'git_status', 'git_diff',
          'apply_patch', 'Agent',
        ]
      : readonlyNames
    assert.deepEqual(policy.tools.map((tool) => tool.function.name), expected)
    for (const spec of policy.tools) assert.equal(spec, getBuiltinSpec(spec.function.name))
  }
})

test('explore and plan refuse file and durable-memory mutations even with a writable directory grant', async (t) => {
  const filepath = fixture(t, 'original')
  for (const type of ['explore', 'plan']) {
    for (const operation of [
      { name: 'edit_file', args: () => ({ path: filepath, old_string: 'original', new_string: 'denied' }) },
      { name: 'remember', args: () => ({ content: 'must not persist', title: 'forbidden' }) },
    ]) {
      const { outcomes, approvals, dispatches } = await runScript([operation], { type })
      assert.equal(outcomes[0]?.result?.code, 'unknown_tool')
      assert.deepEqual(approvals, [])
      assert.deepEqual(dispatches, [])
      assert.equal(fs.readFileSync(filepath, 'utf8'), 'original')
    }
  }
})

test('a narrowed general subagent tool set cannot regain a catalog tool during approval or dispatch', async (t) => {
  const filepath = fixture(t, 'narrowed')
  const { outcomes, approvals, dispatches, modelTools } = await runScript([
    { name: 'write_file', args: () => ({ path: filepath, content: 'denied' }) },
  ], { tools: [getBuiltinSpec('read_file')] })
  assert.deepEqual(modelTools[0].map((tool) => tool.function.name), ['read_file'])
  assert.equal(outcomes[0]?.result?.code, 'unknown_tool')
  assert.deepEqual(approvals, [])
  assert.deepEqual(dispatches, [])
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'narrowed')
})

test('the private allowlist snapshot also guards direct executor and resumed calls from an injected loop', async (t) => {
  const filepath = fixture(t, 'snapshot')
  const suppliedTools = [getBuiltinSpec('read_file')]
  let approvals = 0
  let dispatches = 0
  await _testing.subagentToolsLoop({
    userId,
    tools: suppliedTools,
    messages: [{ role: 'user', content: 'Inspect the authorized file.' }],
    modelRuntimeEnv: { MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-schema-model' },
    approveTool: async () => { approvals += 1; return { proceed: true } },
    executeTool: async () => { dispatches += 1; return { ok: true } },
    runToolLoop: async (options) => {
      suppliedTools.push(getBuiltinSpec('write_file'))
      const args = { path: filepath, content: 'denied' }
      await assert.rejects(options.requestToolApproval({ toolName: 'write_file', args }), { code: 'unknown_tool' })
      const result = await options.executeTool({ name: 'write_file', args, idempotentResume: true })
      assert.equal(result.code, 'unknown_tool')
      return { text: 'No unlisted tool was executed.' }
    },
  })
  assert.equal(approvals, 0)
  assert.equal(dispatches, 0)
  assert.equal(fs.readFileSync(filepath, 'utf8'), 'snapshot')
})

test('read pagination and web-search limits use the shared parameter contract', () => {
  for (const { tools } of Object.values(SUBAGENT_TYPES)) {
    const read = tools.find((spec) => spec.function.name === 'read_file')
    assert.equal(read.function.parameters.properties.offset.type, 'integer')
    assert.equal(read.function.parameters.properties.limit.type, 'integer')
    assert.equal(validateToolCall({ name: 'read_file', args: { path: 'sample.txt', offset: 1.5 } }, tools)?.code,
      'tool_arguments_validation_failed')
    const search = tools.find((spec) => spec.function.name === 'web_search')
    assert.equal(search.function.parameters.properties.maxResults, undefined)
    assert.equal(validateToolCall({ name: 'web_search', args: { query: 'offline', max_results: 2 } }, tools), null)
    for (const max_results of [0, 1.5, 11]) {
      assert.equal(validateToolCall({ name: 'web_search', args: { query: 'offline', max_results } }, tools)?.code,
        'tool_arguments_validation_failed')
    }
  }
})
