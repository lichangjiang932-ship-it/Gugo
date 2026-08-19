import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-task-grant-approval-'))
process.env.APP_DATA_DIR = tempDir

const { requestApproval, _resetWaiters } = await import('../server/services/approvalGate.js')
const { countPendingApprovals, listPendingApprovals } = await import('../server/services/approvalStore.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function user(tag, mode = 'normal') {
  const session = issueTestSession({ email: `task-grant-${tag}-${process.pid}@example.com` })
  setApprovalMode({ userId: session.userId, mode })
  const jobId = `task-grant-job-${tag}-${process.pid}`
  createJob({ id: jobId, userId: session.userId, title: tag, prompt: tag })
  return { userId: session.userId, jobId }
}

async function waitForPending(userId) {
  for (let index = 0; index < 100; index += 1) {
    const [approval] = listPendingApprovals({ userId, status: 'pending' })
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('task grant approval row was not created')
}

test.afterEach(() => _resetWaiters())
test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('matching shell and external task grants auto-allow without inbox rows', async () => {
  const { userId, jobId } = user('exact')
  const shell = await requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'bash_exec',
    args: { command: 'git pull origin main' },
    mode: 'unattended',
    taskGrants: [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }],
  })
  assert.equal(shell.proceed, true)
  assert.equal(shell.authorization?.source, 'task_grant')

  const external = await requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'publish_report',
    args: { channelId: 'C-ops', text: 'daily' },
    mode: 'unattended',
    taskGrants: [{ tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'this-run' }],
  })
  assert.equal(external.proceed, true)
  assert.equal(external.authorization?.kind, 'task_grant')
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('plan and Hook force-approval remain stronger than a matching task grant', async () => {
  const planUser = user('plan', 'plan')
  const grant = [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }]
  const plan = await requestApproval({
    userId: planUser.userId,
    origin: 'job',
    jobId: planUser.jobId,
    toolName: 'bash_exec',
    args: { command: 'git pull origin main' },
    taskGrants: grant,
  })
  assert.equal(plan.proceed, false)
  assert.equal(plan.policyDenied, true)
  assert.equal(countPendingApprovals({ userId: planUser.userId }), 0)

  const hookUser = user('hook')
  const controller = new AbortController()
  const pending = requestApproval({
    userId: hookUser.userId,
    origin: 'job',
    jobId: hookUser.jobId,
    toolName: 'bash_exec',
    args: { command: 'git pull origin main' },
    taskGrants: grant,
    forceApproval: true,
    forceApprovalReason: 'Hook requires review',
    signal: controller.signal,
  })
  const approval = await waitForPending(hookUser.userId)
  assert.equal(approval.reason, 'Hook requires review')
  controller.abort()
  assert.equal((await pending).proceed, false)
})

test('local writes and non-matching shell prefixes still require approval', async () => {
  const { userId, jobId } = user('blocked')
  for (const [toolName, args, taskGrants] of [
    ['write_file', { path: 'output.txt', content: 'x' }, [
      { tool: 'write_file', target: { path: 'output.txt' }, scope: 'forever' },
    ]],
    ['bash_exec', { command: 'git push origin main' }, [
      { tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' },
    ]],
  ]) {
    const controller = new AbortController()
    const pending = requestApproval({
      userId,
      origin: 'job',
      jobId,
      toolName,
      args,
      taskGrants,
      signal: controller.signal,
    })
    const approval = await waitForPending(userId)
    assert.equal(approval.toolName, toolName)
    controller.abort()
    assert.equal((await pending).proceed, false)
  }
})
