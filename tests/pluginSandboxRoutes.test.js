import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-plugin-sandbox-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const { _resetForTests, initPlugins } = await import('../server/plugins/pluginRegistry.js')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const localEnv = Object.freeze({ AUTH_MODE: 'local' })
initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => localEnv })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function localOwnerToken() {
  return bootstrapAuth({ env: localEnv }).token
}

async function runSandboxWithApproval(url, { token, input }) {
  const request = (approvalDigest = '') => fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(approvalDigest
        ? { 'X-Gugo-Plugin-Permission-Approval': approvalDigest }
        : {}),
    },
    body: JSON.stringify({ input }),
  })
  const challengeResponse = await request()
  assert.equal(challengeResponse.status, 409)
  const challengeBody = await challengeResponse.json()
  assert.equal(challengeBody.error.code, 'PLUGIN_PERMISSION_APPROVAL_REQUIRED')
  const approvalDigest = challengeBody.error.details?.permissionApproval?.approvalDigest
  assert.match(approvalDigest, /^sha256-[a-f0-9]{64}$/)
  return request(approvalDigest)
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
  const token = localOwnerToken()
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
  const token = localOwnerToken()
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
  const token = localOwnerToken()
  await withServer(async (base) => {
    const res = await runSandboxWithApproval(
      `${base}/api/plugins/example-transformer-upper/run-sandbox`, {
        token,
        input: 'abc',
      },
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.output, 'ABC')
    assert.ok(body.durationMs > 0)
  })
})

test('POST /api/plugins/:id/run-sandbox input 超 64KB 返回 400', async () => {
  const token = localOwnerToken()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-transformer-upper/run-sandbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'x'.repeat(64 * 1024 + 1) }),
    })
    assert.equal(res.status, 400)
  })
})

test('POST /api/plugins/:id/run-sandbox 拒绝加载后被篡改的 integrity 入口', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-integrity-route-'))
  const pluginDir = path.join(root, 'integrity-route-transformer')
  const source = "function transform(input) { return 'verified:' + input }"
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'entry.js'), source)
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'integrity-route-transformer',
    name: 'Integrity Route Transformer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    integrity: `sha256-${createHash('sha256').update(source).digest('hex')}`,
  }))
  try {
    _resetForTests()
    const loaded = initPlugins({ rootDir: root, silent: true })
    assert.equal(loaded.errors.length, 0)
    fs.writeFileSync(path.join(pluginDir, 'entry.js'), "function transform(input) { return 'tampered:' + input }")
    const token = localOwnerToken()
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/plugins/integrity-route-transformer/run-sandbox`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'abc' }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.error.code, 'PLUGIN_INTEGRITY_MISMATCH')
    })
  } finally {
    _resetForTests()
    initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
