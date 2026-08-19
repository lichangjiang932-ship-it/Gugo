import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-config-routes-'))
const dataDir = path.join(tempDir, 'data')
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = dataDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({
  getEnv: () => ({
    APP_DATA_DIR: dataDir,
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
  }),
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('runtime config endpoint requires authentication', async () => {
  const response = await fetch(`${origin}/api/system/runtime-config`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
})

test('web settings opens only the fixed non-secret user runtime config', async () => {
  const configPath = path.join(dataDir, 'runtime.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify({
    env: { WORKSPACE_FS_ENABLED: '1' },
    onboarding: { completedAt: 123 },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(tempDir, '.env'), 'MODEL_API_KEY=must-not-be-returned\n')

  const { token } = issueTestSession({ email: 'runtime-config-open@example.com' })
  const response = await fetch(`${origin}/api/system/runtime-config`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="runtime.json"')
  assert.match(response.headers.get('content-security-policy'), /sandbox/)
  const body = await response.text()
  assert.deepEqual(JSON.parse(body), {
    env: { WORKSPACE_FS_ENABLED: '1' },
    onboarding: { completedAt: 123 },
  })
  assert.doesNotMatch(body, /must-not-be-returned/)
})

test('runtime config endpoint creates a minimal file and rejects write methods', async () => {
  const configPath = path.join(dataDir, 'runtime.json')
  fs.rmSync(configPath, { force: true })
  const { token } = issueTestSession({ email: 'runtime-config-create@example.com' })
  const headers = { Authorization: `Bearer ${token}` }

  const response = await fetch(`${origin}/api/system/runtime-config`, { headers })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { env: {} })
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { env: {} })

  const writeResponse = await fetch(`${origin}/api/system/runtime-config`, {
    method: 'POST',
    headers,
  })
  assert.equal(writeResponse.status, 405)
  assert.equal((await writeResponse.json()).error.code, 'METHOD_NOT_ALLOWED')
})

test('runtime config endpoint rejects sensitive keys anywhere in the document', async () => {
  const configPath = path.join(dataDir, 'runtime.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify({
    env: { WORKSPACE_FS_ENABLED: '1' },
    metadata: { nested: [{ apiKey: 'must-not-be-returned' }] },
  }, null, 2)}\n`)
  const { token } = issueTestSession({ email: 'runtime-config-sensitive@example.com' })

  const response = await fetch(`${origin}/api/system/runtime-config`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 409)
  const body = await response.text()
  assert.equal(JSON.parse(body).error.code, 'SENSITIVE_RUNTIME_CONFIG')
  assert.doesNotMatch(body, /must-not-be-returned/)
})

test('runtime config endpoint ignores path query input and supports HEAD', async () => {
  const configPath = path.join(dataDir, 'runtime.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, '{\n  "env": {}\n}\n')
  const { token } = issueTestSession({ email: 'runtime-config-head@example.com' })
  const headers = { Authorization: `Bearer ${token}` }

  const response = await fetch(
    `${origin}/api/system/runtime-config?path=${encodeURIComponent(path.join(tempDir, '.env'))}`,
    { method: 'HEAD', headers },
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="runtime.json"')
  assert.equal(await response.text(), '')
})

test('runtime config endpoint hides unexpected filesystem and parser details', async () => {
  const configPath = path.join(dataDir, 'runtime.json')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(configPath, '{ invalid json')
  const { token } = issueTestSession({ email: 'runtime-config-invalid@example.com' })

  const response = await fetch(`${origin}/api/system/runtime-config`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  assert.equal(response.status, 500)
  const body = await response.text()
  assert.equal(JSON.parse(body).error.message, '无法打开运行配置')
  assert.doesNotMatch(body, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
})

test('multi-user deployments cannot expose the installation runtime config', async () => {
  const isolatedServer = createAppServer({
    getEnv: () => ({ APP_DATA_DIR: dataDir, AUTH_MODE: 'multi_user' }),
  })
  await new Promise((resolve) => isolatedServer.listen(0, '127.0.0.1', resolve))
  try {
    const { token } = issueTestSession({ email: 'runtime-config-multi-user@example.com' })
    const response = await fetch(
      `http://127.0.0.1:${isolatedServer.address().port}/api/system/runtime-config`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'LOCAL_CONFIG_ONLY')
  } finally {
    await new Promise((resolve) => isolatedServer.close(resolve))
  }
})
