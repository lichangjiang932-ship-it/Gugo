import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-workspace-trust-'))
const workspaceDir = path.join(tempDir, 'workspace')
const configDir = path.join(workspaceDir, '.gugo')
const ancestorWorkspaceDir = path.join(tempDir, 'ancestor-workspace')
const ancestorChildDir = path.join(ancestorWorkspaceDir, 'packages', 'child')
const ancestorConfigDir = path.join(ancestorWorkspaceDir, '.gugo')
const dangerousWorkspaceDir = path.join(tempDir, 'dangerous-workspace')
const dangerousConfigDir = path.join(dangerousWorkspaceDir, '.gugo')
fs.mkdirSync(configDir, { recursive: true })
fs.mkdirSync(ancestorChildDir, { recursive: true })
fs.mkdirSync(ancestorConfigDir, { recursive: true })
fs.mkdirSync(dangerousConfigDir, { recursive: true })
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  permissions: {
    fileSystem: true,
    fileSystemWrite: true,
    shell: false,
    git: true,
    gitMutation: false,
  },
}), 'utf8')
fs.writeFileSync(path.join(ancestorConfigDir, 'config.json'), JSON.stringify({
  permissions: {
    fileSystem: true,
    fileSystemWrite: true,
    shell: false,
    git: true,
    gitMutation: false,
  },
}), 'utf8')
fs.writeFileSync(path.join(dangerousConfigDir, 'config.json'), JSON.stringify({
  permissions: {
    fileSystem: true,
    fileSystemWrite: true,
    shell: true,
    git: true,
    gitMutation: true,
  },
}), 'utf8')

process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.WORKSPACE_ROOT = workspaceDir
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'
process.env.WORKSPACE_GIT_ENABLED = '1'
process.env.WORKSPACE_GIT_MUTATION_ENABLED = '1'

const { closeDb, createUser, DB_SCHEMA_VERSION, getDb } = await import('../server/db.js')
const {
  assertWorkspaceCapability,
  clearSessionWorkspaceTrust,
  getWorkspaceTrustStatus,
  listWorkspaceTrust,
  setWorkspaceTrust,
} = await import('../server/services/workspaceTrustService.js')

createUser({ id: 'trust-user-a', email: 'trust-a@example.com' })
createUser({ id: 'trust-user-b', email: 'trust-b@example.com' })
createUser({ id: 'trust-session-user', email: 'trust-session@example.com' })
createUser({ id: 'trust-session-other', email: 'trust-session-other@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('v32 migration creates a user-scoped workspace trust table', () => {
  const version = getDb().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
  assert.ok(DB_SCHEMA_VERSION >= 32)
  assert.equal(Number(version.value), DB_SCHEMA_VERSION)
  const columns = getDb().prepare('PRAGMA table_info(workspace_trust)').all().map((row) => row.name)
  assert.deepEqual(columns, ['user_id', 'root_path', 'created_at', 'updated_at'])
})

test('untrusted workspaces are read-only and trust is user isolated', () => {
  const beforeA = getWorkspaceTrustStatus({ userId: 'trust-user-a', rootPath: workspaceDir })
  const beforeB = getWorkspaceTrustStatus({ userId: 'trust-user-b', rootPath: workspaceDir })
  assert.equal(beforeA.trusted, false)
  assert.equal(beforeA.config.present, null)
  assert.deepEqual(beforeA.effective, {
    fileSystem: true,
    fileSystemWrite: false,
    shell: false,
    git: false,
    gitMutation: false,
  })
  assert.equal(beforeB.trusted, false)
  assert.doesNotThrow(
    () => assertWorkspaceCapability({ userId: 'trust-user-a', rootPath: workspaceDir, capability: 'fileSystem' }),
  )
  assert.throws(
    () => assertWorkspaceCapability({
      userId: 'trust-user-a',
      rootPath: workspaceDir,
      capability: 'fileSystemWrite',
    }),
    (error) => error.code === 'WORKSPACE_NOT_TRUSTED' && error.source === 'workspace',
  )

  const trusted = setWorkspaceTrust({
    userId: 'trust-user-a',
    rootPath: workspaceDir,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
    now: 100,
  })
  assert.equal(trusted.trusted, true)
  assert.equal(trusted.config.present, true)
  assert.equal(trusted.effective.fileSystem, true)
  assert.equal(trusted.effective.fileSystemWrite, true)
  assert.equal(trusted.effective.shell, false)
  assert.equal(trusted.effective.gitMutation, false)
  assert.equal(getWorkspaceTrustStatus({ userId: 'trust-user-b', rootPath: workspaceDir }).config.present, null)
  assert.equal(listWorkspaceTrust({ userId: 'trust-user-a' }).length, 1)
  assert.equal(listWorkspaceTrust({ userId: 'trust-user-b' }).length, 0)
})

