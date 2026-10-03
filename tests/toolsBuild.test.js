import test from 'node:test'
import assert from 'node:assert/strict'
import { getBuiltinSpec, resolveSpecsForMode } from '../server/services/toolRegistry.js'
import { TASK_STATUS, TOOL_CALL_STATUS, HISTORY_STATUS, isTaskStatus, isToolCallStatus } from '../src/store/taskStatus.js'

test('code-search and agent-support tools are exposed with their canonical arguments', () => {
  const expectedRequired = {
    run_code: ['code'],
    grep_code: ['pattern'],
    find_symbol: ['name'],
    list_imports: ['file'],
    lsp: ['operation', 'file', 'line', 'character'],
    reflect: ['observation', 'next_step'],
    request_clarification: ['question'],
    remember: ['type', 'title', 'body'],
  }
  for (const [name, required] of Object.entries(expectedRequired)) {
    const spec = getBuiltinSpec(name)
    assert.ok(spec, `${name} should be in the server catalog`)
    assert.equal(spec.function.name, name)
    assert.deepEqual(spec.function.parameters.required, required)
  }
  const runCode = getBuiltinSpec('run_code')
  assert.deepEqual(Object.keys(runCode.function.parameters.properties).sort(), ['code', 'description'])
})

test('TASK_STATUS 是 frozen', () => {
  assert.ok(Object.isFrozen(TASK_STATUS))
  assert.ok(Object.isFrozen(TOOL_CALL_STATUS))
  assert.ok(Object.isFrozen(HISTORY_STATUS))
})

test('isTaskStatus / isToolCallStatus 正确判别', () => {
  assert.ok(isTaskStatus(TASK_STATUS.RUNNING))
  assert.ok(isTaskStatus(TASK_STATUS.COMPLETED))
  assert.ok(!isTaskStatus('weird'))
  assert.ok(isToolCallStatus(TOOL_CALL_STATUS.RUNNING))
  assert.ok(isToolCallStatus(TOOL_CALL_STATUS.CANCELLED))
  assert.ok(!isToolCallStatus('weird'))
})

test('chat tools expose Claude/Codex style workspace tools', () => {
  const names = new Set(resolveSpecsForMode('chat').map((entry) => entry.name))
  for (const name of ['web_search', 'fetch_url', 'read_file', 'write_file', 'edit_file', 'bash_exec']) {
    assert.ok(names.has(name), `${name} should be in the chat catalog`)
  }
})
