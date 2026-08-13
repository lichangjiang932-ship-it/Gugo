import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveChatCapabilityMode,
  selectChatToolSpecs,
} from '../server/services/chatToolSelection.js'
import {
  selectJobToolSpecs,
  SERVER_TOOL_SPECS,
} from '../server/services/toolLoopRuntime.js'
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

test('an explicit Chinese repair delegation retains the coding execution toolchain', () => {
  const prompt = '\u4f60\u6839\u636e\u5b9e\u9645\u60c5\u51b5\u6765\u8fdb\u884c\u4fee\u590d\uff0cpython\u7b49\u7684\u4ee3\u7801\u6267\u884c\u80fd\u529b\u662f\u5fc5\u987b\u6709\u7684'
  const selected = namesOf(selectChat({ prompt }))

  assert.deepEqual(selected, EXECUTE_NAMES)
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec', 'git_push']) {
    assert.ok(selected.includes(name), name)
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

test('preserving article content does not downgrade a separate output workflow', () => {
  const userPrompt = '\u4e0d\u8981\u4fee\u6539\u6587\u7ae0\u5185\u5bb9\uff1b\u8bf7\u8c03\u6574\u6392\u7248\u5e76\u751f\u6210 D:\\demo\\formatted-article.pdf \u8fd9\u4e2a\u65b0\u6587\u4ef6\uff0c\u4fdd\u5b58\u540e\u9a8c\u8bc1\u8f93\u51fa\u3002'

  for (const intentMode of ['auto', 'execute']) {
    const selected = namesOf(selectChat({ prompt: userPrompt, userPrompt, intentMode }))
    assert.deepEqual(selected, EXECUTE_NAMES)
    for (const name of ['write_file', 'bash_exec', 'request_directory']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }
})

test('the full stored IELTS display prompt retains execution tools and continuation intent', () => {
  const userPrompt = String.raw`请把我提供的英文文章写入上传的 IELTS Writing Answer Sheet 的 Task 1 区域，并生成填写完成的 PDF。
PDF 测试模板路径："D:\demo\fixtures\ielts-writing-answer-sheet.pdf"
必须严格遵守以下要求：

1. 只写入 Task 1 区域，即 PDF 的第 1、2 页。
2. Task 2 区域必须保持完全空白。
3. 使用 Times New Roman、Times-Roman 或相近的衬线字体。
4. 正文字号固定为约 20 pt，不要为了塞进第一页而缩小字体。
5. 字体高度应与答题卡相邻两条横线之间的高度协调。
6. 每一行文字的基线必须与答题卡横线匹配。
7. 每段首行必须缩进，首字母与红色标题区域中 “Writing” 的左边缘位于同一竖直线上。
8. 每段后续行从白色书写区域的左侧安全边界开始。
9. 段落之间不要留空行。
10. 如果文章第一页写不下，必须自然续写到 Task 1 第二页。
11. 如果第二页开头是上一段的续写，不要重新缩进。
12. 新段落开始时仍需进行段首缩进。
13. 自动换行时要充分利用行宽，不能右侧留下大量空白，却把最后一个单词单独放到下一行。
14. 必要时允许轻微横向压缩字体，但不能明显改变字体比例，横向缩放最好不低于 90%。
15. 所有文字必须完全位于白色书写区域内。
16. 文字不能碰到或进入左右红色区域。
17. 第一页不能越过 “Do not write below this line” 红线。
18. 第二页不能进入底部 “OFFICIAL USE ONLY” 区域。
19. 保留文章原有段落、拼写、语法和标点，不要擅自修改、润色、删减或增加内容。
20. 除非我明确要求，否则不要纠正文章中的语言错误。
21. 使用 PyMuPDF/fitz 直接在原 PDF 上写入文字，避免使用可能产生坐标偏移的 PDF 叠加方式。
22. 完成后必须将 Task 1 两页渲染为 PNG 进行视觉检查。
23. 检查是否存在文字越界、重叠、截断、字号过小、段首未对齐或不合理断行。
24. 重新打开最终 PDF，确认文件完整、文章全部写入、Task 2 仍为空白。
25. 输出最终 PDF，并提供可点击的文件链接。
26. 最终文件名为：[在这里填写文件名].pdf。
27. 不要覆盖其他已有作业文件。如果同名文件被占用，请生成到“修正版”文件夹中，但保持要求的文件名。

如果使用的是与我之前相同的答题卡，可以参考以下精确坐标：

字体：Times-Roman
字号：20 pt
第一页段首横坐标：86.5
第一页续行横坐标：30.0
右侧安全边界：589.0

Task 1 第一页文字基线：
226.81, 255.19, 283.57, 311.89, 340.27,
368.65, 397.03, 425.41, 453.73, 482.11,
510.49, 538.87, 567.19, 595.57, 623.95

Task 1 第二页文字基线：
96.31, 124.63, 153.01, 181.39, 209.77,
238.09, 266.47, 294.85, 323.23, 351.61,
379.93, 408.31, 436.69, 465.07, 493.39,
521.77, 550.15, 578.53, 606.91, 635.23

需要写入的文章：

This is synthetic fixture paragraph one. It describes a fictional document-layout regression and contains no personal, academic, or production content.

This synthetic paragraph two is intentionally long enough to exercise line wrapping. The test only verifies that a delegated PDF-writing request keeps execution tools available.

This synthetic paragraph three contains ordinary punctuation, spelling, and sentence boundaries. Its wording must be preserved so the content-fidelity constraint remains part of the routing prompt.

This synthetic paragraph four asks the renderer to continue across pages when needed. It does not describe a real person, location, assignment, or event.

In summary, this entirely fabricated passage exists only for automated tool-selection testing. It must be written to the generated fixture PDF without editing.全程由你来操作，最后把生成的有作文的pdf交付给我`

  for (const intentMode of ['auto', 'execute']) {
    assert.equal(resolveChatCapabilityMode({
      prompt: userPrompt,
      userPrompt,
      intentMode,
    }), 'execute')
    const selected = namesOf(selectJobToolSpecs({
      origin: 'chat',
      specs: SERVER_TOOL_SPECS,
      prompt: userPrompt,
      userPrompt,
      intentMode,
    }))
    for (const name of ['write_file', 'bash_exec', 'run_command']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }

  const continuation = {
    prompt: '\u7ee7\u7eed',
    userPrompt: '\u7ee7\u7eed',
    previousUserPrompt: userPrompt,
    intentMode: 'auto',
  }
  assert.equal(resolveChatCapabilityMode(continuation), 'execute')
  const continuedSelected = namesOf(selectJobToolSpecs({
    origin: 'chat',
    specs: SERVER_TOOL_SPECS,
    ...continuation,
  }))
  for (const name of ['write_file', 'bash_exec', 'run_command']) {
    assert.ok(continuedSelected.includes(name), `continue: ${name}`)
  }
})

test('an article-content constraint without a separate work order remains read-only', () => {
  const userPrompt = '\u4e0d\u8981\u4fee\u6539\u6587\u7ae0\u5185\u5bb9\uff0c\u53ea\u5206\u6790\u5b83\u7684\u6392\u7248\u95ee\u9898\u3002'
  assert.deepEqual(namesOf(selectChat({ prompt: userPrompt, userPrompt })), ANSWER_NAMES)
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

test('a Chinese global read-only boundary still wins over execution wording', () => {
  const userPrompt = '\u6574\u4e2a\u9879\u76ee\u53ea\u8bfb\uff0c\u4e0d\u8981\u4fee\u6539\u4efb\u4f55\u6587\u4ef6\uff1b\u8bf4\u660e\u5982\u4f55\u4fee\u590d\u5e76\u6253\u8865\u4e01\u3002'
  for (const intentMode of ['auto', 'execute']) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, intentMode })),
      ANSWER_NAMES,
    )
  }
})

test('a short authorization inherits only the immediately preceding user execution request', () => {
  const previousUserPrompt = '\u8bf7\u4fee\u590d D:\\demo\\app.js\uff0c\u5199\u5165\u6587\u4ef6\u5e76\u8fd0\u884c\u6d4b\u8bd5\u3002'
  for (const userPrompt of ['\u7ee7\u7eed', '\u6211\u6388\u6743\u7ed9\u4f60\uff0c\u7ee7\u7eed']) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
      EXECUTE_NAMES,
      userPrompt,
    )
  }
})

