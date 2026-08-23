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
  'bash_exec', 'run_project_check', 'git_diff', 'git_push', 'rewind_files', 'web_search',
  'browser_snapshot', 'browser_click', 'Agent', 'manage_todos', 'remember',
  'request_clarification', 'request_directory',
  'notion_search', 'slack_send_message', 'mcp__airtable__list_records',
  'mcp__airtable__create_record',
]
const READ_ONLY_NAMES = new Set([
  'list_directory', 'read_file', 'grep_code', 'git_diff', 'web_search',
  'browser_snapshot', 'notion_search', 'mcp__airtable__list_records',
])
const ALWAYS_VISIBLE_LOCAL_EXECUTION_NAMES = new Set([
  'write_file', 'edit_file', 'apply_patch', 'bash_exec', 'run_project_check',
])
const ARTIFACT_NAMES = new Set([
  'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'generate_image',
])
const SPECS = TOOL_NAMES.map(spec)
const STABLE_CHAT_NAMES = sorted([
  ...TOOL_NAMES.filter((name) => !ARTIFACT_NAMES.has(name)),
  'set_deliverables',
])
const EXECUTE_NAMES = STABLE_CHAT_NAMES
const LOCAL_EXECUTE_NAMES = STABLE_CHAT_NAMES
const LOCAL_REWIND_EXECUTE_NAMES = STABLE_CHAT_NAMES
const ANSWER_NAMES = STABLE_CHAT_NAMES
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

test('ordinary questions retain the complete stable tool catalog', () => {
  for (const prompt of [
    '为什么登录状态会过期？',
    'How does OAuth refresh-token rotation work?',
    '请介绍一下这个项目的架构',
  ]) {
    assert.deepEqual(namesOf(selectChat({ prompt })), ANSWER_NAMES)
  }
  assert.ok(ANSWER_NAMES.includes('write_file'))
  assert.ok(ANSWER_NAMES.includes('bash_exec'))
  assert.ok(ANSWER_NAMES.includes('slack_send_message'))
  assert.ok(ANSWER_NAMES.includes('Agent'))
})

test('refreshed conversations and terse follow-ups retain authorized local tools on every new turn', () => {
  for (const userPrompt of [
    '你来操作',
    '为什么还是没有写入工具',
    '解释一下这个页面',
  ]) {
    const selected = namesOf(selectChat({
      prompt: userPrompt,
      userPrompt,
      previousUserPrompt: '请说明上一轮的处理结果。',
    }))
    assert.equal(resolveChatCapabilityMode({
      prompt: userPrompt,
      userPrompt,
      previousUserPrompt: '请说明上一轮的处理结果。',
    }), 'answer', userPrompt)
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec', 'run_project_check']) {
      assert.ok(selected.includes(name), `${userPrompt}: ${name}`)
    }
    for (const name of ['slack_send_message', 'mcp__airtable__create_record', 'Agent']) {
      assert.equal(selected.includes(name), true, `${userPrompt}: ${name}`)
    }
  }
})

