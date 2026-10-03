import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
process.env.GUGO_LOAD_DOTENV = '0'
process.env.APP_CONFIG_PATH = join(process.env.APP_DATA_DIR, 'runtime.json')
const permissionTestCwd = process.cwd()
process.chdir(process.env.APP_DATA_DIR)
const { closeDb, createUser } = await import('../server/db.js')
const {
  getApprovalMode, getApprovalModeSnapshot, getApprovalSettings,
  getEffectiveApprovalMode, getEffectiveApprovalSettings, isApprovalBypassEnabled,
  setApprovalMode, withTurnApprovalMode,
} = await import('../server/services/approvalSettingsStore.js')
const {
  getTurnPermissionContextSnapshot, resolveTurnPermissionMode, withTurnPermissionContext,
} = await import('../server/services/turnPermissionContext.js')
const { authorizeApprovalRequest, revalidateToolPermission } = await import('../server/services/approvalGateAuthorization.js')
const { requestApproval, releaseApproval, _resetWaiters } = await import('../server/services/approvalGate.js')
const { decideApproval } = await import('../server/services/approvalStore.js')
const { findAuthorizedDirectoryGrant, getLocalFileAccessStatus } = await import('../server/services/localFileAccessService.js')
const { writeFileTool } = await import('../server/adapters/fsShellTools.js')

const owner = Object.freeze({ userId: 'scope-user', sessionId: 'scope-session', turnId: 'scope-turn' })
const normalAccount = Object.freeze({ mode: 'normal', revision: 1 })
const accountBypass = Object.freeze({ mode: 'bypass', revision: 1 })
const read = (account = normalAccount, userId = owner.userId) => resolveTurnPermissionMode({ userId, account })
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function storedUser() {
  const userId = `turn-permission-${randomUUID()}`
  createUser({ id: userId, email: `${userId}@example.test` })
  return { userId, sessionId: `session-${userId}`, turnId: `turn-${userId}` }
}
const writeArgs = { path: 'fixture.txt', content: 'fixture' }
test.after(() => { _resetWaiters(); closeDb(); process.chdir(permissionTestCwd) })

test('all four explicit modes are owner-bound and concurrent same-user turns do not leak', async () => {
  const barrier = deferred()
  const observed = []
  const running = ['normal', 'acceptEdits', 'plan', 'bypass'].map((permissionMode) => (
    withTurnPermissionContext({ ...owner, turnId: permissionMode, permissionMode, account: normalAccount }, async () => {
      assert.equal(read(), permissionMode)
      assert.equal(read(normalAccount, 'different-owner'), 'normal')
      assert.equal(getTurnPermissionContextSnapshot(owner), null)
      await barrier.promise
      observed.push([permissionMode, read()])
    })
  ))
  assert.equal(read(), 'normal', 'caller outside scopes remains at its account mode')
  barrier.resolve()
  await Promise.all(running)
  assert.ok(observed.every(([requested, effective]) => requested === effective))
  assert.equal(getTurnPermissionContextSnapshot(owner), null)
})

test('explicit normal/plan constrain account bypass and detached descendants fail closed after settlement', async () => {
  for (const permissionMode of ['normal', 'plan', 'bypass']) {
    const barrier = deferred()
    let detached
    await withTurnPermissionContext({ ...owner, permissionMode, account: accountBypass }, async () => {
      assert.equal(read(accountBypass), permissionMode)
      detached = barrier.promise.then(() => read(accountBypass))
    })
    barrier.resolve()
    assert.equal(await detached, 'plan')
    assert.equal(read(accountBypass), 'bypass', 'a genuinely unscoped account read is unchanged')
  }
})

test('exceptions and nested scopes clean up without retaining or expanding authority', async () => {
  await assert.rejects(withTurnPermissionContext({ ...owner, permissionMode: 'bypass', account: normalAccount }, async () => {
    assert.equal(read(), 'bypass')
    await Promise.resolve()
    throw new Error('fixture exception')
  }), /fixture exception/)
  assert.equal(read(), 'normal')
  await withTurnPermissionContext({ ...owner, permissionMode: 'plan', account: normalAccount }, async () => {
    await withTurnPermissionContext({ ...owner, turnId: 'nested', permissionMode: 'bypass', account: normalAccount }, async () => {
      assert.equal(read(), 'plan')
    })
    assert.equal(read(), 'plan')
  })
})

