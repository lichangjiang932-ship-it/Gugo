import assert from 'node:assert/strict'
import test from 'node:test'

import { selectChatToolSpecs } from '../server/services/chatToolSelection.js'
import { selectJobToolSpecs } from '../server/services/toolLoopRuntime.js'
import { applyServerToolsConfig } from '../server/services/turnToolSpecs.js'

const spec = (name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})
const namesOf = (specs) => specs.map((item) => item.function.name)
const sorted = (names) => [...names].sort((a, b) => a.localeCompare(b, 'en'))

const TOOL_NAMES = [
  'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'generate_image',
  'list_directory', 'read_file', 'grep_code', 'write_file', 'edit_file', 'apply_patch',
  'bash_exec', 'run_project_check', 'git_diff', 'git_push', 'web_search',
  'browser_snapshot', 'browser_click', 'Agent', 'manage_todos', 'remember',
  'request_clarification', 'request_directory',
  'notion_search', 'slack_send_message', 'mcp__airtable__list_records',
  'mcp__airtable__create_record',
]
const READ_ONLY_NAMES = new Set([
  'list_directory', 'read_file', 'grep_code', 'git_diff', 'web_search',
  'browser_snapshot', 'notion_search', 'mcp__airtable__list_records',
])
const ANSWER_RECOVERY_NAMES = new Set(['request_clarification', 'request_directory'])
const SPECS = TOOL_NAMES.map(spec)
const ARTIFACT_NAMES = new Set([
  'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'generate_image',
])
const EXECUTE_NAMES = sorted(TOOL_NAMES.filter((name) => !ARTIFACT_NAMES.has(name)))
const ANSWER_NAMES = sorted([...READ_ONLY_NAMES, ...ANSWER_RECOVERY_NAMES])
const metadataResolver = (name) => ({
  isReadOnly: READ_ONLY_NAMES.has(name),
  riskClass: READ_ONLY_NAMES.has(name) ? 'read' : 'external',
})

function selectChat(options = {}) {
  return selectJobToolSpecs({
    origin: 'chat',
    specs: SPECS,
    metadataResolver,
    ...options,
  })
}

test('ordinary questions expose only a stable read-only capability set', () => {
  for (const prompt of [
    '为什么登录状态会过期？',
    'How does OAuth refresh-token rotation work?',
    '请介绍一下这个项目的架构',
  ]) {
    assert.deepEqual(namesOf(selectChat({ prompt })), ANSWER_NAMES)
  }
  assert.ok(!ANSWER_NAMES.includes('write_file'))
  assert.ok(!ANSWER_NAMES.includes('slack_send_message'))
  assert.ok(!ANSWER_NAMES.includes('Agent'))
})

test('implicit delegated commands retain execution tools without unrelated generators', () => {
  for (const prompt of [
    '登录问题你来处理好',
    'Please handle the login issue and verify the result.',
    'As analyzed above... 写入 Task 1。\n[附件: 雅思写作最新答题纸.pdf]"D:\\desktop\\雅思写作最新答题纸.pdf"',
  ]) {
    assert.deepEqual(namesOf(selectChat({ prompt })), EXECUTE_NAMES)
  }
})

test('explicit execute mode retains file, browser, connector, and MCP tools without unrelated generators', () => {
  const selected = namesOf(selectChat({
    prompt: 'Continue with the requested work.',
    intentMode: 'execute',
  }))
  for (const name of [
    'write_file',
    'browser_click', 'slack_send_message', 'mcp__airtable__create_record',
  ]) {
    assert.ok(selected.includes(name), name)
  }
  for (const name of ARTIFACT_NAMES) assert.ok(!selected.includes(name), name)
  assert.deepEqual(selected, EXECUTE_NAMES)
})

test('explicit answer mode wins over mutation words and artifact skill contracts', () => {
  assert.deepEqual(namesOf(selectChat({
    prompt: '/ppt 生成一份发布计划',
    skillId: 'ppt',
    intentMode: 'answer',
  })), ANSWER_NAMES)
})

test('artifact skill contracts retain execution tools and only their requested generator', () => {
  const selected = namesOf(selectChat({ prompt: '/ppt Q3 strategy', skillId: 'ppt' }))
  assert.deepEqual(selected, sorted([...EXECUTE_NAMES, 'create_pptx']))
  assert.ok(selected.includes('create_pptx'))
  assert.ok(!selected.includes('create_docx'))
})

test('managed attachments retain read access for questions and full capabilities for deliverables', () => {
  const summarize = namesOf(selectChat({
    prompt: '[GUGO_MANAGED_ATTACHMENT id="a1"]\n请概括附件内容',
  }))
  assert.deepEqual(summarize, ANSWER_NAMES)
  assert.ok(summarize.includes('read_file'))
  assert.ok(!summarize.includes('write_file'))

  const deliver = namesOf(selectChat({
    prompt: '[GUGO_MANAGED_ATTACHMENT id="a1"]\n把附件整理好并导出一份可编辑报告',
  }))
  assert.deepEqual(deliver, sorted([...EXECUTE_NAMES, 'create_docx']))
  assert.ok(deliver.includes('create_docx'))
})