test('code generation and execution requests keep command execution tools', () => {
  for (const prompt of [
    '帮我生成一个随机数脚本',
    '写一个 python 函数并运行它',
    '写段代码测试一下这个接口',
    '运行这段代码看看结果',
    'Write a script that parses this log file.',
    'Generate a small python program and run it.',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.ok(selected.includes('bash_exec'), `${prompt}: bash_exec`)
    assert.ok(selected.includes('run_project_check'), `${prompt}: run_project_check`)
  }
  for (const prompt of [
    '解释什么是函数',
    '帮我分析这段代码哪里有问题',
    '介绍一下 Python 的装饰器',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.equal(resolveChatCapabilityMode({ prompt }), 'answer', `${prompt}: answer mode`)
    assert.ok(selected.includes('bash_exec'), `${prompt}: local execution visible`)
    assert.deepEqual(selected, ANSWER_NAMES, prompt)
  }
})

test('implicit delegated commands retain execution tools without unrelated generators', () => {
  for (const prompt of [
    '登录问题你来处理好',
    'Please handle the login issue and verify the result.',
    'As analyzed above... 写入 Task 1。\n[附件: 雅思写作最新答题纸.pdf]"D:\\desktop\\雅思写作最新答题纸.pdf"',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
    for (const name of ['browser_click', 'slack_send_message', 'mcp__airtable__create_record']) {
      assert.ok(selected.includes(name), `${prompt}: ${name}`)
    }
  }
})

test('object-first webpage transformations retain write tools', () => {
  const prompt = '把它做成立体可旋转的，可以转为横着的，也可以转为竖着的'
  const selected = namesOf(selectChat({ prompt }))

  for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec']) {
    assert.ok(selected.includes(name), name)
  }
  assert.equal(selected.includes('generate_image'), false)
})

test('first-turn visual edits retain file mutation tools before any capability challenge', () => {
  for (const prompt of [
    '"E:\\果\\gallery.html"这个网站，是用了很多图片，但是现在我还有几个需求，1.图片之间太过拥挤2.旋转的时候似乎无法维系圆形',
    '请读取 E:\\果\\gallery.html，把卡片翻转后的背面显示和朝向调整好。',
    '编辑 E:\\果\\gallery.html，修好卡片背面和翻转方向。',
    '把这个页面的卡片翻转效果改一下。',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    for (const name of ['read_file', 'write_file', 'edit_file', 'apply_patch']) {
      assert.ok(selected.includes(name), `${prompt}: ${name}`)
    }
  }
})

test('an exact local file path does not alter the stable catalog', () => {
  const prompt = '"E:\\果\\gallery.html"这个网站，是用了很多图片，但是现在我还有几个需求，1.图片之间太过拥挤2.旋转的时候似乎无法维系圆形'
  const localNames = namesOf(selectJobToolSpecs({
    origin: 'chat',
    specs: SERVER_TOOL_SPECS,
    prompt,
    userPrompt: prompt,
  }))
  assert.ok(localNames.includes('read_file'))
  assert.ok(localNames.includes('write_file'))
  assert.equal(localNames.includes('read_artifact_source'), true)

  const currentArtifactNames = namesOf(selectChatToolSpecs({
    prompt: '修改当前已生成产物的颜色。',
    userPrompt: '修改当前已生成产物的颜色。',
    specs: [spec('read_artifact_source'), spec('read_file'), spec('write_file')],
    metadataResolver,
  }))
  assert.ok(currentArtifactNames.includes('read_artifact_source'))
})

test('analysis of local-file requirements remains answer-only while local tools stay visible', () => {
  for (const prompt of [
    '"E:\\果\\gallery.html"这个文件有什么问题？',
    '请分析 "E:\\果\\gallery.html" 的以下需求：1.图片是否拥挤2.旋转是否圆滑',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.equal(resolveChatCapabilityMode({ prompt }), 'answer', prompt)
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec']) {
      assert.equal(selected.includes(name), true, `${prompt}: ${name}`)
    }
  }
})

test('local UI surface names do not prune web, browser, or connector schemas', () => {
  for (const prompt of [
    '修改联网搜索页面的颜色和图标。',
    '只修改当前这一张「联网搜索」配置页面，功能全部保留不变。',
    '修改通知页面的颜色和图标。',
    '修改 Slack 消息页面的样式。',
    'Edit the gallery page and adjust the card flip direction.',
    'Edit the web search settings page styles.',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.deepEqual(selected, LOCAL_EXECUTE_NAMES, prompt)
    for (const name of [
      'web_search', 'browser_snapshot', 'browser_click',
      'slack_send_message', 'mcp__airtable__create_record',
    ]) {
      assert.ok(selected.includes(name), `${prompt}: ${name}`)
    }
  }
})

test('explicit web, browser, and connector actions keep the same stable catalog', () => {
  const web = namesOf(selectChat({
    prompt: '请联网搜索最新 Node.js LTS 版本并修改 D:\\demo\\README.md。',
  }))
  for (const name of ['web_search', 'write_file']) assert.ok(web.includes(name), name)
  for (const name of ['browser_click', 'slack_send_message']) assert.ok(web.includes(name), name)

  const browser = namesOf(selectChat({
    prompt: 'Use the browser to visit the website, then write D:\\demo\\result.txt.',
  }))
  for (const name of ['browser_snapshot', 'browser_click', 'write_file']) {
    assert.ok(browser.includes(name), name)
  }
  for (const name of ['web_search', 'slack_send_message']) assert.ok(browser.includes(name), name)

  const connector = namesOf(selectChat({ prompt: '请发送发布通知到 Slack。' }))
  assert.ok(connector.includes('slack_send_message'))
})

test('rewind_files stays discoverable before explicit rollback intent', () => {
  assert.equal(namesOf(selectChat({ prompt: '普通修改 notes.txt。' })).includes('rewind_files'), true)
  for (const prompt of [
    'Rewrite notes.txt then revert the change.',
    'Undo the changes in notes.txt.',
    '回滚 notes.txt 的修改。',
    '撤销对 notes.txt 的改动。',
    '把 notes.txt 恢复原状。',
  ]) {
    const selected = namesOf(selectChat({ prompt }))
    assert.deepEqual(selected, LOCAL_REWIND_EXECUTE_NAMES, prompt)
  }
})

test('an explicit Chinese repair delegation retains the coding execution toolchain', () => {
  const prompt = '\u4f60\u6839\u636e\u5b9e\u9645\u60c5\u51b5\u6765\u8fdb\u884c\u4fee\u590d\uff0cpython\u7b49\u7684\u4ee3\u7801\u6267\u884c\u80fd\u529b\u662f\u5fc5\u987b\u6709\u7684'
  const selected = namesOf(selectChat({ prompt }))

  assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec']) {
    assert.ok(selected.includes(name), name)
  }
  for (const name of ['git_push', 'browser_click', 'slack_send_message']) {
    assert.ok(selected.includes(name), name)
  }
})

test('explicit execute mode retains the stable non-generator catalog', () => {
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
  for (const name of ARTIFACT_NAMES) assert.equal(selected.includes(name), false, name)
  assert.deepEqual(selected, EXECUTE_NAMES)
})

test('chat execution restores the internal delivery control when upstream tool config omits it', () => {
  const configured = [spec('read_file'), spec('write_file')]
  const executeNames = namesOf(selectJobToolSpecs({
    origin: 'chat',
    specs: configured,
    prompt: 'Write the final file and deliver it.',
    intentMode: 'execute',
    metadataResolver,
  }))
  assert.deepEqual(executeNames, ['read_file', 'set_deliverables', 'write_file'])

  const answerNames = namesOf(selectJobToolSpecs({
    origin: 'chat',
    specs: configured,
    prompt: 'Explain the file format.',
    intentMode: 'answer',
    metadataResolver,
  }))
  assert.deepEqual(answerNames, ['read_file', 'set_deliverables', 'write_file'])

  const jobNames = namesOf(selectJobToolSpecs({
    origin: 'job',
    specs: configured,
    prompt: 'Write the final file.',
  }))
  assert.equal(jobNames.includes('set_deliverables'), false)
})

test('explicit answer mode suppresses the execution obligation but retains local tools', () => {
  assert.deepEqual(namesOf(selectChat({
    prompt: '/ppt 生成一份发布计划',
    skillId: 'ppt',
    intentMode: 'answer',
  })), sorted([...ANSWER_NAMES, 'create_pptx']))
})

test('artifact skill contracts expose only their authorized generator', () => {
  const selected = namesOf(selectChat({ prompt: '/ppt Q3 strategy', skillId: 'ppt' }))
  assert.deepEqual(selected, sorted([...STABLE_CHAT_NAMES, 'create_pptx']))
  assert.ok(selected.includes('create_pptx'))
  assert.equal(selected.includes('create_docx'), false)
})

test('managed attachment questions retain local tools without mounting an unrequested generator', () => {
  const summarize = namesOf(selectChat({
    prompt: '[GUGO_MANAGED_ATTACHMENT id="a1"]\n请概括附件内容',
  }))
  assert.deepEqual(summarize, ANSWER_NAMES)
  assert.ok(summarize.includes('read_file'))
  assert.ok(summarize.includes('write_file'))
  assert.equal(summarize.includes('create_docx'), false)

  const deliver = namesOf(selectChat({
    prompt: '[GUGO_MANAGED_ATTACHMENT id="a1"]\n把附件整理好并导出一份可编辑报告',
  }))
  assert.deepEqual(deliver, sorted([...STABLE_CHAT_NAMES, 'create_docx']))
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
    assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
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
    assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
    for (const name of ['write_file', 'edit_file', 'bash_exec', 'request_directory']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }
})

test('preserving article content does not downgrade a separate output workflow', () => {
  const userPrompt = '\u4e0d\u8981\u4fee\u6539\u6587\u7ae0\u5185\u5bb9\uff1b\u8bf7\u8c03\u6574\u6392\u7248\u5e76\u751f\u6210 D:\\demo\\formatted-article.pdf \u8fd9\u4e2a\u65b0\u6587\u4ef6\uff0c\u4fdd\u5b58\u540e\u9a8c\u8bc1\u8f93\u51fa\u3002'

  for (const intentMode of ['auto', 'execute']) {
    const selected = namesOf(selectChat({ prompt: userPrompt, userPrompt, intentMode }))
    assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
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
      LOCAL_EXECUTE_NAMES,
      userPrompt,
    )
  }
})

test('a capability challenge rechecks tools and inherits the preceding unfinished mutation', () => {
  const previousUserPrompt = '请修改 D:\\demo\\app.js，写入文件并运行测试。'
  for (const userPrompt of [
    '为什么不能你来改',
    '为什么不能你自己修改？',
    '为什么你不能直接改？',
    '你不能直接改吗？',
    '为什么没有写入工具？',
    '那你不能直接改吗？',
    '所以为什么不能你来修改？',
    '难道你不能自己改？',
    '既然有工具，为什么不能直接改？',
    '为什么不直接由你来改？',
    '怎么不自己修改？',
    '你不能修改用户资料？',
    "Why can't you edit it yourself?",
  ]) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
      LOCAL_EXECUTE_NAMES,
      userPrompt,
    )
  }
})

