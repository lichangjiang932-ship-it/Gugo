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
  'WORKSPACE_GIT_MUTATION_ENABLED',
]
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.APP_DATA_DIR = path.join(tempDir, 'data')
process.env.GUGO_LOAD_DOTENV = '0'
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'
delete process.env.WORKSPACE_FS_ENABLED
delete process.env.WORKSPACE_SHELL_ENABLED
delete process.env.WORKSPACE_GIT_ENABLED
delete process.env.WORKSPACE_GIT_MUTATION_ENABLED

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { requestApproval } = await import('../server/services/approvalGate.js')
const { countPendingApprovals } = await import('../server/services/approvalStore.js')
const { ensureDefaultLocalWorkspace } = await import('../server/services/workspaceOnboardingService.js')

const server = createAppServer({ getEnv: () => process.env, runtimeCwd: workspace })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const localBootstrapResponse = await fetch(`${origin}/api/auth/bootstrap`, { method: 'POST' })
const localOwner = await localBootstrapResponse.json()

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

test('a fresh local owner never auto-authorizes a filesystem root', () => {
  assert.throws(
    () => ensureDefaultLocalWorkspace({
      userId: localOwner.user.id,
      cwd: path.parse(workspace).root,
      env: process.env,
      authorizeLocalOwner: () => true,
    }),
    (error) => error?.code === 'DEFAULT_WORKSPACE_ROOT_FORBIDDEN',
  )
})

test('local owner starts with the current folder configured without an onboarding step', async () => {
  assert.equal(localBootstrapResponse.status, 200)
  assert.equal(localOwner.mode, 'local')
  assert.equal(localOwner.authenticated, true)

  const response = await fetch(`${origin}/api/local-files`, {
    headers: headers(localOwner.token),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.onboarding.complete, true)
  assert.equal(result.onboarding.approvalMode, 'normal')
  assert.deepEqual(result.onboarding.features, {
    fileSystem: { enabled: true, locked: false, source: 'user_config' },
    shell: { enabled: true, locked: false, source: 'user_config' },
    git: { enabled: true, locked: false, source: 'user_config' },
  })
  assert.equal(result.onboarding.writableDirectories.length, 1)
  assert.equal(fs.realpathSync(result.onboarding.writableDirectories[0].path), fs.realpathSync(workspace))
  assert.equal(fs.realpathSync(result.defaultWorkspacePath), fs.realpathSync(workspace))
  assert.equal(result.trustedWorkspaces.length, 1)
  assert.equal(result.trustedWorkspaces[0].trusted, true)
})

test('workspace onboarding requires authentication and explicit risk confirmation', async () => {
  const unauthorized = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
  })
  assert.equal(unauthorized.status, 401)

  const response = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(localOwner.token),
    body: JSON.stringify(body({ confirmation: undefined })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'CONFIRMATION_REQUIRED')
})

test('bypass approval mode requires a separate confirmation', async () => {
  const response = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(localOwner.token),
    body: JSON.stringify(body({ approvalMode: 'bypass' })),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'BYPASS_CONFIRMATION_REQUIRED')
})

test('one request grants and trusts a directory, enables features, and saves approval mode', async () => {
  const { token } = localOwner
  const userId = localOwner.user.id
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

test('an existing workspace choice is not replaced after the current-folder grant is revoked', async () => {
  const alternativeWorkspace = path.join(tempDir, 'alternative-workspace')
  fs.mkdirSync(alternativeWorkspace)

  const configuredResponse = await fetch(`${origin}/api/local-files/onboarding`, {
    method: 'POST',
    headers: headers(localOwner.token),
    body: JSON.stringify(body({ path: alternativeWorkspace })),
  })
  assert.equal(configuredResponse.status, 200)
  const configured = await configuredResponse.json()
  const currentGrant = configured.grants.find((grant) => (
    fs.realpathSync(grant.path) === fs.realpathSync(workspace)
  ))
  assert.ok(currentGrant)

  const revokeResponse = await fetch(`${origin}/api/local-files/grants/${encodeURIComponent(currentGrant.id)}`, {
    method: 'DELETE',
    headers: headers(localOwner.token),
  })
  assert.equal(revokeResponse.status, 200)

  const statusResponse = await fetch(`${origin}/api/local-files`, {
    headers: headers(localOwner.token),
  })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.grants.some((grant) => (
    fs.realpathSync(grant.path) === fs.realpathSync(workspace)
  )), false)
  assert.equal(fs.realpathSync(status.defaultWorkspacePath), fs.realpathSync(alternativeWorkspace))

  const rootLaunchStatus = ensureDefaultLocalWorkspace({
    userId: localOwner.user.id,
    cwd: path.parse(workspace).root,
    env: process.env,
    authorizeLocalOwner: () => true,
  })
  assert.equal(
    fs.realpathSync(rootLaunchStatus.defaultWorkspacePath),
    fs.realpathSync(alternativeWorkspace),
  )
})