test('invalid modes, owners and accessor-backed restored contexts fail before executing', async () => {
  let executed = 0
  const base = { ...owner, permissionMode: 'bypass', account: normalAccount }
  for (const invalid of [{ permissionMode: 'off' }, { permissionMode: 'bypass ' }, { userId: '' }, { turnId: null }]) {
    await assert.rejects(withTurnPermissionContext({ ...base, ...invalid }, () => { executed += 1 }),
      (error) => error.code === 'TURN_PERMISSION_CONTEXT_INVALID')
  }
  await withTurnPermissionContext(base, async () => {
    const restored = getTurnPermissionContextSnapshot(owner)
    for (const invalid of [{ ...restored, userId: 'foreign' }, Object.create(restored),
      { ...restored, get permissionMode() { throw new Error('must not invoke getter') } }]) {
      await assert.rejects(withTurnPermissionContext({ ...base, restored: invalid }, () => { executed += 1 }),
        (error) => error.code === 'TURN_PERMISSION_CONTEXT_INVALID')
    }
  })
  assert.equal(executed, 0)
})

test('account changes are live and monotonic within a turn, including after checkpoint resume', async () => {
  let restored
  await withTurnPermissionContext({ ...owner, permissionMode: 'bypass', account: normalAccount }, async () => {
    assert.equal(read(), 'bypass')
    restored = getTurnPermissionContextSnapshot(owner)
  })
  await withTurnPermissionContext({ ...owner, permissionMode: 'bypass', checkpointMode: 'bypass',
    account: normalAccount, restored, resuming: true }, async () => {
    assert.equal(read(), 'bypass', 'unchanged account revision preserves the original explicit CLI grant')
    assert.equal(read({ mode: 'plan', revision: 2 }), 'plan')
    assert.equal(read({ mode: 'bypass', revision: 3 }), 'plan', 'account widening cannot resurrect this turn')
  })
  await withTurnPermissionContext({ ...owner, permissionMode: 'bypass', checkpointMode: 'normal',
    account: accountBypass, restored, resuming: true }, async () => assert.equal(read(accountBypass), 'normal'))
  await withTurnPermissionContext({ ...owner, permissionMode: 'bypass', checkpointMode: 'bypass',
    account: { mode: 'plan', revision: 2 }, restored, resuming: true }, async () => assert.equal(read({ mode: 'plan', revision: 2 }), 'plan'))
  await withTurnPermissionContext({ ...owner, permissionMode: 'bypass', checkpointMode: 'bypass',
    account: normalAccount, resuming: true }, async () => assert.equal(read(), 'normal', 'legacy resume is conservative'))
})

test('real approval and execution revalidation share the scoped mode without persisting it', async () => {
  const scope = storedUser()
  const original = getApprovalModeSnapshot(scope)
  await withTurnApprovalMode({ ...scope, permissionMode: 'bypass' }, async () => {
    assert.equal(getApprovalSettings(scope).mode, 'normal')
    assert.equal(getApprovalMode(scope), 'normal')
    assert.equal(getEffectiveApprovalSettings(scope).mode, 'bypass')
    assert.equal(isApprovalBypassEnabled(scope), true)
    assert.equal(authorizeApprovalRequest({ ...scope, origin: 'chat', toolName: 'write_file', args: writeArgs }).gate?.proceed, true)
    assert.equal(revalidateToolPermission({ ...scope, origin: 'chat', toolName: 'write_file', args: writeArgs }).proceed, true)
    assert.equal(revalidateToolPermission({ ...scope, origin: 'chat', toolName: 'run_code', args: { code: 'return 1' } }).proceed, false,
      'mandatory per-call approval remains mandatory in scoped bypass')
  })
  assert.deepEqual(getApprovalModeSnapshot(scope), original)
  assert.equal(getEffectiveApprovalMode(scope), 'normal')
  assert.equal(isApprovalBypassEnabled(scope), false)
})

