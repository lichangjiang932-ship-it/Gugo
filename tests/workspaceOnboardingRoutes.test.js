import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-onboarding-routes-'))
const workspace = path.join(tempDir, 'workspace')
fs.mkdirSync(workspace)

const ENV_KEYS = [
  'APP_DATA_DIR', 'GUGO_LOAD_DOTENV', 'AUTH_MODE', 'SERVER_HOST',
  'WORKSPACE_FS_ENABLED', 'WORKSPACE_SHELL_ENABLED', 'WORKSPACE_GIT_ENABLED',
]
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.APP_DATA_DIR = path.join(tempDir, 'data')
process.env.GUGO_LOAD_DOTENV = '0'
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'
delete process.env.WORKSPACE_FS_ENABLED
delete process.env.WORKSPACE_SHELL_ENABLED
delete process.env.WORKSPACE_GIT_ENABLED

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { requestApproval } = await import('../server/services/approvalGate.js')
const { countPendingApprovals } = await import('../server/services/approvalStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => process.env })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function body(overrides = {}) {
  return {
    path: workspace,
    features: { fileSystem: true, shell: true, git: true },
    approvalMode: 'normal',
    confirmation: 'ENABLE_WORKSPACE_CAPABILITIES',
    ...overrides,
  }
}

test('workspace onboarding requires authentication and explicit risk confirmation', async () => {
  const unauthorized = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
  })
  assert.equal(unauthorized.status, 401)

  const { token } = issueTestSession({ email: 'onboarding-confirm@example.com' })
  const response = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body({ confirmation: undefined })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'CONFIRMATION_REQUIRED')
})

test('bypass approval mode requires a separate confirmation', async () => {
  const { token } = issueTestSession({ email: 'onboarding-bypass@example.com' })
  const response = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body({ approvalMode: 'bypass' })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'BYPASS_CONFIRMATION_REQUIRED')
})

test('one request grants and trusts a directory, enables features, and saves approval mode', async () => {
  const { token, userId } = issueTestSession({ email: 'onboarding-success@example.com' })
  const response = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body({ approvalMode: 'acceptEdits' })),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.onboarding.complete, true)
  assert.equal(result.onboarding.approvalMode, 'acceptEdits')
  assert.equal(result.onboarding.features.fileSystem.enabled, true)
  assert.equal(result.onboarding.features.shell.enabled, true)
  assert.equal(result.onboarding.features.git.enabled, true)
  assert.equal(result.grants.length, 1)
  assert.equal(result.grants[0].accessMode, 'read_write')
  assert.equal(result.trustedWorkspaces[0].trusted, true)

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.APP_DATA_DIR, 'runtime.json'), 'utf8'))
  assert.deepEqual(saved.env, {
    WORKSPACE_FS_ENABLED: '1',
    WORKSPACE_SHELL_ENABLED: '1',
    WORKSPACE_GIT_ENABLED: '1',
    WORKSPACE_GIT_MUTATION_ENABLED: '1',
  })
  assert.ok(saved.onboarding.completedAt > 0)

  const statusResponse = await fetch(`${origin}/api/local-files`, { headers: headers(token) })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.onboarding.complete, true)
  assert.equal(status.onboarding.approvalMode, 'acceptEdits')

  const reversibleEdit = await requestApproval({
    userId,
    origin: 'chat',
    toolName: 'write_file',
    args: { path: 'onboarding-check.txt', content: 'ok' },
    mode: 'off',
  })
  assert.equal(reversibleEdit.proceed, true)

  const destructivePdfEdit = await requestApproval({
    userId,
    origin: 'chat',
    toolName: 'pdf_transform',
    args: { operation: 'fill_form', inputPath: 'form.pdf', outputPath: 'filled.pdf' },
    mode: 'off',
  })
  assert.equal(destructivePdfEdit.proceed, false)
  assert.match(destructivePdfEdit.reason, /审批队列已关闭/)
  assert.equal(countPendingApprovals({ userId }), 0)
})
