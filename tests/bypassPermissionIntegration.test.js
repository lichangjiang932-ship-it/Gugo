import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-bypass-permission-'))
const projectDir = path.join(tempDir, 'project')
const seedPath = path.join(projectDir, 'seed.txt')
fs.mkdirSync(projectDir, { recursive: true })
fs.writeFileSync(seedPath, 'seed', 'utf8')
execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'bypass-test@example.com'], { cwd: projectDir })
execFileSync('git', ['config', 'user.name', 'Bypass Test'], { cwd: projectDir })

const savedEnv = Object.fromEntries([
  'APP_DB_PATH',
  'AUTH_MODE',
  'SERVER_HOST',
  'LOCAL_CODE_EXECUTION_ENABLED',
  'WORKSPACE_ROOT',
  'WORKSPACE_FS_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
  'WORKSPACE_GIT_ENABLED',
  'WORKSPACE_GIT_MUTATION_ENABLED',
].map((key) => [key, process.env[key]]))

process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'
process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
process.env.WORKSPACE_ROOT = projectDir
process.env.WORKSPACE_FS_ENABLED = '0'
process.env.WORKSPACE_SHELL_ENABLED = '0'
process.env.WORKSPACE_GIT_ENABLED = '1'
process.env.WORKSPACE_GIT_MUTATION_ENABLED = '1'

const { closeDb, createUser } = await import('../server/db.js')
const {
  isApprovalBypassEnabled,
  setApprovalMode,
} = await import('../server/services/approvalSettingsStore.js')
const {
  findAuthorizedDirectoryGrant,
  getLocalFileAccessStatus,
} = await import('../server/services/localFileAccessService.js')
const {
  bashExecTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} = await import('../server/adapters/fsShellTools.js')
const { dispatchGitTool } = await import('../server/adapters/gitWorkbench.js')
const { requestDirectoryTool } = await import('../server/utils/agenticTools.js')
const { requestApproval } = await import('../server/services/approvalGate.js')
const { countPendingApprovals } = await import('../server/services/approvalStore.js')

const userId = 'explicit-bypass-user'
createUser({ id: userId, email: 'explicit-bypass@example.com' })

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('explicit bypass runs local file, shell, and git tools without grants or approval rows', async () => {
  setApprovalMode({ userId, mode: 'normal' })
  assert.equal(isApprovalBypassEnabled({ userId }), false)
  assert.equal(getLocalFileAccessStatus({ userId }).bypassEnabled, false)
  setApprovalMode({ userId, mode: 'bypass' })

  const status = getLocalFileAccessStatus({ userId })
  assert.equal(status.bypassEnabled, true)
  assert.equal(status.allFilesEnabled, false)
  assert.deepEqual(status.grants, [])

  const directoryGrant = findAuthorizedDirectoryGrant({
    userId,
    rawPath: projectDir,
    accessMode: 'read_write',
  })
  assert.equal(directoryGrant?.source, 'bypass')
  assert.equal(directoryGrant?.accessMode, 'read_write')

  const directoryRequest = requestDirectoryTool({
    purpose: 'Continue editing the project.',
    access_mode: 'read_write',
    suggested_path: projectDir,
  }, { userId })
  assert.equal(directoryRequest.paused, false)
  assert.equal(directoryRequest.already_authorized, true)

  const read = await readFileTool({ userId, path: seedPath })
  assert.equal(read.scope, 'bypass')
  assert.equal(read.content, 'seed')
  const listing = await listDirectoryTool({ userId, path: projectDir })
  assert.equal(listing.scope, 'bypass')

  const writtenPath = path.join(projectDir, 'bypass-git.txt')
  const write = await writeFileTool({ userId, path: writtenPath, content: 'created in bypass mode\n' })
  assert.equal(write.scope, 'bypass')

  const shellOutput = path.join(projectDir, 'bypass-shell.txt')
  const shell = await bashExecTool({
    userId,
    cwd: projectDir,
    command: 'echo shell-bypass > bypass-shell.txt',
    expected_outputs: [shellOutput],
  })
  assert.equal(shell.ok, true)
  assert.equal(fs.existsSync(shellOutput), true)

  const gitStatus = await dispatchGitTool('git_status', { cwd: projectDir }, { userId })
  assert.equal(gitStatus.ok, true)
  assert.equal(gitStatus.files.some((file) => file.path === 'bypass-git.txt'), true)
  const commit = await dispatchGitTool('git_commit', {
    cwd: projectDir,
    message: 'test bypass commit',
    files: ['bypass-git.txt'],
  }, { userId })
  assert.equal(commit.ok, true)
  assert.match(commit.commit, /^[0-9a-f]{40}$/i)

  for (const [toolName, args] of [
    ['write_file', { path: writtenPath, content: 'updated' }],
    ['bash_exec', { cwd: projectDir, command: 'echo approved' }],
    ['git_commit', { cwd: projectDir, message: 'another commit', files: ['seed.txt'] }],
  ]) {
    const gate = await requestApproval({
      userId,
      origin: 'chat',
      sessionId: 'bypass-test-session',
      toolName,
      args,
      mode: 'all',
    })
    assert.equal(gate.proceed, true, toolName)
  }
  assert.equal(countPendingApprovals({ userId }), 0)
})