test('queue modes remain deployment settings and model-like permission arguments cannot establish a scope', async () => {
  const scope = storedUser()
  const before = process.env.APPROVAL_MODE
  process.env.APPROVAL_MODE = 'off'
  try {
    for (const queueValue of ['normal', 'bypass', 'off']) {
      const result = authorizeApprovalRequest({ ...scope, origin: 'chat', toolName: 'write_file',
        args: { ...writeArgs, permissionMode: 'bypass', approvalMode: 'bypass' }, mode: queueValue })
      assert.equal(result.gate?.proceed, false)
      assert.equal(result.gate?.policyDenied, true, `${queueValue} must not replace deployment off with unattended`)
      assert.equal(result.pending, undefined)
    }
    setApprovalMode({ userId: scope.userId, mode: 'bypass' })
    await withTurnApprovalMode({ ...scope, permissionMode: 'normal' }, async () => {
      assert.equal(getApprovalMode(scope), 'bypass')
      assert.equal(authorizeApprovalRequest({ ...scope, origin: 'chat', toolName: 'write_file', args: writeArgs }).gate?.proceed, false)
    })
  } finally {
    if (before === undefined) delete process.env.APPROVAL_MODE
    else process.env.APPROVAL_MODE = before
  }
})

test('a switch to account plan while waiting invalidates the otherwise approved command', async () => {
  const scope = storedUser()
  await withTurnApprovalMode({ ...scope, permissionMode: 'acceptEdits' }, async () => {
    const result = await requestApproval({
      userId: scope.userId, sessionId: scope.sessionId, stepId: scope.turnId, origin: 'chat',
      toolCallId: 'permission-tightening', toolName: 'run_command', args: { command: 'node fixture.cjs' },
      mode: 'unattended',
      onPending: async (approval) => {
        setApprovalMode({ userId: scope.userId, mode: 'plan' })
        decideApproval({ userId: scope.userId, id: approval.id, decision: 'approve' })
        releaseApproval(approval.id)
      },
    })
    assert.equal(result.proceed, false)
    assert.equal(result.permissionMode, 'plan')
    assert.equal(getEffectiveApprovalMode(scope), 'plan')
    assert.equal(revalidateToolPermission({ ...scope, origin: 'chat', toolName: 'write_file', args: writeArgs }).proceed, false)
  })
})

test('local file authority follows scoped permissions, not the account bypass flag', async () => {
  const scope = storedUser()
  const directory = join(process.env.APP_DATA_DIR, 'permission-files')
  mkdirSync(directory, { recursive: true })
  const saved = Object.fromEntries(['WORKSPACE_FS_ENABLED', 'WORKSPACE_SHELL_ENABLED'].map((name) => [name, process.env[name]]))
  process.env.WORKSPACE_FS_ENABLED = '0'
  process.env.WORKSPACE_SHELL_ENABLED = '0'
  try {
    await withTurnApprovalMode({ ...scope, permissionMode: 'bypass' }, async () => {
      assert.equal(getLocalFileAccessStatus(scope).bypassEnabled, true)
      assert.equal(findAuthorizedDirectoryGrant({ ...scope, rawPath: directory, accessMode: 'read_write' })?.source, 'bypass')
      const written = await writeFileTool({ userId: scope.userId, path: join(directory, 'allowed.txt'), content: 'allowed' })
      assert.equal(written.ok, true)
      assert.equal(written.scope, 'bypass')
    })
    setApprovalMode({ userId: scope.userId, mode: 'bypass' })
    for (const permissionMode of ['normal', 'acceptEdits', 'plan']) {
      await withTurnApprovalMode({ ...scope, permissionMode }, async () => {
        assert.equal(getLocalFileAccessStatus(scope).bypassEnabled, false)
        assert.equal(findAuthorizedDirectoryGrant({ ...scope, rawPath: directory, accessMode: 'read_write' }), null)
        await assert.rejects(writeFileTool({ userId: scope.userId, path: join(directory, 'denied.txt'), content: 'denied' }))
      })
    }
    assert.equal(getApprovalMode(scope), 'bypass')
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
