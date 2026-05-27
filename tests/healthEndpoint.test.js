import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'

test('GET /api/health returns slim anonymous status without fingerprints', async () => {
  // 用最小 env 启动 — 模型未配置时仍能返回 503 + JSON,而不是 200/纯文本
  const prevEnv = { ...process.env }
  delete process.env.MODEL_BASE_URL
  delete process.env.MODEL_API_KEY
  delete process.env.MODEL_NAME

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    const body = await res.json()

    // 模型未配置 → 503,但响应体一定是结构化 JSON
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
    assert.equal(typeof body.version, 'string', 'version 必须是字符串')
    assert.ok(body.version.length > 0, 'version 不能为空')
    assert.equal(typeof body.time, 'number')
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'time', 'version'])
    assert.equal(body.db, undefined)
    assert.equal(body.model, undefined)
    assert.equal(body.uptimeSec, undefined)

    // 模型未配置时,overall ok=false 且 status=503
    assert.equal(body.ok, false)
    assert.equal(res.status, 503)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    process.env = prevEnv
  }
})

test('GET /api/health/full requires authentication', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/full`)
    assert.equal(res.status, 401)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