test('a short authorization cannot create execution intent or override answer mode', () => {
  const executionRequest = '\u8bf7\u4fee\u590d D:\\demo\\app.js \u5e76\u5199\u5165\u6587\u4ef6\u3002'
  const readOnlyRequest = '\u6574\u4e2a\u9879\u76ee\u53ea\u8bfb\uff0c\u4e0d\u8981\u4fee\u6539\u4efb\u4f55\u6587\u4ef6\u3002'
  const answerRequest = '\u8bf7\u89e3\u91ca OAuth \u5237\u65b0\u4ee4\u724c\u5982\u4f55\u5de5\u4f5c\u3002'

  assert.deepEqual(namesOf(selectChat({ prompt: '\u7ee7\u7eed' })), ANSWER_NAMES)
  assert.deepEqual(namesOf(selectChat({
    prompt: '\u6211\u6388\u6743\u7ed9\u4f60',
    previousUserPrompt: answerRequest,
  })), ANSWER_NAMES)
  assert.deepEqual(namesOf(selectChat({
    prompt: '\u7ee7\u7eed',
    previousUserPrompt: readOnlyRequest,
  })), ANSWER_NAMES)
  assert.deepEqual(namesOf(selectChat({
    prompt: '\u7ee7\u7eed',
    previousUserPrompt: executionRequest,
    intentMode: 'answer',
  })), ANSWER_NAMES)
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
