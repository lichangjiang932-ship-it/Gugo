import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-local-file-access-'))
const grantedDir = path.join(tempDir, 'granted')
const outsideDir = path.join(tempDir, 'outside')
const executionRepo = path.join(tempDir, 'execution-repo')
const workspaceDir = path.join(tempDir, 'workspace')
const grantLookupDir = path.join(tempDir, 'grant-lookup')
const grantLookupChildDir = path.join(grantLookupDir, 'nested', 'output')
fs.mkdirSync(grantedDir)
fs.mkdirSync(outsideDir)
fs.mkdirSync(executionRepo)
fs.mkdirSync(workspaceDir)
fs.mkdirSync(grantLookupChildDir, { recursive: true })
fs.writeFileSync(path.join(grantedDir, 'note.txt'), 'hello local files', 'utf8')
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside', 'utf8')
fs.writeFileSync(path.join(executionRepo, 'tracked.txt'), 'repo file', 'utf8')
fs.writeFileSync(path.join(executionRepo, 'check.js'), "console.log('authorized-check-ok')\n", 'utf8')
fs.writeFileSync(path.join(executionRepo, 'package.json'), JSON.stringify({
  scripts: { test: 'node check.js' },
}), 'utf8')
fs.writeFileSync(path.join(workspaceDir, 'workspace.txt'), 'workspace file', 'utf8')
execFileSync('git', ['init'], { cwd: executionRepo, stdio: 'ignore' })
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.WORKSPACE_FS_ENABLED = '1'

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  browseLocalDirectories,
  clearSessionLocalFileGrants,
  createManagedProjectDirectory,
  findAuthorizedDirectoryGrant,
  getLocalFileAccessStatus,
  grantLocalPath,
  resolveDirectoryRequestPath,
  resolveTurnProjectDirectory,
  revokeLocalPath,
  setAllFilesAccess,
  setDefaultOutputDirectory,
} = await import('../server/services/localFileAccessService.js')
const { getWorkspaceTrustStatus, setWorkspaceTrust } = await import('../server/services/workspaceTrustService.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { bashExecTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } = await import('../server/adapters/fsShellTools.js')
const { dispatchGitTool } = await import('../server/adapters/gitWorkbench.js')
const { applyPatchTool } = await import('../server/utils/applyPatch.js')

createUser({ id: 'local-user-a', email: 'local-a@example.com' })
createUser({ id: 'local-user-b', email: 'local-b@example.com' })
createUser({ id: 'execution-user', email: 'execution@example.com' })
createUser({ id: 'readonly-execution-user', email: 'readonly-execution@example.com' })
createUser({ id: 'workspace-user-a', email: 'workspace-a@example.com' })
createUser({ id: 'workspace-user-b', email: 'workspace-b@example.com' })
createUser({ id: 'grant-lookup-user', email: 'grant-lookup@example.com' })
createUser({ id: 'file-grant-user', email: 'file-grant@example.com' })
createUser({ id: 'all-files-grant-user', email: 'all-files-grant@example.com' })
createUser({ id: 'default-output-user', email: 'default-output@example.com' })
createUser({ id: 'session-grant-user', email: 'session-grant@example.com' })
createUser({ id: 'managed-project-user', email: 'managed-project@example.com' })
createUser({ id: 'managed-project-other-user', email: 'managed-project-other@example.com' })
createUser({ id: 'managed-project-configured-user', email: 'managed-project-configured@example.com' })

for (const userId of [
  'local-user-a',
  'local-user-b',
  'execution-user',
  'readonly-execution-user',
  'workspace-user-a',
  'workspace-user-b',
  'grant-lookup-user',
  'file-grant-user',
  'all-files-grant-user',
  'default-output-user',
  'session-grant-user',
  'managed-project-user',
  'managed-project-other-user',
  'managed-project-configured-user',
]) {
  setApprovalMode({ userId, mode: 'normal' })
}

setWorkspaceTrust({
  userId: 'local-user-a',
  rootPath: grantedDir,
  trusted: true,
  confirmation: 'TRUST_WORKSPACE_CONFIG',
})
setWorkspaceTrust({
  userId: 'execution-user',
  rootPath: executionRepo,
  trusted: true,
  confirmation: 'TRUST_WORKSPACE_CONFIG',
})
setWorkspaceTrust({
  userId: 'readonly-execution-user',
  rootPath: executionRepo,
  trusted: true,
  confirmation: 'TRUST_WORKSPACE_CONFIG',
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('local file grants are user-scoped and default to no access', async () => {
  assert.deepEqual(getLocalFileAccessStatus({ userId: 'local-user-a' }).grants, [])
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )

  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_only' })
  const read = await readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') })
  assert.equal(read.content, 'hello local files')
  assert.equal(read.scope, 'grant')

  const listing = await listDirectoryTool({ userId: 'local-user-a', path: grantedDir })
  assert.equal(listing.entries.some((entry) => entry.name === 'note.txt'), true)
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-b', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )
})

test('session-only directory grants stay in memory, cover descendants, and disappear with the process session', async () => {
  const grant = grantLocalPath({
    userId: 'session-grant-user',
    rootPath: grantedDir,
    accessMode: 'read_only',
    scope: 'session',
    now: 123,
  })
  assert.equal(grant.scope, 'session')
  assert.match(grant.id, /^session:/)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM local_file_grants WHERE user_id = ?').get('session-grant-user').count,
    0,
  )
  assert.equal(
    findAuthorizedDirectoryGrant({
      userId: 'session-grant-user',
      rawPath: path.join(grantedDir, 'nested', 'future.txt'),
      accessMode: 'read_only',
    })?.scope,
    'session',
  )
  assert.equal((await readFileTool({
    userId: 'session-grant-user',
    path: path.join(grantedDir, 'note.txt'),
  })).content, 'hello local files')

  assert.equal(clearSessionLocalFileGrants({ userId: 'session-grant-user' }), true)
  assert.deepEqual(getLocalFileAccessStatus({ userId: 'session-grant-user' }).grants, [])
  await assert.rejects(
    () => readFileTool({ userId: 'session-grant-user', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/,
  )
})

test('default output directory strips paired quotes, creates missing folders, and persists', () => {
  const missingDirectory = path.join(tempDir, 'default-output', 'nested')
  const quotedDirectory = `"${missingDirectory}"`

  assert.equal(resolveDirectoryRequestPath({
    userId: 'default-output-user',
    rawPath: quotedDirectory,
  }), path.resolve(missingDirectory))

  const saved = setDefaultOutputDirectory({
    userId: 'default-output-user',
    rootPath: quotedDirectory,
  })
  const canonicalDirectory = fs.realpathSync(missingDirectory)
  assert.equal(fs.statSync(canonicalDirectory).isDirectory(), true)
  assert.equal(saved.defaultOutputDirectory, canonicalDirectory)
  assert.equal(
    getLocalFileAccessStatus({ userId: 'default-output-user' }).defaultOutputDirectory,
    canonicalDirectory,
  )

  const browsed = browseLocalDirectories({
    userId: 'default-output-user',
    rawPath: `'${missingDirectory}'`,
  })
  assert.equal(browsed.currentPath, canonicalDirectory)
})

test('managed projects create unique user-isolated, writable and trusted Turn workspaces', () => {
  const previousAppDataDir = process.env.APP_DATA_DIR
  const managedDataRoot = path.join(tempDir, 'managed-project-data')
  process.env.APP_DATA_DIR = managedDataRoot
  try {
    const first = createManagedProjectDirectory({
      userId: 'managed-project-user',
      name: '..\\..\\CON:* 产品官网',
    })
    const second = createManagedProjectDirectory({
      userId: 'managed-project-user',
      name: '..\\..\\CON:* 产品官网',
    })

    assert.equal(path.isAbsolute(first.path), true)
    assert.equal(fs.realpathSync(first.path), first.path)
    assert.equal(fs.statSync(first.path).isDirectory(), true)
    assert.notEqual(first.path, second.path)
    const relative = path.relative(fs.realpathSync(managedDataRoot), first.path)
    assert.equal(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false)
    assert.doesNotMatch(path.basename(first.path), /[<>:"/\\|?*]/)

    const trust = getWorkspaceTrustStatus({
      userId: 'managed-project-user',
      rootPath: first.path,
    })
    assert.equal(trust.trusted, true)
    assert.equal(trust.trustScope, 'persistent')
    assert.equal(resolveTurnProjectDirectory({
      userId: 'managed-project-user',
      workspacePath: first.path,
    }).projectDirectory, first.path)
    assert.throws(
      () => resolveTurnProjectDirectory({
        userId: 'managed-project-other-user',
        workspacePath: first.path,
      }),
      (error) => error?.code === 'TURN_WORKSPACE_NOT_AUTHORIZED',
    )

    const configuredRoot = path.join(tempDir, 'configured-project-output')
    setDefaultOutputDirectory({
      userId: 'managed-project-configured-user',
      rootPath: configuredRoot,
    })
    const configured = createManagedProjectDirectory({
      userId: 'managed-project-configured-user',
      name: 'Configured project',
    })
    const configuredRelative = path.relative(fs.realpathSync(configuredRoot), configured.path)
    assert.equal(configuredRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configuredRelative), false)
    assert.match(configuredRelative, /^Gugo Projects[\\/]/)
  } finally {
    if (previousAppDataDir === undefined) delete process.env.APP_DATA_DIR
    else process.env.APP_DATA_DIR = previousAppDataDir
  }
})

test('directory input recognizes quoted Windows drive and UNC absolute paths', {
  skip: process.platform !== 'win32',
}, () => {
  const driveDirectory = path.join(tempDir, 'quoted-drive-output')
  const uncDirectory = '\\\\server\\share\\generated'

  assert.equal(resolveDirectoryRequestPath({
    userId: 'default-output-user',
    rawPath: `  "${driveDirectory}"  `,
  }), path.resolve(driveDirectory))
  assert.equal(resolveDirectoryRequestPath({
    userId: 'default-output-user',
    rawPath: `"${uncDirectory}"`,
  }), path.normalize(uncDirectory))
})

test('read-only grants block writes and can be upgraded to read-write', async () => {
  await assert.rejects(
    () => writeFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'new.txt'), content: 'new' }),
    /未获得写入授权/
  )
  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_write' })
  assert.deepEqual(
    fs.readdirSync(grantedDir).filter((name) => name.startsWith('.gugo-write-probe-')),
    [],
    '读写探测不应留下临时文件',
  )
  await writeFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'new.txt'), content: 'new' })
  await editFileTool({
    userId: 'local-user-a',
    path: path.join(grantedDir, 'new.txt'),
    old_string: 'new',
    new_string: 'updated',
  })
  assert.equal(fs.readFileSync(path.join(grantedDir, 'new.txt'), 'utf8'), 'updated')
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') }),
    /未获得读取授权/
  )
})

