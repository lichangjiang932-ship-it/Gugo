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
