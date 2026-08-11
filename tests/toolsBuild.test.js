import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildToolSpecs,
  getBuiltinToolRuntimeStatus,
  getStandaloneToolClientStatus,
  listToolNames,
} from '../src/lib/tools/index.js'
import { TASK_STATUS, TOOL_CALL_STATUS, HISTORY_STATUS, isTaskStatus, isToolCallStatus } from '../src/store/taskStatus.js'

test('buildToolSpecs canonicalizes equivalent tool sets by function name', () => {
  const first = buildToolSpecs(['web_search', 'fetch_url', 'read_file'])
  const second = buildToolSpecs(['read_file', 'web_search', 'fetch_url'])

  assert.deepEqual(first, second)
  assert.deepEqual(first.map((spec) => spec.function.name), ['fetch_url', 'read_file', 'web_search'])
})

test('every built-in executor and model-facing spec has a matching counterpart', () => {
  assert.deepEqual(getBuiltinToolRuntimeStatus(), {
    missingExecutors: [],
    missingSpecs: [],
  })
  assert.deepEqual(getStandaloneToolClientStatus(), {
    scope: 'standalone_client',
    missingExecutors: [],
    missingSpecs: [],
  })
})

test('code-search and agent-support executors are exposed with their canonical arguments', () => {
  const expectedRequired = {
    grep_code: ['pattern'],
    find_symbol: ['name'],
    list_imports: ['file'],
    reflect: ['observation', 'next_step'],
    request_clarification: ['question'],
    remember: ['type', 'title', 'body'],
  }
  const specs = buildToolSpecs(Object.keys(expectedRequired))

  assert.deepEqual(specs.map((spec) => spec.function.name), Object.keys(expectedRequired).sort())
  for (const spec of specs) {
    assert.deepEqual(spec.function.parameters.required, expectedRequired[spec.function.name])
  }
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
  assert.ok(!isToolCallStatus('weird'))
})

test('buildToolSpecs 接受 Array', () => {
  const specs = buildToolSpecs(['web_search'])
  assert.equal(specs.length, 1)
  assert.equal(specs[0].function.name, 'web_search')
})

test('buildToolSpecs 接受 Set', () => {
  const specs = buildToolSpecs(new Set(['web_search', 'fetch_url']))
  assert.equal(specs.length, 2)
})

test('buildToolSpecs 去重', () => {
  const specs = buildToolSpecs(['web_search', 'web_search', 'web_search'])
  assert.equal(specs.length, 1)
})

test('buildToolSpecs 忽略未知工具', () => {
  // console.warn 也容忍
  const specs = buildToolSpecs(['web_search', 'shell_exec'])
  assert.equal(specs.length, 1)
  assert.equal(specs[0].function.name, 'web_search')
})

test('buildToolSpecs 忽略非字符串', () => {
  const specs = buildToolSpecs(['web_search', null, undefined, 42, {}])
  assert.equal(specs.length, 1)
})

test('buildToolSpecs 接受空/null', () => {
  assert.deepEqual(buildToolSpecs(null), [])
  assert.deepEqual(buildToolSpecs(undefined), [])
  assert.deepEqual(buildToolSpecs([]), [])
})

test('listToolNames 返回所有内置工具', () => {
  const names = listToolNames()
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('fetch_url'))
})


test('chat tools expose Claude/Codex style workspace tools', () => {
  const names = listToolNames()
  assert.ok(names.includes('read_file'))
  assert.ok(names.includes('write_file'))
  assert.ok(names.includes('edit_file'))
  assert.ok(names.includes('bash_exec'))
  const specs = buildToolSpecs(['read_file', 'write_file', 'edit_file', 'bash_exec'])
  assert.deepEqual(specs.map((s) => s.function.name), ['bash_exec', 'edit_file', 'read_file', 'write_file'])
})