test('a capability challenge cannot invent mutation intent or override read-only context', () => {
  const challenge = '为什么不能你自己修改？'
  for (const previousUserPrompt of [
    '',
    '请解释 OAuth 刷新令牌如何工作。',
    '请解释为什么需要修改 D:\\demo\\app.js。',
    '整个项目只读，不要修改任何文件。',
    'Inspect D:\\demo\\app.js read-only. Do not modify it; explain how you would fix it.',
  ]) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: challenge, userPrompt: challenge, previousUserPrompt })),
      ANSWER_NAMES,
      previousUserPrompt,
    )
  }
  assert.deepEqual(namesOf(selectChat({
    prompt: challenge,
    userPrompt: challenge,
    previousUserPrompt: '请修改 D:\\demo\\app.js。',
    intentMode: 'answer',
  })), ANSWER_NAMES)
  assert.deepEqual(namesOf(selectChat({
    prompt: '为什么不能修改只读文件？',
    userPrompt: '为什么不能修改只读文件？',
    previousUserPrompt: '请修改 D:\\demo\\app.js。',
  })), ANSWER_NAMES)
  for (const userPrompt of [
    '为什么用户不能直接修改昵称？',
    '为什么当前用户不能修改昵称？',
    '为什么系统管理员不能编辑成员资料？',
    '为什么当前页面不能修改标题？',
    '你能解释为什么用户不能修改昵称吗？',
    'Why is the current system unable to edit records?',
  ]) {
    assert.deepEqual(namesOf(selectChat({
      prompt: userPrompt,
      userPrompt,
      previousUserPrompt: '请修改 D:\\demo\\app.js。',
    })), ANSWER_NAMES, userPrompt)
  }
})

