import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-fs-shell-http-'))
const workspaceRoot = path.join(tempDir, 'workspace')
const grantedDir = path.join(tempDir, 'granted')
const outsideDir = path.join(tempDir, 'outside')
for (const directory of [workspaceRoot, grantedDir, outsideDir]) fs.mkdirSync(directory)

const savedEnv = Object.fromEntries([
  'APP_DB_PATH',
  'AUTH_MODE',
  'SERVER_HOST',
  'LOCAL_CODE_EXECUTION_ENABLED',
  'WORKSPACE_ROOT',
  'WORKSPACE_FS_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
  'WORKSPACE_SHARED_TRUSTED',
].map((key) => [key, process.env[key]]))

process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'
process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
process.env.WORKSPACE_ROOT = workspaceRoot
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, setUserToolPermission } = await import('../server/db.js')
const { grantLocalPath, setAllFilesAccess } = await import('../server/services/localFileAccessService.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function post(endpoint, body, token) {
  return fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  })
}

function grantedUser(email) {
  const session = issueTestSession({ email })
  setApprovalMode({ userId: session.userId, mode: 'normal' })
  grantLocalPath({ userId: session.userId, rootPath: grantedDir, accessMode: 'read_write' })
  return session
}

test('the tool endpoint requires a bearer token and rejects unknown routes', async () => {
  const unauthorized = await post('/api/tools/shell/exec', { command: 'node --version' })
  assert.equal(unauthorized.status, 401)

  const session = grantedUser('fs-shell-http-routing@example.com')
  const unknown = await post('/api/tools/fs/nope', {}, session.token)
  assert.equal(unknown.status, 404)

  const wrongMethod = await fetch(`${origin}/api/tools/shell/exec`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${session.token}` },
  })
  assert.equal(wrongMethod.status, 405)
})

test('shell execution is refused without an authorized directory', async () => {
  const session = issueTestSession({ email: 'fs-shell-http-no-grant@example.com' })
  setApprovalMode({ userId: session.userId, mode: 'normal' })

  const ungranted = await post('/api/tools/shell/exec', {
    command: 'node --version',
    cwd: outsideDir,
  }, session.token)
  assert.equal(ungranted.status, 403)
  assert.equal((await ungranted.json()).code, 'PATH_NOT_AUTHORIZED')

  // All-files access deliberately does not imply shell access: the shell path
  // resolves with allowAllFiles disabled, so the grant is still required.
  setAllFilesAccess({
    userId: session.userId,
    enabled: true,
    confirmation: 'ALLOW_ALL_LOCAL_FILES',
  })
  const allFiles = await post('/api/tools/shell/exec', {
    command: 'node --version',
    cwd: outsideDir,
  }, session.token)
  assert.equal(allFiles.status, 403)
  assert.equal((await allFiles.json()).code, 'PATH_NOT_AUTHORIZED')

  const previousShellEnabled = process.env.WORKSPACE_SHELL_ENABLED
  process.env.WORKSPACE_SHELL_ENABLED = '0'
  try {
    const workspaceShell = await post('/api/tools/shell/exec', {
      command: 'node --version',
      cwd: workspaceRoot,
    }, session.token)
    assert.equal(workspaceShell.status, 403)
    assert.equal((await workspaceShell.json()).code, 'WORKSPACE_SHELL_DISABLED')
  } finally {
    process.env.WORKSPACE_SHELL_ENABLED = previousShellEnabled
  }
})

test('shell execution is refused when local code execution is switched off', async () => {
  const session = grantedUser('fs-shell-http-disabled@example.com')
  const previous = process.env.LOCAL_CODE_EXECUTION_ENABLED
  process.env.LOCAL_CODE_EXECUTION_ENABLED = '0'
  try {
    const response = await post('/api/tools/shell/exec', {
      command: 'node --version',
      cwd: grantedDir,
    }, session.token)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'LOCAL_CODE_EXECUTION_DISABLED')
  } finally {
    process.env.LOCAL_CODE_EXECUTION_ENABLED = previous
  }
})

test('a granted user can run a command and read its file back through the endpoints', async () => {
  const session = grantedUser('fs-shell-http-granted@example.com')

  const shell = await post('/api/tools/shell/exec', {
    command: 'node -e "process.stdout.write(\'endpoint-ok\')"',
    cwd: grantedDir,
  }, session.token)
  assert.equal(shell.status, 200)
  const shellBody = await shell.json()
  assert.equal(shellBody.exitCode, 0)
  assert.match(shellBody.stdout, /endpoint-ok/u)

  const target = path.join(grantedDir, 'written-by-shell.txt')
  const write = await post('/api/tools/shell/exec', {
    command: 'node -e "require(\'fs\').writeFileSync(\'written-by-shell.txt\', \'written through the terminal\\n\')"',
    cwd: grantedDir,
  }, session.token)
  assert.equal(write.status, 200)
  assert.equal((await write.json()).exitCode, 0)

  const read = await post('/api/tools/fs/read', { path: target }, session.token)
  assert.equal(read.status, 200)
  assert.equal((await read.json()).content, 'written through the terminal\n')

  const listed = await post('/api/tools/fs/list', { path: grantedDir }, session.token)
  assert.equal(listed.status, 200)
  assert.match(JSON.stringify(await listed.json()), /written-by-shell\.txt/u)
})

test('writing and editing files have no HTTP route, even for a granted user', async () => {
  const session = grantedUser('fs-shell-http-no-write@example.com')
  const target = path.join(grantedDir, 'must-not-exist.txt')
  fs.writeFileSync(path.join(grantedDir, 'keep.txt'), 'original\n')

  for (const endpoint of [
    '/api/tools/fs/write',
    '/api/tools/fs/edit',
    '/api/tools/fs/write_file',
    '/api/tools/fs/readx',
    '/api/tools/shell/exec/extra',
  ]) {
    const response = await post(endpoint, {
      path: target,
      content: 'must not be written\n',
      command: 'node --version',
      cwd: grantedDir,
    }, session.token)
    assert.equal(response.status, 404, endpoint)
  }
  const edit = await post('/api/tools/fs/edit', {
    path: path.join(grantedDir, 'keep.txt'),
    old_string: 'original',
    new_string: 'changed',
  }, session.token)
  assert.equal(edit.status, 404)
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.readFileSync(path.join(grantedDir, 'keep.txt'), 'utf8'), 'original\n')

  const withQuery = await post('/api/tools/fs/read?x=1', { path: path.join(grantedDir, 'keep.txt') }, session.token)
  assert.equal(withQuery.status, 200)
})

test('the endpoint keeps the per-user tool switch and the grant boundary', async () => {
  const session = grantedUser('fs-shell-http-tool-switch@example.com')
  setUserToolPermission({ userId: session.userId, toolName: 'bash_exec', enabled: false })

  const disabled = await post('/api/tools/shell/exec', {
    command: 'node --version',
    cwd: grantedDir,
  }, session.token)
  assert.equal(disabled.status, 403)
  assert.equal((await disabled.json()).code, 'TOOL_DISABLED')

  setUserToolPermission({ userId: session.userId, toolName: 'bash_exec', enabled: true })
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside the grant\n')
  const outsideRead = await post('/api/tools/fs/read', {
    path: path.join(outsideDir, 'secret.txt'),
  }, session.token)
  assert.equal(outsideRead.ok, false)
  assert.doesNotMatch(await outsideRead.text(), /outside the grant/u)

  const outsideShell = await post('/api/tools/shell/exec', {
    command: 'node --version',
    cwd: outsideDir,
  }, session.token)
  assert.equal(outsideShell.status, 403)
  assert.equal((await outsideShell.json()).code, 'PATH_NOT_AUTHORIZED')
})
