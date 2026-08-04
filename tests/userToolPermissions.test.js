import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-toolperm-tests', String(process.pid))

const {
  getDb,
  createUser,
  setUserToolPermission,
  getUserToolPermissions,
  isToolPermittedForUser,
} = await import('../server/db.js')
const { writeFileTool } = await import('../server/adapters/fsShellTools.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { setWorkspaceTrust } = await import('../server/services/workspaceTrustService.js')

function freshUser(id) {
  return createUser({ id, email: `${id}@example.com` })
}

test.beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM user_tool_permissions').run()
  db.prepare('DELETE FROM users').run()
})

test('tool permission defaults to allowed when no row exists', () => {
  freshUser('u1')
  assert.equal(isToolPermittedForUser('u1', 'bash_exec'), true)
  assert.equal(isToolPermittedForUser('u1', 'write_file'), true)
})

test('explicitly disabling a tool blocks it; re-enabling restores', () => {
  freshUser('u2')
  setUserToolPermission({ userId: 'u2', toolName: 'bash_exec', enabled: false })
  assert.equal(isToolPermittedForUser('u2', 'bash_exec'), false)
  // other tools remain allowed
  assert.equal(isToolPermittedForUser('u2', 'write_file'), true)
  setUserToolPermission({ userId: 'u2', toolName: 'bash_exec', enabled: true })
  assert.equal(isToolPermittedForUser('u2', 'bash_exec'), true)
})

test('getUserToolPermissions returns a map of explicit overrides only', () => {
  freshUser('u3')
  setUserToolPermission({ userId: 'u3', toolName: 'write_file', enabled: false })
  const perms = getUserToolPermissions('u3')
  assert.equal(perms.write_file, false)
  assert.equal('bash_exec' in perms, false, 'only explicit overrides are returned')
})

test('permissions are per-user isolated', () => {
  freshUser('a')
  freshUser('b')
  setUserToolPermission({ userId: 'a', toolName: 'bash_exec', enabled: false })
  assert.equal(isToolPermittedForUser('a', 'bash_exec'), false)
  assert.equal(isToolPermittedForUser('b', 'bash_exec'), true)
})

test('deleting a user cascades their tool permissions', () => {
  freshUser('c')
  setUserToolPermission({ userId: 'c', toolName: 'bash_exec', enabled: false })
  getDb().prepare('DELETE FROM users WHERE id = ?').run('c')
  const rows = getDb().prepare('SELECT * FROM user_tool_permissions WHERE user_id = ?').all('c')
  assert.equal(rows.length, 0)
})

test('backend tool entry rejects a tool disabled by the user (gate, not just UI)', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'toolperm-ws-'))
  const prevRoot = process.env.WORKSPACE_ROOT
  const prevFs = process.env.WORKSPACE_FS_ENABLED
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  try {
    freshUser('gated')
    grantLocalPath({ userId: 'gated', rootPath: workspace, accessMode: 'read_write' })
    setWorkspaceTrust({
      userId: 'gated', rootPath: workspace, trusted: true, confirmation: 'TRUST_WORKSPACE_CONFIG',
    })
    setUserToolPermission({ userId: 'gated', toolName: 'write_file', enabled: false })
    await assert.rejects(
      () => writeFileTool({ path: 'blocked.txt', content: 'x', userId: 'gated' }),
      /权限中心关闭/,
    )
    // a different user (no override) can still write
    freshUser('free')
    grantLocalPath({ userId: 'free', rootPath: workspace, accessMode: 'read_write' })
    setWorkspaceTrust({
      userId: 'free', rootPath: workspace, trusted: true, confirmation: 'TRUST_WORKSPACE_CONFIG',
    })
    const ok = await writeFileTool({ path: 'ok.txt', content: 'y', userId: 'free' })
    assert.equal(ok.ok, true)
  } finally {
    if (prevRoot === undefined) delete process.env.WORKSPACE_ROOT
    else process.env.WORKSPACE_ROOT = prevRoot
    if (prevFs === undefined) delete process.env.WORKSPACE_FS_ENABLED
    else process.env.WORKSPACE_FS_ENABLED = prevFs
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
