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
fs.mkdirSync(grantedDir)
fs.mkdirSync(outsideDir)
fs.mkdirSync(executionRepo)
fs.writeFileSync(path.join(grantedDir, 'note.txt'), 'hello local files', 'utf8')
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside', 'utf8')
fs.writeFileSync(path.join(executionRepo, 'tracked.txt'), 'repo file', 'utf8')
execFileSync('git', ['init'], { cwd: executionRepo, stdio: 'ignore' })
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
delete process.env.WORKSPACE_FS_ENABLED

const { closeDb, createUser } = await import('../server/db.js')
const {
  getLocalFileAccessStatus,
  grantLocalPath,
  revokeLocalPath,
  setAllFilesAccess,
} = await import('../server/services/localFileAccessService.js')
const { bashExecTool, editFileTool, listDirectoryTool, readFileTool, writeFileTool } = await import('../server/adapters/fsShellTools.js')
const { dispatchGitTool } = await import('../server/adapters/gitWorkbench.js')
const { applyPatchTool } = await import('../server/utils/applyPatch.js')

createUser({ id: 'local-user-a', email: 'local-a@example.com' })
createUser({ id: 'local-user-b', email: 'local-b@example.com' })
createUser({ id: 'execution-user', email: 'execution@example.com' })

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
  grantLocalPath({ userId: 'execution-user', rootPath: executionRepo, accessMode: 'read_only' })

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
      /未获得读取授权/
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
