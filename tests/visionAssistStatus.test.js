// ★ T3: vision_assist /status 探针 —— 401 / 本地 BYOK 配置 / 启停状态
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-vision-status-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { upsertIntegration } = await import('../server/services/integrationsStore.js')
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
