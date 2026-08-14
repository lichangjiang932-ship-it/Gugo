import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-job-hooks-'))
process.env.APP_DATA_DIR = TMP_DIR
process.env.APP_DB_PATH = path.join(TMP_DIR, 'app.db')
process.env.APPROVAL_MODE = 'off'
process.env.HOOKS_SHELL_ENABLED = '1'
process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath

const { runToolsLoop } = await import('../server/services/jobTools.js')
const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { upsertHook } = await import('../server/services/hooksService.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { decideApproval, listPendingApprovals } = await import('../server/services/approvalStore.js')
const { releaseApproval } = await import('../server/services/approvalGate.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function shellJsonHook(value) {
  return [process.execPath, '-e', `process.stdout.write(JSON.stringify(${JSON.stringify(value)}))`]
}

function oneToolModel(name, args, finalText = 'done') {
  let turn = 0
  return async () => {
    turn += 1
    if (turn === 1) {
      return {
        content: '',
        toolCalls: [{
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      }
    }
    return { content: finalText, toolCalls: [] }
  }
}

async function waitForPendingApproval(userId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = listPendingApprovals({ userId, status: 'pending' })[0]
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for hook-forced approval')
}

test.after(() => {
  closeDb()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

test('autonomous job applies pre hook replacements before execution and emits post hook output', async () => {
  const { userId } = issueTestSession({ email: 'job-hook-rewrite@example.com' })
  setApprovalMode({ userId, mode: 'bypass' })
  const postFile = path.join(TMP_DIR, 'post-hook.json')
  upsertHook({
    userId,
    event: 'pre_tool_use',
    toolPattern: 'demo_tool',
    kind: 'shell',
    command: shellJsonHook({ allow: true, replacementArgs: { value: 'rewritten' } }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })
  upsertHook({
    userId,
    event: 'post_tool_use',
    toolPattern: 'demo_tool',
    kind: 'shell',
    command: [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(postFile)}, process.argv[1], 'utf8')`,
    ],
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })

  const executed = []
  const result = await runToolsLoop({
    job: { id: 'job-hook-rewrite', userId, prompt: 'run demo' },
    step: { id: 'step-hook-rewrite' },
    messages: [{ role: 'user', content: 'run demo' }],
    runModel: oneToolModel('demo_tool', { value: 'original' }),
    executeTool: async ({ args }) => {
      executed.push(args)
      return { ok: true, echoed: args.value }
    },
  })

  assert.equal(result.text, 'done')
  assert.deepEqual(executed, [{ value: 'rewritten' }])
  const postPayload = JSON.parse(fs.readFileSync(postFile, 'utf8'))
  assert.equal(postPayload.event, 'post_tool_use')
  assert.equal(postPayload.tool, 'demo_tool')
  assert.equal(postPayload.sessionId, 'job-hook-rewrite')
  assert.equal(postPayload.requestId, 'step-hook-rewrite')
  assert.deepEqual(postPayload.args.input, { value: 'rewritten' })
  assert.equal(postPayload.args.output.echoed, 'rewritten')
})

test('autonomous job pre hook can deny a tool before the executor runs', async () => {
  const { userId } = issueTestSession({ email: 'job-hook-deny@example.com' })
  upsertHook({
    userId,
    event: 'pre_tool_use',
    toolPattern: 'blocked_tool',
    kind: 'shell',
    command: shellJsonHook({ allow: false, reason: 'blocked by policy' }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })

  let executions = 0
  const seen = []
  await runToolsLoop({
    job: { id: 'job-hook-deny', userId, prompt: 'blocked demo' },
    step: { id: 'step-hook-deny' },
    messages: [{ role: 'user', content: 'blocked demo' }],
    runModel: async ({ messages }) => {
      seen.push(messages)
      return oneToolModel('blocked_tool', { value: 'unsafe' }, 'used fallback')()
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
    maxIters: 2,
  })

  assert.equal(executions, 0)
  const toolMessage = seen.flat().find((message) => message.role === 'tool' && message.name === 'blocked_tool')
  assert.ok(toolMessage)
  const denied = JSON.parse(toolMessage.content)
  assert.equal(denied.code, 'hook_denied')
  assert.equal(denied.denied, true)
})

test('pre hook ask forces a matched safe call through approval before execution', async () => {
  const { userId } = issueTestSession({ email: 'job-hook-ask@example.com' })
  setApprovalMode({ userId, mode: 'bypass' })
  upsertHook({
    userId,
    event: 'pre_tool_use',
    toolPattern: 'demo_tool',
    argumentMatcher: { value: 'review' },
    kind: 'shell',
    command: shellJsonHook({ allow: true, permissionDecision: 'ask', reason: 'matched policy' }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })

  let executions = 0
  const running = runToolsLoop({
    job: { id: 'turn-hook-ask', userId, prompt: 'run reviewed demo' },
    step: { id: 'step-hook-ask' },
    messages: [{ role: 'user', content: 'run reviewed demo' }],
    runModel: oneToolModel('demo_tool', { value: 'review' }),
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
    approvalOrigin: 'chat',
    approvalSessionId: 'session-hook-ask',
  })

  const approval = await waitForPendingApproval(userId)
  assert.equal(executions, 0)
  assert.equal(approval.reason, 'matched policy')
  decideApproval({ userId, id: approval.id, decision: 'approve' })
  releaseApproval(approval.id)

  const result = await running
  assert.equal(result.text, 'done')
  assert.equal(executions, 1)
})

test('job prompt lifecycle hook can rewrite or reject a queued autonomous job', async () => {
  const rewriteUser = issueTestSession({ email: 'job-prompt-rewrite@example.com' }).userId
  upsertHook({
    userId: rewriteUser,
    event: 'user_prompt_submit',
    toolPattern: 'job',
    kind: 'shell',
    command: shellJsonHook({ allow: true, replacementArgs: { prompt: 'rewritten prompt' } }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })
  const executedJobs = []
  const rewriteRuntime = new JobRuntime({
    executeStep: async ({ job }) => {
      executedJobs.push({ id: job.id, prompt: job.prompt })
      return { ok: true, output: { text: 'ok' } }
    },
  })
  const rewritten = await rewriteRuntime.createJob('original prompt', { userId: rewriteUser })
  await rewriteRuntime.drain()
  assert.equal(rewriteRuntime.getJob(rewritten.id, { userId: rewriteUser }).prompt, 'rewritten prompt')
  const targetPrompts = executedJobs
    .filter(({ id }) => id === rewritten.id)
    .map(({ prompt }) => prompt)
  assert.ok(targetPrompts.length > 0)
  assert.ok(targetPrompts.every((prompt) => prompt === 'rewritten prompt'))

  const denyUser = issueTestSession({ email: 'job-prompt-deny@example.com' }).userId
  upsertHook({
    userId: denyUser,
    event: 'user_prompt_submit',
    toolPattern: 'job',
    kind: 'shell',
    command: shellJsonHook({ allow: false, reason: 'prompt denied' }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })
  let deniedExecutions = 0
  const denyRuntime = new JobRuntime({
    executeStep: async () => {
      deniedExecutions += 1
      return { ok: true }
    },
  })
  const deniedJob = await denyRuntime.createJob('deny this prompt', { userId: denyUser })
  await denyRuntime.drain()
  const loaded = denyRuntime.getJob(deniedJob.id, { userId: denyUser })
  assert.equal(loaded.status, 'failed')
  assert.match(loaded.error, /prompt denied/)
  assert.equal(deniedExecutions, 0)
})
