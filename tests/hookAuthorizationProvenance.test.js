import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-hook-authorization-'))
process.env.APP_DATA_DIR = TMP_DIR

const {
  deleteHook,
  dispatchHooks,
  upsertHook,
} = await import('../server/services/hooksService.js')
const {
  releaseApproval,
  requestApproval,
  revalidateHookAuthorization,
} = await import('../server/services/approvalGate.js')
const {
  decideApproval,
  listPendingApprovals,
} = await import('../server/services/approvalStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const previousShellEnabled = process.env.HOOKS_SHELL_ENABLED
const previousAllowedCommands = process.env.HOOKS_SHELL_ALLOWED_COMMANDS
process.env.HOOKS_SHELL_ENABLED = '1'
process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath

function allowCommand(reason = 'scoped allow') {
  return [
    process.execPath,
    '-e',
    `process.stdout.write(JSON.stringify({ allow: true, permissionDecision: "allow", reason: ${JSON.stringify(reason)} }))`,
  ]
}

function hookInput(overrides = {}) {
  return {
    userId: 'hook-auth-user',
    event: 'pre_tool_use',
    toolPattern: 'write_file',
    kind: 'shell',
    command: allowCommand(),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
    ...overrides,
  }
}

const scope = Object.freeze({
  userId: 'hook-auth-user',
  origin: 'job',
  jobId: 'hook-auth-job',
  stepId: 'hook-auth-step',
  sessionId: 'hook-auth-session',
  requestId: 'hook-auth-request',
  toolCallId: 'hook-auth-call',
  toolName: 'write_file',
})
const args = Object.freeze({ path: 'scoped.txt', content: 'trusted' })
let hookInvocationSequence = 0

function nextHookInvocationId(label) {
  hookInvocationSequence += 1
  return `${label}:${hookInvocationSequence}`
}

async function issueAuthorization() {
  const result = await dispatchHooks({
    ...scope,
    event: 'pre_tool_use',
    tool: scope.toolName,
    args,
    hookInvocationId: nextHookInvocationId('hook-auth-issue'),
  })
  assert.equal(result.allow, true)
  assert.equal(result.permissionDecision, 'allow')
  assert.ok(result.hookAuthorizationProvenance)
  return result.hookAuthorizationProvenance
}

async function waitForPendingApproval(userId, { tries = 200 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const [approval] = listPendingApprovals({ userId, status: 'pending' })
    if (approval) return approval
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for pending approval')
}

test.after(() => {
  if (previousShellEnabled == null) delete process.env.HOOKS_SHELL_ENABLED
  else process.env.HOOKS_SHELL_ENABLED = previousShellEnabled
  if (previousAllowedCommands == null) delete process.env.HOOKS_SHELL_ALLOWED_COMMANDS
  else process.env.HOOKS_SHELL_ALLOWED_COMMANDS = previousAllowedCommands
  closeDb()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

test('live Hook authorization is exact-call scoped and serialized copies are checkpoint-only', async () => {
  upsertHook(hookInput())
  const provenance = await issueAuthorization()

  const live = revalidateHookAuthorization({ provenance, ...scope, args, requireLive: true })
  assert.equal(live.proceed, true)

  const serialized = structuredClone(provenance)
  const rejectedLiveCopy = revalidateHookAuthorization({
    provenance: serialized,
    ...scope,
    args,
    requireLive: true,
  })
  assert.equal(rejectedLiveCopy.proceed, false)
  assert.equal(rejectedLiveCopy.code, 'hook_authorization_provenance_not_live')

  const checkpoint = revalidateHookAuthorization({
    provenance: serialized,
    ...scope,
    args,
    requireLive: false,
  })
  assert.equal(checkpoint.proceed, true)

  const mismatches = [
    { userId: 'other-user' },
    { origin: 'chat' },
    { jobId: 'other-job' },
    { stepId: 'other-step' },
    { sessionId: 'other-session' },
    { requestId: 'other-request' },
    { toolCallId: 'other-call' },
    { toolName: 'bash_exec' },
  ]
  for (const mismatch of mismatches) {
    const result = revalidateHookAuthorization({
      provenance: serialized,
      ...scope,
      ...mismatch,
      args,
      requireLive: false,
    })
    assert.equal(result.proceed, false)
    assert.equal(result.code, 'hook_authorization_scope_mismatch')
  }
  const changedArgs = revalidateHookAuthorization({
    provenance: serialized,
    ...scope,
    args: { ...args, content: 'changed' },
    requireLive: false,
  })
  assert.equal(changedArgs.proceed, false)
  assert.equal(changedArgs.code, 'hook_authorization_args_mismatch')
})

test('live Hook allow cannot bypass run_code per-call human approval', async () => {
  const session = issueTestSession({
    email: `hook-run-code-${process.pid}@example.com`,
  })
  const jobId = `hook-run-code-job-${process.pid}`
  const stepId = `hook-run-code-step-${process.pid}`
  const requestId = `hook-run-code-request-${process.pid}`
  const toolCallId = `hook-run-code-call-${process.pid}`
  const codeArgs = Object.freeze({
    code: 'return 6 * 7',
    description: 'Calculate an answer in the isolated code-mode worker',
  })
  createJob({
    id: jobId,
    userId: session.userId,
    title: 'Hook run_code approval regression',
    prompt: 'test',
  })
  const hook = upsertHook(hookInput({
    userId: session.userId,
    toolPattern: 'run_code',
  }))
  const preHook = await dispatchHooks({
    userId: session.userId,
    origin: 'job',
    jobId,
    stepId,
    sessionId: null,
    requestId,
    toolCallId,
    event: 'pre_tool_use',
    tool: 'run_code',
    args: codeArgs,
    hookInvocationId: nextHookInvocationId('hook-run-code-issue'),
  })
  assert.equal(preHook.allow, true)
  assert.equal(preHook.permissionDecision, 'allow')
  assert.ok(preHook.hookAuthorizationProvenance)

  const pending = requestApproval({
    userId: session.userId,
    origin: 'job',
    jobId,
    stepId,
    sessionId: null,
    requestId,
    toolCallId,
    toolName: 'run_code',
    args: codeArgs,
    mode: 'unattended',
    hookAuthorizationProvenance: preHook.hookAuthorizationProvenance,
  })
  const approval = await waitForPendingApproval(session.userId)
  assert.equal(approval.toolName, 'run_code')
  assert.equal(approval.risk, 'high')
  assert.deepEqual(approval.args, codeArgs)

  decideApproval({ userId: session.userId, id: approval.id, decision: 'approve' })
  releaseApproval(approval.id)
  const result = await pending
  assert.equal(result.proceed, true)
  assert.equal(result.approvalId, approval.id)
  assert.notEqual(result.hookAuthorized, true)
  deleteHook(session.userId, hook.id)
})

test('checkpoint Hook authorization fails after disable, configuration drift, or deletion', async () => {
  let hook = upsertHook(hookInput({ userId: 'hook-auth-drift-user' }))
  const driftScope = { ...scope, userId: 'hook-auth-drift-user' }
  const issue = async () => {
    const result = await dispatchHooks({
      ...driftScope,
      event: 'pre_tool_use',
      tool: driftScope.toolName,
      args,
      hookInvocationId: nextHookInvocationId('hook-auth-drift-issue'),
    })
    assert.equal(result.permissionDecision, 'allow')
    return structuredClone(result.hookAuthorizationProvenance)
  }

  const disabledProvenance = await issue()
  hook = upsertHook(hookInput({ id: hook.id, userId: driftScope.userId, enabled: false }))
  const disabled = revalidateHookAuthorization({
    provenance: disabledProvenance,
    ...driftScope,
    args,
    requireLive: false,
  })
  assert.equal(disabled.proceed, false)
  assert.equal(disabled.code, 'hook_authorization_hook_unavailable')

  hook = upsertHook(hookInput({ id: hook.id, userId: driftScope.userId, enabled: true }))
  const driftedProvenance = await issue()
  hook = upsertHook(hookInput({
    id: hook.id,
    userId: driftScope.userId,
    command: allowCommand('changed configuration'),
  }))
  const drifted = revalidateHookAuthorization({
    provenance: driftedProvenance,
    ...driftScope,
    args,
    requireLive: false,
  })
  assert.equal(drifted.proceed, false)
  assert.equal(drifted.code, 'hook_authorization_hook_drift')

  const deletedProvenance = await issue()
  deleteHook(driftScope.userId, hook.id)
  const deleted = revalidateHookAuthorization({
    provenance: deletedProvenance,
    ...driftScope,
    args,
    requireLive: false,
  })
  assert.equal(deleted.proceed, false)
  assert.equal(deleted.code, 'hook_authorization_hook_unavailable')
})

test('missing and tampered Hook authorization provenance fail closed', () => {
  const missing = revalidateHookAuthorization({ ...scope, args, requireLive: false })
  assert.equal(missing.proceed, false)
  assert.equal(missing.code, 'hook_authorization_provenance_missing')
})
