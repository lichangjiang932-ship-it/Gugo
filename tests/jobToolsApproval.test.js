/**
 * 证明审批门控真的拦在 runToolsLoop 里面(server/services/jobTools.js)。
 *
 * 关键点:executeTool 用注入的假实现,绝不真跑 shell;runModel 第一轮返回
 * 一个 bash_exec tool call,第二轮返回纯文本收尾。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-jobtools-approval-'))
process.env.APP_DATA_DIR = TMP_DIR
process.env.APPROVAL_MODE = 'unattended'

const { runToolsLoop } = await import('../server/services/jobTools.js')
const { releaseApproval, _resetWaiters } = await import('../server/services/approvalGate.js')
const { listPendingApprovals, decideApproval } = await import('../server/services/approvalStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { rememberTool } = await import('../server/services/approvalSettingsStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

/** pending_approvals.job_id 有 FK → jobs(id),所以测试 job 必须真入库。 */
function makeJob({ id, userId, title }) {
  createJob({ id, userId, title, prompt: title, status: 'running' })
  return { id, userId, title }
}

/** 轮询直到该用户出现一条 pending 审批(或超时)。 */
async function waitForPending(userId, { timeoutMs = 5000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pending = listPendingApprovals({ userId, status: 'pending' })
    if (pending.length > 0) return pending[0]
    if (Date.now() > deadline) throw new Error('等待 pending 审批超时')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** 决策 + 立刻唤醒等待者(不依赖 5s 兜底轮询)。 */
function decideAndRelease({ userId, id, decision, editedArgs = null }) {
  const res = decideApproval({ userId, id, decision, editedArgs })
  assert.equal(res.ok, true, `decideApproval(${decision}) 应当成功`)
  releaseApproval(id)
  return res
}

/** 第一轮要 bash_exec,第二轮纯文本收尾。 */
function makeRunModel({ finalText, command = 'rm -rf /tmp/whatever', toolName = 'bash_exec', toolArgs = null, seenMessages = [] }) {
  let turns = 0
  return async ({ messages }) => {
    turns += 1
    seenMessages.push(messages.map((m) => ({ role: m.role, name: m.name, content: m.content })))
    if (turns === 1) {
      return {
        content: '',
        toolCalls: [{
          id: `call-${toolName}-1`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(toolArgs || { command }) },
        }],
      }
    }
    return { content: finalText, toolCalls: [] }
  }
}

test.after(() => {
  _resetWaiters()
  try { closeDb() } catch { /* 已关闭 */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('INTERCEPTION: bash_exec 在批准前不会到达 executeTool', async () => {
  const { userId } = issueTestSession({ email: 'approval-intercept@example.com' })
  const calls = []
  const fakeExecute = async ({ name, args }) => {
    calls.push({ name, args })
    return { ok: true, stdout: 'ran' }
  }

  const loop = runToolsLoop({
    job: makeJob({ id: 'job-approval-1', userId, title: 'gated' }),
    step: { id: 'step-approval-1', kind: 'execute' },
    messages: [{ role: 'user', content: '删点东西' }],
    runModel: makeRunModel({ finalText: '已执行。' }),
    executeTool: fakeExecute,
  })

  const pending = await waitForPending(userId)
  assert.equal(pending.toolName, 'bash_exec')
  assert.equal(pending.jobId, 'job-approval-1')
  assert.equal(pending.stepId, 'step-approval-1')
  assert.equal(calls.length, 0, '决策之前 executeTool 绝不能被调用')

  decideAndRelease({ userId, id: pending.id, decision: 'approve' })

  const result = await loop
  assert.equal(calls.length, 1, '批准后 executeTool 应当且仅当执行一次')
  assert.equal(calls[0].name, 'bash_exec')
  assert.equal(calls[0].args.command, 'rm -rf /tmp/whatever')
  assert.equal(result.text, '已执行。')
  assert.equal(listPendingApprovals({ userId, status: 'pending' }).length, 0)
})

test('EDITED ARGS: 改写后的参数才是 executeTool 收到的参数', async () => {
  const { userId } = issueTestSession({ email: 'approval-edit@example.com' })
  const calls = []
  const fakeExecute = async ({ name, args }) => {
    calls.push({ name, args })
    return { ok: true, stdout: 'ok' }
  }

  const loop = runToolsLoop({
    job: makeJob({ id: 'job-approval-2', userId, title: 'edited' }),
    step: { id: 'step-approval-2', kind: 'execute' },
    messages: [{ role: 'user', content: '跑个命令' }],
    runModel: makeRunModel({ finalText: '改写后已执行。', command: 'rm -rf /' }),
    executeTool: fakeExecute,
  })

  const pending = await waitForPending(userId)
  assert.equal(pending.args.command, 'rm -rf /', '落库的应当是模型原始参数')

  decideAndRelease({
    userId,
    id: pending.id,
    decision: 'edit',
    editedArgs: { command: 'echo safe', cwd: '/tmp' },
  })

  const result = await loop
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.command, 'echo safe', 'executeTool 必须收到改写后的命令')
  assert.equal(calls[0].args.cwd, '/tmp')
  assert.notEqual(calls[0].args.command, 'rm -rf /')
  assert.equal(result.text, '改写后已执行。')
})

test('DENY: 拒绝不杀死 job,拒绝结果作为 tool 消息喂回模型', async () => {
  const { userId } = issueTestSession({ email: 'approval-deny@example.com' })
  const calls = []
  const fakeExecute = async ({ name, args }) => {
    calls.push({ name, args })
    return { ok: true }
  }
  const seenMessages = []

  const loop = runToolsLoop({
    job: makeJob({ id: 'job-approval-3', userId, title: 'denied' }),
    step: { id: 'step-approval-3', kind: 'execute' },
    messages: [{ role: 'user', content: '删库' }],
    runModel: makeRunModel({ finalText: '我换个方式来做。', seenMessages }),
    executeTool: fakeExecute,
  })

  const pending = await waitForPending(userId)
  decideAndRelease({ userId, id: pending.id, decision: 'deny' })

  const result = await loop

  assert.equal(calls.length, 0, '被拒绝时 executeTool 一次都不能被调用')
  assert.equal(result.text, '我换个方式来做。', 'loop 应当照常收尾并返回终稿文本')
  assert.equal(result.paused, undefined, '拒绝不是 pause')
  assert.equal(result.budgetExceeded, undefined)

  // 第二轮模型看到的对话里应当有一条标记拒绝的 tool 消息
  const secondTurn = seenMessages[1]
  assert.ok(secondTurn, '模型应当被第二次调用(未被 throw 打断)')
  const toolMsg = secondTurn.find((m) => m.role === 'tool' && m.name === 'bash_exec')
  assert.ok(toolMsg, '应当有一条 bash_exec 的 tool 结果消息')
  const payload = JSON.parse(toolMsg.content)
  assert.equal(payload.ok, false)
  assert.equal(payload.denied, true, 'tool 结果必须标记为被拒绝,模型才能改道')
  assert.ok(typeof payload.error === 'string' && payload.error.length > 0)
})

test('NEVER_APPROVE: create_docx 直通,不产生任何 pending 行', async () => {
  const { userId } = issueTestSession({ email: 'approval-never@example.com' })
  const calls = []
  let turns = 0
  const runModel = async () => {
    turns += 1
    if (turns === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call-docx-1',
          type: 'function',
          function: {
            name: 'create_docx',
            arguments: JSON.stringify({ title: '纪要', paragraphs: [{ text: '正文' }] }),
          },
        }],
      }
    }
    return { content: '文档已生成。', toolCalls: [] }
  }

  const result = await runToolsLoop({
    job: makeJob({ id: 'job-approval-4', userId, title: 'ungated' }),
    step: { id: 'step-approval-4', kind: 'execute' },
    messages: [{ role: 'user', content: '写个 Word' }],
    runModel,
    executeTool: async ({ name, args }) => {
      calls.push({ name, args })
      return { ok: true, artifactId: 'art-docx-1' }
    },
  })

  assert.equal(calls.length, 1, 'create_docx 应当直接执行')
  assert.equal(calls[0].name, 'create_docx')
  assert.equal(result.text, '文档已生成。')
  assert.equal(result.artifactIds[0], 'art-docx-1')
  assert.equal(
    listPendingApprovals({ userId, status: 'all' }).length,
    0,
    '普通产出物不应产生任何审批记录',
  )
})

test('standing rule 命中来源写入 tool 结果供事件与卡片审计', async () => {
  const { userId } = issueTestSession({ email: 'approval-standing-audit@example.com' })
  rememberTool({ userId, toolName: 'slack_send_message', args: { channelId: 'C-ops', text: 'first' } })
  const seenMessages = []
  const result = await runToolsLoop({
    job: makeJob({ id: 'job-approval-standing', userId, title: 'standing audit' }),
    step: { id: 'step-approval-standing', kind: 'execute' },
    messages: [{ role: 'user', content: '发送通知' }],
    runModel: makeRunModel({ finalText: '通知完成。', toolName: 'slack_send_message', toolArgs: { channelId: 'C-ops', text: 'later' }, seenMessages }),
    executeTool: async () => ({ ok: true, stdout: 'passed' }),
  })
  assert.equal(result.text, '通知完成。')
  const toolMessage = seenMessages[1].find((message) => message.role === 'tool')
  const payload = JSON.parse(toolMessage.content)
  assert.deepEqual(payload.approvalAuthorization, {
    kind: 'standing_rule', toolName: 'slack_send_message', scope: 'target:channelId=C-ops',
  })
  assert.equal(listPendingApprovals({ userId, status: 'all' }).length, 0)
})
