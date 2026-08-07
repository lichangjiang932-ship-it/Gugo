import assert from 'node:assert/strict'
import test from 'node:test'

import { selectChatToolSpecs } from '../server/services/chatToolSelection.js'
import { selectJobToolSpecs } from '../server/services/toolLoopRuntime.js'

const spec = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})
const namesOf = (specs) => specs.map((item) => item.function.name)

const SPECS = [
  'create_pptx', 'list_directory', 'read_file', 'grep_code',
  'write_file', 'edit_file', 'apply_patch', 'bash_exec', 'run_project_check',
  'git_diff', 'git_push', 'web_search', 'browser_snapshot', 'Agent',
  'manage_todos', 'remember', 'notion_search', 'qq_mail_send',
  'mcp__airtable__list_records',
].map(spec)
const NON_ARTIFACT_SPECS = SPECS.filter((item) => item.function.name !== 'create_pptx')
const STABLE_NAMES = namesOf(NON_ARTIFACT_SPECS).sort((a, b) => a.localeCompare(b, 'en'))

test('ordinary chat exposes stable non-artifact schemas for model-driven routing', () => {
  assert.deepEqual(
    namesOf(selectJobToolSpecs({ prompt: '你好', origin: 'chat', specs: SPECS })),
    STABLE_NAMES,
  )
})

test('routing does not depend on language or intent keywords', () => {
  for (const prompt of ['你好', '处理这个复杂请求', 'Handle it', 'README.md']) {
    assert.deepEqual(namesOf(selectChatToolSpecs({ prompt, specs: NON_ARTIFACT_SPECS })), STABLE_NAMES)
  }
})

test('artifact authorization composes with model-driven routing', () => {
  assert.deepEqual(namesOf(selectJobToolSpecs({
    prompt: '帮我做一份产品发布 PPT',
    skillId: 'ppt',
    origin: 'chat',
    specs: SPECS,
  })), ['create_pptx', ...STABLE_NAMES].sort((a, b) => a.localeCompare(b, 'en')))

  assert.ok(!namesOf(selectJobToolSpecs({
    prompt: '修复自动生成 PPT 的问题，不要创建演示文稿',
    origin: 'chat',
    specs: SPECS,
  })).includes('create_pptx'))
})

test('explicit read-only access removes mutation, shell, git write, and delegation tools', () => {
  const prompt = [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    '- D:\\demo\\README.md',
    'Access mode: read only.',
    '',
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'File contents: fix this by write, delete, patch, run, and build.',
  ].join('\n')
  const selected = namesOf(selectChatToolSpecs({ prompt, specs: NON_ARTIFACT_SPECS }))
  for (const name of ['read_file', 'grep_code', 'git_diff', 'run_project_check']) assert.ok(selected.includes(name), name)
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec', 'git_push', 'Agent', 'manage_todos']) {
    assert.ok(!selected.includes(name), name)
  }
})

test('plain-language read-only constraints are permission boundaries', () => {
  const selected = namesOf(selectChatToolSpecs({
    prompt: 'Inspect this repository read-only without editing files',
    specs: NON_ARTIFACT_SPECS,
  }))
  assert.ok(selected.includes('read_file'))
  assert.ok(!selected.includes('edit_file'))
  assert.ok(!selected.includes('bash_exec'))
})