test('canonical roots collapse symlink aliases and config cannot expand global permissions', () => {
  let alias = workspaceDir
  const link = path.join(tempDir, 'workspace-link')
  try {
    fs.symlinkSync(workspaceDir, link, process.platform === 'win32' ? 'junction' : 'dir')
    alias = link
  } catch {
    // Symlink creation can be unavailable in restricted Windows test environments.
  }
  setWorkspaceTrust({
    userId: 'trust-user-a',
    rootPath: alias,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
  })
  assert.equal(listWorkspaceTrust({ userId: 'trust-user-a' }).length, 1)
  assert.equal(listWorkspaceTrust({ userId: 'trust-user-a' })[0].rootPath, fs.realpathSync(workspaceDir))

  const saved = process.env.WORKSPACE_FS_ENABLED
  process.env.WORKSPACE_FS_ENABLED = '0'
  try {
    const status = getWorkspaceTrustStatus({ userId: 'trust-user-a', rootPath: workspaceDir })
    assert.equal(status.config.permissions.fileSystem, true)
    assert.equal(status.global.fileSystem, false)
    assert.equal(status.effective.fileSystem, false)
    assert.equal(status.effective.fileSystemWrite, false)
    assert.throws(
      () => assertWorkspaceCapability({ userId: 'trust-user-a', rootPath: workspaceDir, capability: 'fileSystem' }),
      (error) => error.code === 'WORKSPACE_CAPABILITY_DISABLED' && error.source === 'global',
    )
  } finally {
    process.env.WORKSPACE_FS_ENABLED = saved
  }
})

test('invalid trusted config fails closed and reports the error', () => {
  const configPath = path.join(configDir, 'config.json')
  fs.writeFileSync(configPath, '{ invalid json', 'utf8')
  try {
    const status = getWorkspaceTrustStatus({ userId: 'trust-user-a', rootPath: workspaceDir })
    assert.equal(status.config.present, true)
    assert.equal(status.config.valid, false)
    assert.equal(status.config.error.code, 'WORKSPACE_CONFIG_INVALID')
    assert.deepEqual(status.effective, {
      fileSystem: false,
      fileSystemWrite: false,
      shell: false,
      git: false,
      gitMutation: false,
    })
  } finally {
    fs.writeFileSync(configPath, JSON.stringify({
      permissions: {
        fileSystem: true,
        fileSystemWrite: true,
        shell: false,
        git: true,
        gitMutation: false,
      },
    }), 'utf8')
  }
})

test('session trust is user-scoped, memory-only, and inherited by descendant workspaces', () => {
  const trusted = setWorkspaceTrust({
    userId: 'trust-session-user',
    rootPath: ancestorWorkspaceDir,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
    scope: 'session',
    now: 200,
  })
  assert.equal(trusted.trustScope, 'session')
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM workspace_trust WHERE user_id = ?')
      .get('trust-session-user').count,
    0,
  )

  const child = getWorkspaceTrustStatus({ userId: 'trust-session-user', rootPath: ancestorChildDir })
  assert.equal(child.trusted, true)
  assert.equal(child.inherited, true)
  assert.equal(child.trustScope, 'session')
  assert.equal(child.trustRootPath, fs.realpathSync(ancestorWorkspaceDir))
  assert.equal(child.config.sourceRoot, fs.realpathSync(ancestorWorkspaceDir))
  assert.equal(child.config.loaded, true)
  assert.equal(child.effective.fileSystemWrite, true)
  assert.equal(child.effective.shell, false)
  assert.equal(
    getWorkspaceTrustStatus({ userId: 'trust-session-other', rootPath: ancestorChildDir }).trusted,
    false,
  )
  assert.equal(listWorkspaceTrust({ userId: 'trust-session-user' })[0].trustScope, 'session')

  assert.equal(clearSessionWorkspaceTrust({ userId: 'trust-session-user' }), true)
  assert.equal(
    getWorkspaceTrustStatus({ userId: 'trust-session-user', rootPath: ancestorChildDir }).trusted,
    false,
  )
})

test('dangerous workspace config is never read before trust and is reported as fail-closed', () => {
  const configPath = fs.realpathSync(path.join(dangerousConfigDir, 'config.json'))
  const originalReadFileSync = fs.readFileSync
  let configReads = 0
  fs.readFileSync = function guardedReadFileSync(filePath, ...args) {
    if (path.resolve(String(filePath)) === configPath) configReads += 1
    return originalReadFileSync.call(this, filePath, ...args)
  }
  try {
    const status = getWorkspaceTrustStatus({
      userId: 'trust-session-other',
      rootPath: dangerousWorkspaceDir,
      env: {
        WORKSPACE_FS_ENABLED: '1',
        WORKSPACE_SHELL_ENABLED: '1',
        WORKSPACE_GIT_ENABLED: '1',
        WORKSPACE_GIT_MUTATION_ENABLED: '1',
      },
    })
    assert.equal(configReads, 0)
    assert.equal(status.trusted, false)
    assert.equal(status.config.loaded, false)
    assert.equal(status.config.blocked, true)
    assert.match(status.config.warning, /not loaded.*not trusted/i)
    assert.equal(status.effective.fileSystem, true)
    assert.equal(status.effective.fileSystemWrite, false)
    assert.equal(status.effective.shell, false)
    assert.equal(status.effective.git, false)
    assert.equal(status.effective.gitMutation, false)
  } finally {
    fs.readFileSync = originalReadFileSync
  }
})

test('untrust takes effect immediately', () => {
  assert.equal(setWorkspaceTrust({ userId: 'trust-user-b', rootPath: workspaceDir, trusted: false }), false)
  assert.equal(setWorkspaceTrust({ userId: 'trust-user-a', rootPath: workspaceDir, trusted: false }), true)
  const status = getWorkspaceTrustStatus({ userId: 'trust-user-a', rootPath: workspaceDir })
  assert.equal(status.trusted, false)
  assert.equal(status.config.present, null)
  assert.equal(status.effective.fileSystem, true)
  assert.equal(status.effective.fileSystemWrite, false)
  assert.equal(status.effective.shell, false)
})