test('explicit per-user grants work without the global filesystem switch', async () => {
  // 修复：用户显式授权的本地路径是独立信任边界，不应被全局 WORKSPACE_FS_ENABLED
  // 开关短路——授权本身就是用户的明确同意（本地文件授权 UI 可见且可审计）。
  const saved = process.env.WORKSPACE_FS_ENABLED
  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_only' })
  process.env.WORKSPACE_FS_ENABLED = '0'
  try {
    const read = await readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') })
    assert.equal(read.ok, true)
    assert.equal(read.scope, 'grant')
    assert.equal(read.content, 'hello local files')
    // 未授权路径依旧完全拒绝（安全边界不变）
    await assert.rejects(
      () => readFileTool({ userId: 'local-user-b', path: path.join(grantedDir, 'note.txt') }),
      /未获得读取授权/,
    )
  } finally {
    process.env.WORKSPACE_FS_ENABLED = saved
  }
})

test('shared workspace requires a per-user grant unless explicitly trusted', async () => {
  const saved = {
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
    WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
  }
  process.env.WORKSPACE_ROOT = workspaceDir
  process.env.WORKSPACE_FS_ENABLED = '1'
  delete process.env.WORKSPACE_SHARED_TRUSTED
  grantLocalPath({ userId: 'workspace-user-a', rootPath: workspaceDir, accessMode: 'read_only' })

  try {
    const authorized = await readFileTool({ userId: 'workspace-user-a', path: 'workspace.txt' })
    assert.equal(authorized.scope, 'grant')
    await assert.rejects(
      () => readFileTool({ userId: 'workspace-user-b', path: 'workspace.txt' }),
      (error) => {
        assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
        assert.equal(error.requiredAccessMode, 'read_only')
        return true
      },
    )
    assert.equal(getLocalFileAccessStatus({ userId: 'workspace-user-b' }).workspace.requiresUserGrant, true)

    process.env.WORKSPACE_SHARED_TRUSTED = '1'
    const shared = await readFileTool({ userId: 'workspace-user-b', path: 'workspace.txt' })
    assert.equal(shared.scope, 'workspace')
    assert.equal(getLocalFileAccessStatus({ userId: 'workspace-user-b' }).workspace.sharedTrusted, true)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('unauthorized path errors declare the least access mode required', async () => {
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-b', path: path.join(outsideDir, 'secret.txt') }),
    (error) => {
      assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
      assert.equal(error.requiredAccessMode, 'read_only')
      assert.equal(error.path, fs.realpathSync(path.join(outsideDir, 'secret.txt')))
      assert.equal(error.suggestGrantPath, fs.realpathSync(outsideDir))
      return true
    },
  )

  await assert.rejects(
    () => writeFileTool({ userId: 'local-user-b', path: path.join(outsideDir, 'new.txt'), content: 'new' }),
    (error) => {
      assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
      assert.equal(error.requiredAccessMode, 'read_write')
      assert.equal(error.suggestGrantPath, fs.realpathSync(outsideDir))
      return true
    },
  )
})

test('apply_patch uses the same read-write grant as file tools outside WORKSPACE_ROOT', async () => {
  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_write' })
  const target = path.join(grantedDir, 'note.txt')
  const result = await applyPatchTool({
    userId: 'local-user-a',
    patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-hello local files\n+patched through grant\n*** End Patch`,
  })

  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'patched through grant')
  assert.equal(result.changes[0].path, fs.realpathSync(target))
})

test('authorized directories work as shell cwd and git repository roots', async () => {
  const saved = {
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
    WORKSPACE_GIT_ENABLED: process.env.WORKSPACE_GIT_ENABLED,
  }
  process.env.WORKSPACE_ROOT = outsideDir
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.WORKSPACE_GIT_ENABLED = '1'
  grantLocalPath({ userId: 'execution-user', rootPath: executionRepo, accessMode: 'read_write' })

  try {
    const shell = await bashExecTool({
      userId: 'execution-user',
      cwd: executionRepo,
      command: process.platform === 'win32' ? 'cd' : 'pwd',
    })
    assert.equal(path.resolve(shell.stdout.trim()), fs.realpathSync(executionRepo))
    assert.equal(shell.cwd, fs.realpathSync(executionRepo))

    const status = await dispatchGitTool('git_status', { cwd: executionRepo }, { userId: 'execution-user' })
    assert.equal(status.root, fs.realpathSync(executionRepo))
    assert.equal(status.files.some((file) => file.path === 'tracked.txt'), true)

    await assert.rejects(
      () => bashExecTool({ userId: 'local-user-b', cwd: executionRepo, command: process.platform === 'win32' ? 'cd' : 'pwd' }),
      /未获得写入授权/
    )
    await assert.rejects(
      () => dispatchGitTool('git_status', { cwd: executionRepo }, { userId: 'local-user-b' }),
      /未获得读取授权/
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('directory grant lookup enforces mode, ancestry, and explicit directory scope', () => {
  grantLocalPath({
    userId: 'grant-lookup-user',
    rootPath: grantLookupDir,
    accessMode: 'read_only',
  })
  assert.equal(findAuthorizedDirectoryGrant({
    userId: 'grant-lookup-user',
    rawPath: grantLookupChildDir,
    accessMode: 'read_write',
  }), null)
  assert.equal(findAuthorizedDirectoryGrant({
    userId: 'grant-lookup-user',
    rawPath: grantLookupChildDir,
    accessMode: 'read_only',
  })?.path, fs.realpathSync(grantLookupDir))

  grantLocalPath({
    userId: 'grant-lookup-user',
    rootPath: grantLookupDir,
    accessMode: 'read_write',
  })
  const inherited = findAuthorizedDirectoryGrant({
    userId: 'grant-lookup-user',
    rawPath: grantLookupChildDir,
    accessMode: 'read_write',
  })
  assert.equal(inherited?.resourceType, 'directory')
  assert.equal(inherited?.path, fs.realpathSync(grantLookupDir))

  grantLocalPath({
    userId: 'file-grant-user',
    rootPath: path.join(grantedDir, 'note.txt'),
    accessMode: 'read_write',
  })
  assert.equal(findAuthorizedDirectoryGrant({
    userId: 'file-grant-user',
    rawPath: path.join(grantedDir, 'note.txt'),
    accessMode: 'read_write',
  }), null)

  setAllFilesAccess({
    userId: 'all-files-grant-user',
    enabled: true,
    confirmation: 'ALLOW_ALL_LOCAL_FILES',
  })
  assert.equal(findAuthorizedDirectoryGrant({
    userId: 'all-files-grant-user',
    rawPath: grantLookupChildDir,
    accessMode: 'read_write',
  }), null)
})

test('authorized local directories run project checks while the Git workspace is disabled', async () => {
  const saved = {
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
    WORKSPACE_GIT_ENABLED: process.env.WORKSPACE_GIT_ENABLED,
    LOCAL_CODE_EXECUTION_ENABLED: process.env.LOCAL_CODE_EXECUTION_ENABLED,
  }
  process.env.WORKSPACE_ROOT = outsideDir
  process.env.WORKSPACE_SHELL_ENABLED = '0'
  process.env.WORKSPACE_GIT_ENABLED = '0'
  process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
  grantLocalPath({ userId: 'execution-user', rootPath: executionRepo, accessMode: 'read_write' })

  try {
    const result = await dispatchGitTool(
      'run_project_check',
      { cwd: executionRepo, check: 'test' },
      { userId: 'execution-user' },
    )
    assert.equal(result.ok, true)
    assert.equal(result.check, 'test')
    assert.match(result.stdout, /authorized-check-ok/)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('read-only grants cannot authorize shell, project scripts, or git mutations', async () => {
  const saved = {
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
    WORKSPACE_GIT_ENABLED: process.env.WORKSPACE_GIT_ENABLED,
    WORKSPACE_GIT_MUTATION_ENABLED: process.env.WORKSPACE_GIT_MUTATION_ENABLED,
  }
  process.env.WORKSPACE_ROOT = outsideDir
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.WORKSPACE_GIT_ENABLED = '1'
  process.env.WORKSPACE_GIT_MUTATION_ENABLED = '1'
  grantLocalPath({ userId: 'readonly-execution-user', rootPath: executionRepo, accessMode: 'read_only' })

  const requiresWrite = (error) => {
    assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
    assert.equal(error.requiredAccessMode, 'read_write')
    return true
  }
  try {
    const status = await dispatchGitTool(
      'git_status',
      { cwd: executionRepo },
      { userId: 'readonly-execution-user' },
    )
    assert.equal(status.ok, true)
    await assert.rejects(
      () => bashExecTool({
        userId: 'readonly-execution-user',
        cwd: executionRepo,
        command: process.platform === 'win32' ? 'cd' : 'pwd',
      }),
      requiresWrite,
    )
    await assert.rejects(
      () => dispatchGitTool(
        'run_project_check',
        { cwd: executionRepo, check: 'test' },
        { userId: 'readonly-execution-user' },
      ),
      requiresWrite,
    )
    await assert.rejects(
      () => dispatchGitTool(
        'git_commit',
        { cwd: executionRepo, message: 'test commit', files: ['tracked.txt'] },
        { userId: 'readonly-execution-user' },
      ),
      requiresWrite,
    )
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('revocation is immediate and all-files mode requires explicit confirmation', async () => {
  const grant = getLocalFileAccessStatus({ userId: 'local-user-a' }).grants[0]
  assert.equal(revokeLocalPath({ userId: 'local-user-b', id: grant.id }), false)
  assert.equal(revokeLocalPath({ userId: 'local-user-a', id: grant.id }), true)
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )

  assert.throws(
    () => setAllFilesAccess({ userId: 'local-user-a', enabled: true }),
    /明确确认/
  )
  setAllFilesAccess({ userId: 'local-user-a', enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const read = await readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') })
  assert.equal(read.scope, 'all_files')
  setAllFilesAccess({ userId: 'local-user-a', enabled: false })
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') }),
    /未获得读取授权/
  )
})
