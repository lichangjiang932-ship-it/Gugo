import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-local-file-routes-'))
const allowedDir = path.join(tempDir, 'allowed')
fs.mkdirSync(allowedDir)
fs.writeFileSync(path.join(allowedDir, 'route.txt'), 'route access', 'utf8')
process.env.APP_DATA_DIR = tempDir
const previousFsEnabled = process.env.WORKSPACE_FS_ENABLED
process.env.WORKSPACE_FS_ENABLED = '1'
const previousGitEnabled = process.env.WORKSPACE_GIT_ENABLED
process.env.WORKSPACE_GIT_ENABLED = '1'

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (previousGitEnabled === undefined) delete process.env.WORKSPACE_GIT_ENABLED
  else process.env.WORKSPACE_GIT_ENABLED = previousGitEnabled
  if (previousFsEnabled === undefined) delete process.env.WORKSPACE_FS_ENABLED
  else process.env.WORKSPACE_FS_ENABLED = previousFsEnabled
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('local file access routes require authentication', async () => {
  const response = await fetch(`${origin}/api/local-files`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
})

test('authorized path can be used by file tools and remains user-scoped', async () => {
  const alice = issueTestSession({ email: 'local-route-alice@example.com' })
  const bob = issueTestSession({ email: 'local-route-bob@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  setApprovalMode({ userId: bob.userId, mode: 'normal' })
  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_write' }),
  })
  assert.equal(grantResponse.status, 200)
  const grantBody = await grantResponse.json()
  assert.equal(grantBody.grants.length, 1)

  const readResponse = await fetch(`${origin}/api/tools/fs/read`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: path.join(allowedDir, 'route.txt') }),
  })
  assert.equal(readResponse.status, 200)
  assert.equal((await readResponse.json()).content, 'route access')

  const bobRead = await fetch(`${origin}/api/tools/fs/read`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({ path: path.join(allowedDir, 'route.txt') }),
  })
  assert.equal(bobRead.status, 403)
  const bobReadBody = await bobRead.json()
  assert.equal(bobReadBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobReadBody.requiredAccessMode, 'read_only')
  assert.equal(bobReadBody.path, fs.realpathSync(path.join(allowedDir, 'route.txt')))
  assert.equal(bobReadBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const bobPatch = await fetch(`${origin}/api/tools/code/apply-patch`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({
      patch: `*** Begin Patch\n*** Update File: ${path.join(allowedDir, 'route.txt')}\n@@\n-route access\n+patched route\n*** End Patch`,
      dry_run: true,
    }),
  })
  assert.equal(bobPatch.status, 403)
  const bobPatchBody = await bobPatch.json()
  assert.equal(bobPatchBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobPatchBody.requiredAccessMode, 'read_write')
  assert.equal(bobPatchBody.path, fs.realpathSync(path.join(allowedDir, 'route.txt')))
  assert.equal(bobPatchBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const bobGitStatus = await fetch(`${origin}/api/tools/git/status`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({ cwd: allowedDir }),
  })
  assert.equal(bobGitStatus.status, 403)
  const bobGitBody = await bobGitStatus.json()
  assert.equal(bobGitBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobGitBody.requiredAccessMode, 'read_only')
  assert.equal(bobGitBody.path, fs.realpathSync(allowedDir))
  assert.equal(bobGitBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const removed = await fetch(`${origin}/api/local-files/grants/${grantBody.grants[0].id}`, {
    method: 'DELETE',
    headers: headers(alice.token),
  })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).grants, [])
})

test('all-files route enforces confirmation and method errors are structured', async () => {
  const { token } = issueTestSession({ email: 'local-route-confirm@example.com' })
  const denied = await fetch(`${origin}/api/local-files/all-access`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(denied.status, 400)
  assert.equal((await denied.json()).error.code, 'CONFIRMATION_REQUIRED')

  const enabled = await fetch(`${origin}/api/local-files/all-access`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' }),
  })
  assert.equal(enabled.status, 200)
  assert.equal((await enabled.json()).allFilesEnabled, true)

  const unsupported = await fetch(`${origin}/api/local-files`, {
    method: 'PUT',
    headers: headers(token),
    body: '{}',
  })
  assert.equal(unsupported.status, 405)
  assert.equal((await unsupported.json()).error.code, 'METHOD_NOT_ALLOWED')
})
