import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_SECTION_KINDS,
  hasCompletionReport,
  parseAgentReportSections,
} from '../shared/agentReportSections.js'

test('a marker-less message stays exactly what it was', () => {
  // Backward compatibility: older turns, other flows and models that ignore the
  // format must render identically to before this parser existed.
  const text = 'Here is the answer.\n\n| a | b |\n| - | - |\n| 1 | 2 |'
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.hasMarkers, false)
  assert.equal(parsed.report, text)
  assert.deepEqual(parsed.trajectory, [])
  assert.equal(hasCompletionReport(text), false)
  assert.deepEqual(parseAgentReportSections('').trajectory, [])
})

test('report and trajectory are separated without mixing logs into the report', () => {
  const text = [
    '【Thought】先确认表格结构再写入文件。',
    '【Action】read_file path=report.md',
    '【Observation】表格有 3 列、含合并单元格。',
    '【Thought】按原结构生成新的 xlsx。',
    '【Action】create_xlsx path=out.xlsx',
    '【Observation】out.xlsx 已写入 12KB。',
    '【任务完成报告】',
    '已生成 out.xlsx，保留 3 列与合并单元格。',
    '交付文件：out.xlsx',
  ].join('\n')
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.hasMarkers, true)
  assert.equal(parsed.reportFound, true)
  assert.equal(parsed.report, '已生成 out.xlsx，保留 3 列与合并单元格。\n交付文件：out.xlsx')
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
  ])
  // The trajectory must not duplicate the report body.
  for (const entry of parsed.trajectory) {
    assert.doesNotMatch(entry.text, /交付文件/u)
  }
})

test('prose before the first marker is kept, but out of the report', () => {
  const parsed = parseAgentReportSections([
    '当然可以，我马上处理。',
    '【任务完成报告】结果：表格已生成。',
  ].join('\n'))
  assert.equal(parsed.report, '结果：表格已生成。')
  assert.equal(parsed.trajectory.length, 1)
  assert.equal(parsed.trajectory[0].kind, AGENT_SECTION_KINDS.THOUGHT)
  assert.match(parsed.trajectory[0].text, /当然可以/u)
})