test('short visual revisions inherit the immediately preceding file execution request', () => {
  const previousUserPrompt = '\u8bf7\u751f\u6210\u7f51\u7ad9\u5e76\u5199\u5165 E:\\u679c\\gallery.html\u3002'
  for (const userPrompt of [
    '\u989c\u8272\u518d\u6df1\u4e00\u70b9',
    '\u518d\u7acb\u4f53\u4e00\u4e9b',
    '\u628a\u80cc\u666f\u6362\u6210\u8fd9\u5f20\u56fe\u7247',
    'make it a little darker',
    'remove the red subtitle',
  ]) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
      LOCAL_EXECUTE_NAMES,
      userPrompt,
    )
  }
})

test('behavioral revision requirements inherit a preceding file modification turn', () => {
  for (const previousUserPrompt of [
    '\u4f60\u6765\u4fee\u6539',
    '\u8bf7\u4fee\u6539 E:\\\\u679c\\gallery.html \u7684\u5361\u7247\u65cb\u8f6c\u6548\u679c\u5e76\u5199\u56de\u539f\u6587\u4ef6\u3002',
  ]) {
    for (const userPrompt of [
      '\u65e0\u8bba\u6211\u600e\u4e48\u65cb\u8f6c\uff0c\u56fe\u7247\u8981\u59cb\u7ec8\u9762\u5411\u6211',
      '\u786e\u4fdd\u65cb\u8f6c\u65f6\u6bcf\u5f20\u5361\u7247\u59cb\u7ec8\u9762\u5411\u955c\u5934',
      '\u786e\u4fdd\u8fd9\u4e2a\u6587\u4ef6\u59cb\u7ec8\u4f1a\u81ea\u52a8\u91cd\u65b0\u521b\u5efa',
      'keep every image facing me while the ring rotates',
    ]) {
      assert.deepEqual(
        namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
        LOCAL_EXECUTE_NAMES,
        `${previousUserPrompt} -> ${userPrompt}`,
      )
    }
  }
})