test('read-only path grants do not downgrade a user write request to answer mode', () => {
  const prompt = [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    '- D:\\demo\\README.md',
    'Access mode: read only.',
    '',
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'Fix, delete, patch, run, and build this project.',
  ].join('\n')
  const userPrompt = 'Write the completed answers into D:\\demo\\README.md and verify the file.'
  for (const intentMode of ['auto', 'execute']) {
    const selected = namesOf(selectChat({ prompt, userPrompt, intentMode }))
    assert.deepEqual(selected, EXECUTE_NAMES)
    for (const name of ['write_file', 'bash_exec', 'request_directory']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }
})

test('keeping the source file unchanged does not downgrade an output-copy workflow', () => {
  const userPrompt = [
    'Do not modify the source PDF at D:\\demo\\answer-sheet.pdf.',
    'Create D:\\demo\\filled-answer-sheet.pdf and render PNG previews beside it, then verify every output.',
  ].join(' ')

  for (const intentMode of ['auto', 'execute']) {
    const selected = namesOf(selectChat({ prompt: userPrompt, userPrompt, intentMode }))
    assert.deepEqual(selected, EXECUTE_NAMES)
    for (const name of ['write_file', 'edit_file', 'bash_exec', 'request_directory']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }
})

test('a global read-only boundary wins over fix and patch discussion', () => {
  const userPrompt = [
    'Inspect the entire project read-only. Do not modify any files.',
    'Explain how you would fix the issue and what patch you recommend.',
  ].join(' ')

  for (const intentMode of ['auto', 'execute']) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, intentMode })),
      ANSWER_NAMES,
    )
  }
})

test('an explicit user read-only request remains a hard boundary in execute mode', () => {
  const prompt = [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    '- D:\\demo\\README.md',
    'Access mode: read only.',
    '',
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'Fix, delete, patch, run, and build this project.',
  ].join('\n')
  const userPrompt = 'Inspect this file read-only and do not modify it.'
  assert.deepEqual(namesOf(selectChat({ prompt, userPrompt, intentMode: 'execute' })), ANSWER_NAMES)
  assert.ok(ANSWER_NAMES.includes('request_clarification'))
  assert.ok(ANSWER_NAMES.includes('request_directory'))
})

test('PDF layout boundaries do not downgrade a real write-and-render request to answer mode', () => {
  const userPrompt = [
    '请把我提供的英文文章写入上传的雅思 Writing Task 1 答题卡 PDF，并输出填写后的 PDF 和每一页的 PNG 预览图。',
    '1. 使用 Times New Roman。',
    '8. 所有文字必须完全位于白色书写区域内。',
    '9. 第一页不能越过 “Do not write below this line” 红线。',
    '10. 如果第一页写不下，请自然续写到第二页。',
    '12. 保留文章原有结构和文字内容，不要改写。',
    '13. 完成后逐页渲染检查。',
    '"D:\\destok\\雅思写作最新答题纸.pdf"写进该文件',
  ].join('\n')

  const selected = namesOf(selectChat({ prompt: userPrompt, userPrompt }))
  assert.deepEqual(selected, EXECUTE_NAMES)
  for (const name of ['bash_exec', 'write_file', 'request_directory']) {
    assert.ok(selected.includes(name), name)
  }
})

test('a read-only PDF verifier does not downgrade the surrounding creation workflow', () => {
  for (const userPrompt of [
    'Create filled-task1.pdf and page-1.png. Write an independent read-only verify_pdf_layout.py, run it with bash_exec, and keep the source PDF unchanged.',
    '\u521b\u5efa filled-task1.pdf \u548c page-1.png\uff1b\u53e6\u5199\u72ec\u7acb\u53ea\u8bfb verify_pdf_layout.py \u5e76\u7528 bash_exec \u8fd0\u884c\uff0c\u6e90 PDF \u4fdd\u6301\u4e0d\u53d8\u3002',
  ]) {
    const selected = namesOf(selectChat({ prompt: userPrompt, userPrompt }))
    assert.deepEqual(selected, EXECUTE_NAMES)
    for (const name of ['bash_exec', 'write_file', 'request_directory']) {
      assert.ok(selected.includes(name), `${userPrompt}: ${name}`)
    }
  }
})

test('disabled tools remain absent and routing never recreates them', () => {
  const configured = applyServerToolsConfig(SPECS, {
    enabled: ['read_file'],
    disabled: ['create_docx', 'bash_exec', 'browser_click', 'slack_send_message', 'read_file'],
  })
  const selected = namesOf(selectChatToolSpecs({
    prompt: 'Implement the whole workflow.',
    intentMode: 'execute',
    specs: configured,
    metadataResolver,
  }))
  for (const name of ['create_docx', 'bash_exec', 'browser_click', 'slack_send_message', 'read_file']) {
    assert.ok(!selected.includes(name), name)
  }
})

test('answer-mode recovery tools remain absent when disabled upstream', () => {
  const configured = applyServerToolsConfig(SPECS, {
    enabled: ['request_clarification', 'request_directory'],
    disabled: ['request_clarification', 'request_directory'],
  })
  const selected = namesOf(selectChatToolSpecs({
    prompt: 'Explain OAuth.',
    specs: configured,
    metadataResolver,
  }))
  assert.ok(!selected.includes('request_clarification'))
  assert.ok(!selected.includes('request_directory'))
})

test('equivalent route classes keep deterministic schema order for provider caching', () => {
  assert.deepEqual(
    namesOf(selectChat({ prompt: '登录问题你来处理好' })),
    namesOf(selectChat({ prompt: 'Please handle the login issue.' })),
  )
  assert.deepEqual(
    namesOf(selectChat({ prompt: '什么是 OAuth？' })),
    namesOf(selectChat({ prompt: 'Explain OAuth.' })),
  )
})