test('markers inside fenced code blocks stay literal', () => {
  const text = [
    '【任务完成报告】已修复解析器。',
    '',
    '```js',
    '// 【Action】 this is sample code, not a real section',
    'const x = "【Thought】"',
    '```',
    '',
    '【Observation】测试通过。',
  ].join('\n')
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.reportFound, true)
  assert.match(parsed.report, /```js/u)
  assert.match(parsed.report, /this is sample code/u)
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [AGENT_SECTION_KINDS.OBSERVATION])
})

test('label variants, list bullets and inline bodies are accepted', () => {
  const variants = [
    '- 【Thought】带项目符号',
    '1. 【Action】带序号',
    '【observation】: 半角标签与冒号',
    '- [Action] 半角方括号',
    '【思考】中文标签',
    '【观察】中文观察',
  ]
  const parsed = parseAgentReportSections(variants.join('\n'))
  assert.equal(parsed.hasMarkers, true)
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.OBSERVATION,
  ])
  assert.equal(parsed.trajectory[1].text, '带序号')
  assert.equal(parsed.trajectory[2].text, '半角标签与冒号')
})

test('a report marker with an empty body is still reported as a completion report', () => {
  const parsed = parseAgentReportSections('【Thought】做完了\n【任务完成报告】')
  assert.equal(parsed.reportFound, true)
  assert.equal(parsed.report, '')
  assert.equal(hasCompletionReport('【Thought】做完了\n【任务完成报告】'), true)
  assert.equal(hasCompletionReport('【Action】lint'), false)
})

test('ordinary bracketed prose is not mistaken for a section', () => {
  const text = '【重要】请检查这个表格\n[note] 这不是分段标记'
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.hasMarkers, false)
  assert.equal(parsed.report, text)
})

test('the collapsible container is consumed as a marker, never rendered', () => {
  const text = [
    '<collapsible title="完整执行过程（点击展开）">',
    '【Thought】先看目录结构。',
    '【Action】list_dir path=.',
    '【Observation】29 个目录。',
    '</collapsible>',
    '【任务完成报告】',
    '顶层共有 29 个目录，前三个是 .artifacts、.claude、.git。',
  ].join('\n')
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.hasMarkers, true)
  assert.equal(parsed.reportFound, true)
  assert.equal(parsed.collapsibleTitle, '完整执行过程（点击展开）')
  assert.equal(parsed.report, '顶层共有 29 个目录，前三个是 .artifacts、.claude、.git。')
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
  ])
  // Neither tag may reach the rendered text, in the report or in the trajectory.
  for (const entry of parsed.trajectory) {
    assert.doesNotMatch(entry.text, /<\/?collapsible/u)
    assert.doesNotMatch(entry.text, /完整执行过程/u)
  }
  assert.doesNotMatch(parsed.report, /<\/?collapsible/u)
})

test('a container with no inner markers still keeps its body out of the report', () => {
  const parsed = parseAgentReportSections([
    '【任务完成报告】已完成。',
    '<collapsible title="完整执行过程（点击展开）">',
    '先读文件，再改代码，最后跑测试。',
    '</collapsible>',
  ].join('\n'))
  assert.equal(parsed.report, '已完成。')
  assert.equal(parsed.trajectory.length, 1)
  assert.equal(parsed.trajectory[0].kind, AGENT_SECTION_KINDS.THOUGHT)
  assert.match(parsed.trajectory[0].text, /先读文件/u)
  assert.doesNotMatch(parsed.trajectory[0].text, /collapsible/u)
})

test('an unclosed container keeps routing to the trajectory instead of leaking the rest', () => {
  const parsed = parseAgentReportSections([
    '【任务完成报告】已完成。',
    '<collapsible title="完整执行过程（点击展开）">',
    '【Action】npm test',
    '【Observation】全绿。',
  ].join('\n'))
  assert.equal(parsed.report, '已完成。')
  assert.equal(parsed.reportFound, true)
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
  ])
})

test('a collapsible tag inside a fenced code block stays literal documentation', () => {
  const text = [
    '【任务完成报告】解析器已支持容器标记。',
    '',
    '```html',
    '<collapsible title="example">',
    '【Thought】这一行是文档示例',
    '</collapsible>',
    '```',
  ].join('\n')
  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.collapsibleTitle, '')
  assert.match(parsed.report, /<collapsible title="example">/u)
  assert.match(parsed.report, /<\/collapsible>/u)
  assert.deepEqual(parsed.trajectory, [])
})

test('a real turn that skipped the report marker still shows its summary on top', () => {
  // Verbatim shape of a real turn (mimo-v2.5 through the local runtime) after the
  // output contract was added: it followed the container instruction but wrote
  // the summary without 【任务完成报告】. The summary outside the container is the
  // report; otherwise the interface would hide the whole answer behind the
  // collapsed area.
  const text = [
    '当前工作目录下共有 **29 个**顶层目录。前三个目录名称如下：',
    '',
    '1. `.artifacts`',
    '2. `.claude`',
    '3. `.git`',
    '',
    '<collapsible title="完整执行过程（点击展开）">',
    '【Thought】用户要求列出当前工作目录下的顶层目录名称，最多三个，并说明总数。',
    '【Action】调用 list_directory(path=".", limit=500) 来获取所有条目。',
    '【Observation】返回了 62 个条目，其中 29 个是目录。',
    '</collapsible>',
  ].join('\n')

  const parsed = parseAgentReportSections(text)
  assert.equal(parsed.hasMarkers, true)
  assert.equal(parsed.reportFound, true, 'the summary outside the container counts as the report')
  assert.match(parsed.report, /共有 \*\*29 个\*\*顶层目录/u)
  assert.equal(parsed.collapsibleTitle, '完整执行过程（点击展开）')
  // The report must not repeat the steps, and the steps must not repeat the report.
  assert.doesNotMatch(parsed.report, /【Thought】/u)
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    AGENT_SECTION_KINDS.THOUGHT,
    AGENT_SECTION_KINDS.ACTION,
    AGENT_SECTION_KINDS.OBSERVATION,
  ])
  for (const entry of parsed.trajectory) assert.doesNotMatch(entry.text, /共有/u)
})
