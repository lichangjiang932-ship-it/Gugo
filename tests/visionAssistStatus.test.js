// ★ T3: vision_assist /status 探针 —— 401 / 本地 BYOK 配置 / 启停状态
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-vision-status-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { getDb } = await import('../server/db.js')
const {
  getEnabledIntegrationCredentials,
  upsertIntegration,
} = await import('../server/services/integrationsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

async function withServer(getEnv, fn) {
  const server = createAppServer({ getEnv })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET /api/integrations/vision_assist/status rejects unauthenticated requests with 401', async () => {
  await withServer(() => ({}), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations/vision_assist/status`)
    assert.equal(res.status, 401)
  })
})

test('POST /api/integrations canonicalizes unsupported vision-assist languages', async () => {
  const { token, userId } = issueTestSession()

  await withServer(() => ({}), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'vision_assist',
        name: 'Canonical Vision Copilot',
        enabled: true,
        config: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelName: 'llava',
          language: 'ja',
        },
        secret: {},
      }),
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.integration.config.language, 'en')
    const stored = getDb().prepare(`
      SELECT config_json FROM integrations WHERE user_id = ? AND provider = 'vision_assist'
    `).get(userId)
    assert.equal(JSON.parse(stored.config_json).language, 'en')
  })
})

test('reading legacy vision-assist storage projects a canonical language without mutating it', () => {
  const { userId } = issueTestSession()
  const integration = upsertIntegration({
    userId,
    provider: 'vision_assist',
    name: 'Legacy Vision Copilot',
    enabled: true,
    config: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      modelName: 'llava',
      language: 'zh',
    },
    secret: {},
  })
  const legacyConfig = {
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelName: 'llava',
    language: 'ko',
  }
  getDb().prepare('UPDATE integrations SET config_json = ? WHERE id = ?')
    .run(JSON.stringify(legacyConfig), integration.id)

  const credentials = getEnabledIntegrationCredentials({ userId, provider: 'vision_assist' })
  assert.equal(credentials.config.language, 'en')
  const stored = getDb().prepare('SELECT config_json FROM integrations WHERE id = ?')
    .get(integration.id)
  assert.equal(JSON.parse(stored.config_json).language, 'ko')
})

test('GET /api/integrations/vision_assist/status uses the saved BYOK model without an env whitelist', async () => {
  const { token, userId } = issueTestSession()
  upsertIntegration({
    userId,
    provider: 'vision_assist',
    name: 'Vision Copilot',
    enabled: true,
    config: { baseUrl: 'http://vision.example.com', modelName: 'gpt-4o-vision' },
    secret: { apiKey: 'sk-vision-1' },
  })

  await withServer(() => ({}), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations/vision_assist/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.configured, true)
    assert.equal(body.hasIntegration, true)
    assert.equal(body.enabled, true)
    assert.equal(body.modelName, 'gpt-4o-vision')
    assert.deepEqual(body.models, ['gpt-4o-vision'])
    assert.equal('hasVisionEnv' in body, false)
  })
})

test('GET /api/integrations/vision_assist/status accepts a keyless local endpoint', async () => {
  const { token, userId } = issueTestSession()
  upsertIntegration({
    userId,
    provider: 'vision_assist',
    name: 'Local Vision Copilot',
    enabled: true,
    config: { baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'llava' },
    secret: {},
  })

  await withServer(() => ({}), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations/vision_assist/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.configured, true)
    assert.equal(body.enabled, true)
    assert.equal(body.modelName, 'llava')
  })
})

test('GET /api/integrations/vision_assist/status does not treat a main-model vision whitelist as an assistant', async () => {
  const { token } = issueTestSession()

  await withServer(() => ({ MODEL_NAMES_VISION: 'gpt-4o' }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations/vision_assist/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.configured, false)
    assert.equal(body.hasIntegration, false)
    assert.equal(body.enabled, false)
    assert.equal(body.modelName, null)
    assert.deepEqual(body.models, [])
  })
})

test('GET /api/integrations/vision_assist/status reports a disabled saved integration as unavailable', async () => {
  const { token, userId } = issueTestSession()
  upsertIntegration({
    userId,
    provider: 'vision_assist',
    name: 'Vision Copilot Solo',
    enabled: false,
    config: { baseUrl: 'http://vision.example.com', modelName: 'gpt-4o-vision' },
    secret: { apiKey: 'sk-vision-2' },
  })

  await withServer(() => ({}), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/integrations/vision_assist/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.configured, false)
    assert.equal(body.hasIntegration, true)
    assert.equal(body.enabled, false)
    assert.equal(body.modelName, 'gpt-4o-vision')
    assert.deepEqual(body.models, ['gpt-4o-vision'])
  })
})
