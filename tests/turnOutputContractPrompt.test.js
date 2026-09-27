import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'
import { parseAgentReportSections } from '../shared/agentReportSections.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-output-contract-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'output-contract@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
upsertSession({ id: 'contract-session', userId, title: 'Contract' })

// Regression: the interface parsed 【任务完成报告】 / 【Thought】 / 【Action】 /
// 【Observation】 from the day it was written, but nothing in the prompt ever
// asked the model for that shape, so the parser only ever took its fallback
// path and the collapsed trajectory stayed empty. This is the guard for that.
test('every turn tells the model the response shape the interface parses', async () => {
  const prepared = await prepareTurnPromptContext({
    userId,
    sessionId: 'contract-session',
    includeRecentTranscript: false,
    env: { AGENT_INJECT_ENABLED: '0' },
  })

  const contracts = prepared.messages.filter((message) => message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('# Output Contract'))
  assert.equal(contracts.length, 1, 'exactly one output-contract block reaches the model')
  const text = contracts[0].content

  // The section labels, spelled the way the parser accepts them.
  for (const label of ['【任务完成报告】', '【Thought】', '【Action】', '【Observation】']) {
    assert.ok(text.includes(label), `the contract states ${label}`)
  }
  // The container marker, with the title the interface shows for it.
  assert.ok(text.includes('<collapsible title="完整执行过程（点击展开）">'), 'the container is stated literally')
  assert.ok(text.includes('</collapsible>'), 'the container is closed in the example')
  // The rules the product owner asked for.
  assert.match(text, /Never put intermediate logs/i)
  assert.match(text, /no other tags or markup/i)
  assert.match(text, /[Rr]epeat until the task is finished/, 'the ReAct loop is stated')
  // The two the model actually missed when measured against real turns.
  assert.match(text, /Always emit 【任务完成报告】/, 'the report is stated as mandatory')
  assert.match(text, /Whenever you ran at least one tool, put those steps in the container/,
    'the container is required whenever a tool ran')

  // It belongs to the stable prefix, not to the per-turn tail.
  const index = prepared.messages.indexOf(contracts[0])
  assert.ok(index < prepared.promptFingerprints.stableBlockCount,
    `the contract sits inside the stable prefix (index ${index} of ${prepared.promptFingerprints.stableBlockCount})`)
})

test('the shape the contract asks for is the shape the parser splits', () => {
  // Written the way the contract instructs, in the order the contract shows.
  const answer = [
    '【Thought】先确认表格结构再写入文件。',
    '【Action】read_file path=report.md',
    '【Observation】表格有 3 列。',
    '<collapsible title="完整执行过程（点击展开）">',
    '【Thought】按原结构生成新的 xlsx。',
    '【Action】create_xlsx path=out.xlsx',
    '【Observation】out.xlsx 已写入 12KB。',
    '</collapsible>',
    '【任务完成报告】',
    '已生成 out.xlsx，保留 3 列。',
  ].join('\n')

  const parsed = parseAgentReportSections(answer)
  assert.equal(parsed.reportFound, true)
  assert.equal(parsed.report, '已生成 out.xlsx，保留 3 列。')
  assert.equal(parsed.collapsibleTitle, '完整执行过程（点击展开）')
  assert.deepEqual(parsed.trajectory.map((entry) => entry.kind), [
    'thought', 'action', 'observation', 'thought', 'action', 'observation',
  ])
  // The report must carry no step narration, and no marker text may survive.
  assert.doesNotMatch(parsed.report, /【(?:Thought|Action|Observation)】|collapsible/u)
  for (const entry of parsed.trajectory) {
    assert.doesNotMatch(entry.text, /collapsible/u)
    assert.doesNotMatch(entry.text, /已生成 out\.xlsx/u)
  }
})
