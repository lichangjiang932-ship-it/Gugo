import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-plugin-sandbox-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { initPlugins } = await import('../server/plugins/pluginRegistry.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('POST /api/plugins/:id/run-sandbox 未登录返回 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-transformer-upper/run-sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'abc' }),
    })
    assert.equal(res.status, 401)
  })
})

test('POST /api/plugins/:id/run-sandbox plugin 不存在返回 404', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/no-such/run-sandbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'abc' }),
    })
    assert.equal(res.status, 404)
  })
})

test('POST /api/plugins/:id/run-sandbox 非 transformer 返回 400', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-warm-ppt-theme/run-sandbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'abc' }),
    })
    assert.equal(res.status, 400)
  })
})

test('POST /api/plugins/:id/run-sandbox example-transformer-upper 执行成功', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-transformer-upper/run-sandbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'abc' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.output, 'ABC')
    assert.ok(body.durationMs > 0)
  })
})

test('POST /api/plugins/:id/run-sandbox input 超 64KB 返回 400', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-transformer-upper/run-sandbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(64 * 1024 + 1) }),
    })
    assert.equal(res.status, 400)
  })
})