test('response-format requirements do not inherit file mutation intent', () => {
  const previousUserPrompt = '\u8bf7\u4fee\u6539 E:\\\\u679c\\gallery.html \u5e76\u5199\u56de\u539f\u6587\u4ef6\u3002'
  for (const userPrompt of [
    'make sure you explain the code',
    '\u786e\u4fdd\u4f60\u89e3\u91ca\u4e00\u4e0b\u4ee3\u7801',
    '\u4fdd\u6301\u6587\u4ef6\u540d\u5728\u56de\u7b54\u4e2d\u53ef\u89c1',
    'keep the file name visible in your answer',
  ]) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
      ANSWER_NAMES,
      userPrompt,
    )
  }
})

test('capability decisions cap large tool catalogs without changing selection', () => {
  const specs = Array.from({ length: 320 }, (_, index) => spec(`read_${String(index).padStart(3, '0')}`))
  let decision = null
  const selected = selectChatToolSpecs({
    prompt: 'summarize the available information',
    specs,
    metadataResolver: () => ({ isReadOnly: true, riskClass: 'read' }),
    onDecision: (value) => { decision = value },
  })
  assert.equal(selected.length, 320)
  assert.equal(decision?.eligibleToolNames.length, 256)
  assert.equal(decision?.selectedToolNames.length, 256)
})

test('behavioral requirements cannot invent a file mutation without execution context', () => {
  const userPrompt = '\u65e0\u8bba\u6211\u600e\u4e48\u65cb\u8f6c\uff0c\u56fe\u7247\u8981\u59cb\u7ec8\u9762\u5411\u6211'
  for (const previousUserPrompt of [
    '',
    '\u8bf7\u89e3\u91ca\u4e3a\u4ec0\u4e48 3D \u5361\u7247\u9700\u8981\u9762\u5411\u955c\u5934\u3002',
    '\u53ea\u8bfb\u5206\u6790 E:\\\\u679c\\gallery.html\uff0c\u4e0d\u8981\u4fee\u6539\u6587\u4ef6\u3002',
  ]) {
    assert.deepEqual(
      namesOf(selectChat({ prompt: userPrompt, userPrompt, previousUserPrompt })),
      ANSWER_NAMES,
      previousUserPrompt,
    )
  }
})

test('a short visual preference cannot inherit execution from an answer-only question', () => {
  assert.deepEqual(namesOf(selectChat({
    prompt: '\u989c\u8272\u518d\u6df1\u4e00\u70b9',
    userPrompt: '\u989c\u8272\u518d\u6df1\u4e00\u70b9',
    previousUserPrompt: '\u8bf7\u89e3\u91ca\u6df1\u8272\u4e3b\u9898\u4e3a\u4ec0\u4e48\u66f4\u9002\u5408 OLED\u3002',
  })), ANSWER_NAMES)
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
  const selected = namesOf(selectChat({ prompt, userPrompt, intentMode: 'execute' }))
  assert.deepEqual(selected, ANSWER_NAMES)
  assert.ok(selected.includes('request_clarification'))
  assert.ok(selected.includes('request_directory'))
  for (const name of ALWAYS_VISIBLE_LOCAL_EXECUTION_NAMES) assert.ok(selected.includes(name), name)
})

