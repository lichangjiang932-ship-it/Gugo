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
    'load_skill',
  ]
  for (const [type, policy] of Object.entries(SUBAGENT_TYPES)) {
    const expected = type === 'general'
      ? [
          ...readonlyNames,
          'remember', 'write_file', 'edit_file',
          'bash_exec', 'run_command', 'run_test', 'run_project_check', 'git_status', 'git_diff', 'git_log', 'git_blame',
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

test('every tool a subagent is shown has a dispatcher behind it', async (t) => {
  // The schema list and the dispatcher are written in two places. A name in the
  // first and not the second is a tool the model can call that always fails with
  // "unknown subagent tool" — git_log and git_blame were exactly that.
  fixture(t, 'dispatch probe')
  const { executeSubagentTool } = _testing
  const shown = new Set(Object.values(SUBAGENT_TYPES).flatMap((policy) => policy.tools.map((tool) => tool.function.name)))
  for (const name of shown) {
    if (name === 'Agent') continue // nested runs need a loop runner; its routing has its own tests
    let result
    try {
      result = await executeSubagentTool(name, {}, { userId, signal: new AbortController().signal })
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) }
    }
    assert.doesNotMatch(String(result?.error || ''), /unknown subagent tool|unknown git tool/u, `${name} reaches a dispatcher`)
  }
})

test('a subagent git_log call reaches the git-history adapter', async (t) => {
  fixture(t, 'history probe')
  const { executeSubagentTool } = _testing
  // The adapter's own behaviour is covered in gitHistoryTools.test.js. Here the
  // point is the route: the answer must come from that adapter (here, its own
  // "git is not enabled" gate), never the subagent's "unknown tool" fallback.
  for (const name of ['git_log', 'git_blame']) {
    const result = await executeSubagentTool(name, { path: 'sample.txt' }, { userId })
    assert.equal(result?.ok, false)
    assert.doesNotMatch(String(result?.error || ''), /unknown subagent tool|unknown git tool/u, name)
    assert.match(String(result?.error || ''), /WORKSPACE_GIT_ENABLED|git|Git/u, name)
  }
})

test('a subagent opens with a smaller schema and search_tools mounts only its own authorized tools', async (t) => {
  fixture(t, 'deferred probe')
  // explore: lsp/find_symbol/list_imports/... are deferred; write_file is not
  // authorized at all and must never be mounted by a search for it.
  const { modelTools, outcomes } = await runScript([
    { name: 'search_tools', args: () => ({ query: 'find_symbol write_file edit_file', limit: 8 }) },
  ], { type: 'explore' })
  const first = modelTools[0].map((tool) => tool.function.name)
  assert.ok(first.includes('search_tools'))
  assert.equal(first.includes('find_symbol'), false, 'deferred tools are not shown up front')
  const searched = outcomes.find((entry) => entry.name === 'search_tools').result
  assert.ok(searched.activatedToolNames.includes('find_symbol'))
  assert.equal(searched.activatedToolNames.includes('write_file'), false, 'search never reaches outside the authorized set')
  assert.equal(searched.activatedToolNames.includes('edit_file'), false)
  const next = modelTools[1].map((tool) => tool.function.name)
  assert.ok(next.includes('find_symbol'), 'the mounted tool is shown on the next request')
  assert.equal(next.includes('write_file'), false)
})

test('a tool mounted through search_tools still goes through the same approval gate', async (t) => {
  const filepath = fixture(t, 'gate probe')
  const approvals = []
  const executions = []
  const shown = []
  let index = 0
  const script = [
    { name: 'search_tools', args: { query: 'run_project_check', limit: 3 } },
    { name: 'run_project_check', args: { check: 'test', cwd: path.dirname(filepath) } },
  ]
  await _testing.subagentToolsLoop({
    userId,
    locale: 'en',
    messages: [{ role: 'user', content: 'Run the project check.' }],
    tools: SUBAGENT_TYPES.general.tools,
    maxIters: 4,
    modelRuntimeEnv: { MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-schema-model' },
    approveTool: async (request) => {
      approvals.push(request.toolName)
      // Everything else gets the real policy answer (search_tools is never
      // asked about); the mounted tool is refused — the point is that the gate
      // is asked about it at all.
      if (request.toolName !== 'run_project_check') {
        const gate = revalidateToolPermission({ ...request, allowAsk: true })
        return { ...gate, approvalId: `gate-approval-${approvals.length}` }
      }
      return { proceed: false, deniedByUser: true, reason: 'refused in test' }
    },
    executeTool: (name, args, options) => {
      executions.push(name)
      return _testing.executeSubagentTool(name, args, options)
    },
    callModel: async ({ tools }) => {
      shown.push(tools.map((tool) => tool.function.name))
      const operation = script[index++]
      return operation ? wireCall(operation.name, operation.args, index) : { content: 'done', toolCalls: [] }
    },
  })
  // It was not shown at first: the only way it reached the gate is through the mount.
  assert.equal(shown[0].includes('run_project_check'), false)
  assert.ok(shown[1].includes('run_project_check'))
  assert.ok(approvals.includes('run_project_check'), 'the mounted tool reached the approval gate')
  assert.equal(executions.includes('run_project_check'), false, 'refused, so it never executed')
})

test('a subagent load_skill goes through the main agent activation and its ownership check', async (t) => {
  fixture(t, 'skill probe')
  const { outcomes } = await runScript([
    { name: 'load_skill', args: () => ({ skill_id: 'not-a-skill-this-user-can-see' }) },
  ], { type: 'explore' })
  const loaded = outcomes.find((entry) => entry.name === 'load_skill').result
  // The same code as the main loop's runtimeSkillActivation: no second path.
  assert.equal(loaded.ok, false)
  assert.equal(loaded.code, 'skill_not_available')
})