test('a capability question preserves the immediately preceding explicit read-only boundary', () => {
  let decision = null
  const selected = namesOf(selectChatToolSpecs({
    prompt: '\u4e3a\u4ec0\u4e48\u4e0d\u80fd\u4f60\u81ea\u5df1\u4fee\u6539\uff1f',
    userPrompt: '\u4e3a\u4ec0\u4e48\u4e0d\u80fd\u4f60\u81ea\u5df1\u4fee\u6539\uff1f',
    previousUserPrompt: '\u8bf7\u53ea\u5206\u6790\u95ee\u9898\uff0c\u4e0d\u8981\u7f16\u8f91\u3001\u8c03\u6574\u6216\u5199\u56de\u4efb\u4f55\u6587\u4ef6\u3002',
    specs: SPECS,
    metadataResolver,
    onDecision: (value) => { decision = value },
  }))

  assert.deepEqual(selected, sorted(TOOL_NAMES))
  assert.equal(decision?.explicitReadOnly, true)
  for (const name of ALWAYS_VISIBLE_LOCAL_EXECUTION_NAMES) {
    assert.ok(decision?.selectedToolNames.includes(name), name)
    assert.ok(!decision?.excludedTools.some((entry) => entry.name === name), name)
  }
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
  assert.deepEqual(selected, LOCAL_EXECUTE_NAMES)
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

test('tool switches prune disabled schemas while preserving the remaining stable catalog', () => {
  const disabled = ['create_docx', 'bash_exec', 'browser_click', 'slack_send_message', 'read_file']
  const configured = applyServerToolsConfig(SPECS, {
    enabled: ['read_file'],
    disabled,
  })
  const catalogs = []
  for (const { prompt, intentMode } of [
    { prompt: 'Implement the whole workflow.', intentMode: 'execute' },
    { prompt: 'Explain the whole workflow.', intentMode: 'answer' },
  ]) {
    const selected = namesOf(selectChatToolSpecs({
      prompt,
      intentMode,
      specs: configured,
      metadataResolver,
    }))
    catalogs.push(selected)
    for (const name of disabled) {
      assert.equal(selected.includes(name), false, `${intentMode}: ${name}`)
    }
    for (const name of ['write_file', 'request_clarification', 'request_directory', 'web_search']) {
      assert.ok(selected.includes(name), `${intentMode}: ${name}`)
    }
  }
  assert.deepEqual(catalogs[1], catalogs[0])
})

test('answer-mode diagnostics do not report any registered tool as an intent exclusion', () => {
  let decision = null
  const selected = namesOf(selectChatToolSpecs({
    prompt: '为什么还是没有写入工具',
    specs: SPECS,
    metadataResolver,
    onDecision: (value) => { decision = value },
  }))

  for (const name of ['write_file', 'edit_file', 'apply_patch', 'bash_exec', 'run_project_check']) {
    assert.ok(selected.includes(name), name)
    assert.equal(decision?.excludedTools.some((entry) => entry.name === name), false, name)
  }
  assert.deepEqual(decision?.excludedTools, [])
})

test('answer-mode recovery tools are removed when their execution switches are disabled', () => {
  const configured = applyServerToolsConfig(SPECS, {
    enabled: ['request_clarification', 'request_directory'],
    disabled: ['request_clarification', 'request_directory'],
  })
  const selected = namesOf(selectChatToolSpecs({
    prompt: 'Explain OAuth.',
    specs: configured,
    metadataResolver,
  }))
  assert.equal(selected.includes('request_clarification'), false)
  assert.equal(selected.includes('request_directory'), false)
  assert.ok(selected.includes('manage_todos'))
  assert.ok(selected.includes('write_file'))
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

test('local mutation selection is deterministic across catalog permutations and repeated runs', () => {
  const prompt = '修改 D:\\demo\\app.js，写入文件并运行测试。'
  const permutations = [
    SPECS,
    [...SPECS].reverse(),
    [...SPECS.slice(7), ...SPECS.slice(0, 7)],
  ]
  for (let run = 0; run < 5; run += 1) {
    for (const specs of permutations) {
      const selected = namesOf(selectJobToolSpecs({
        origin: 'chat',
        specs,
        prompt,
        userPrompt: prompt,
        metadataResolver,
      }))
      assert.deepEqual(selected, LOCAL_EXECUTE_NAMES, `${run}`)
    }
  }
})

test('duplicate tool names resolve to one canonical schema independent of load order', () => {
  const schemaA = spec('write_file')
  const schemaB = spec('write_file')
  schemaA.function.description = 'schema-A'
  schemaB.function.description = 'schema-B'
  const prompt = '修改 D:\\demo\\app.js。'
  const selectDuplicate = (specs) => selectChatToolSpecs({
    prompt,
    userPrompt: prompt,
    specs,
    metadataResolver,
  })

  const forward = selectDuplicate([spec('read_file'), schemaB, schemaA])
  const reversed = selectDuplicate([schemaA, schemaB, spec('read_file')])
  assert.deepEqual(forward, reversed)
  assert.equal(forward.find((item) => item.function.name === 'write_file')?.function.description, 'schema-A')
})
