import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-plugin-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const {
  _resetForTests,
  initPlugins,
  registerPlugin,
  unregisterPlugin,
} = await import('../server/plugins/pluginRegistry.js')

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })

// appServer 启动会走 bootstrap → initPlugins，使用仓库根的 plugins/
async function withServer(fn, env = {}) {
  const server = createAppServer({ getEnv: () => env })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('GET /api/plugins 列出 2 个示例 plugin', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.plugins))
    assert.ok(body.plugins.length >= 2)
    const ids = body.plugins.map((p) => p.id)
    assert.ok(ids.includes('example-warm-ppt-theme'))
    assert.ok(ids.includes('example-greeting-prompt'))
    // 不应泄漏绝对路径
    assert.ok(!('rootDir' in body.plugins[0]))
    assert.ok(!('entryPath' in body.plugins[0]))
  })
})

test('GET /api/plugins?type=ppt-theme 过滤', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins?type=ppt-theme`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.plugins.every((p) => p.type === 'ppt-theme'))
    assert.ok(body.plugins.some((p) => p.id === 'example-warm-ppt-theme'))
  })
})

test('GET /api/plugins/:id 未登录不泄漏 entry 预览', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-warm-ppt-theme`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error.code, 'UNAUTHORIZED')
    assert.equal('entryPreview' in body, false)
  })
})

test('GET /api/plugins/example-warm-ppt-theme 本地 owner 返回详情 + entry 预览', async () => {
  const env = { AUTH_MODE: 'local' }
  const { token } = bootstrapAuth({ env })
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-warm-ppt-theme`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.plugin.id, 'example-warm-ppt-theme')
    assert.equal(body.plugin.type, 'ppt-theme')
    assert.equal(body.plugin.entry, 'theme.json')
    assert.ok(body.entryPreview)
    assert.ok(typeof body.entryPreview.content === 'string')
    assert.ok(body.entryPreview.content.includes('Warm Business'))
    assert.equal(body.entryPreview.truncated, false)
  }, env)
})

test('GET /api/plugins/:id 对 integrity 篡改返回明确的不可信预览错误', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-preview-integrity-'))
  const pluginDir = path.join(root, 'preview-integrity')
  const source = '{"theme":"trusted"}\n'
  fs.mkdirSync(pluginDir)
  fs.writeFileSync(path.join(pluginDir, 'theme.json'), source)
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'preview-integrity',
    name: 'Preview Integrity',
    version: '1.0.0',
    type: 'ppt-theme',
    entry: 'theme.json',
    integrity: `sha256-${createHash('sha256').update(source).digest('hex')}`,
  }))
  _resetForTests()
  const loaded = initPlugins({ rootDir: root, silent: true })
  assert.equal(loaded.plugins.length, 1)
  fs.writeFileSync(path.join(pluginDir, 'theme.json'), '{"theme":"tampered"}\n')

  const env = { AUTH_MODE: 'local' }
  const { token } = bootstrapAuth({ env })
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/plugins/preview-integrity`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.entryPreview.trusted, false)
      assert.equal(body.entryPreview.integrityStatus, 'failed')
      assert.equal(body.entryPreview.error.code, 'PLUGIN_INTEGRITY_MISMATCH')
      assert.match(body.entryPreview.error.message, /不可信/)
      assert.equal('content' in body.entryPreview, false)
    }, env)
  } finally {
    _resetForTests()
    initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('GET /api/plugins/:id 拒绝 multi-user 登录用户且不泄漏 entry 预览', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const { token } = issueTestSession()
  const env = { AUTH_MODE: 'multi_user' }
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-warm-ppt-theme`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error.code, 'LOCAL_OWNER_ONLY')
    assert.equal('entryPreview' in body, false)
  }, env)
})

test('GET /api/plugins/no-such 返回 404', async () => {
  const env = { AUTH_MODE: 'local' }
  const { token } = bootstrapAuth({ env })
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/no-such`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.ok(body.error)
  }, env)
})

test('POST /api/plugins/example-greeting-prompt/install-as-skill 拒绝非 skill-bundle (400)', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-greeting-prompt/install-as-skill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(/类型必须/.test(body.error))
  })
})

test('POST /api/plugins/no-such/install-as-skill 返 404', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/no-such/install-as-skill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 404)
  })
})

test('POST /api/plugins/example-skill-bundle/install-as-skill 未登录 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-skill-bundle/install-as-skill`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})

test('POST /api/plugins/example-skill-bundle/install-as-skill 成功 200', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-skill-bundle/install-as-skill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(body.skill)
    assert.match(body.skill.id, /^example-bundled(-\d+)?$/)
  })
})

test('POST /api/plugins/example-skill-bundle/install-as-skill 重复安装自动衰减 id', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const first = await fetch(`${base}/api/plugins/example-skill-bundle/install-as-skill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.match(firstBody.skill.id, /^example-bundled(-\d+)?$/)
    const second = await fetch(`${base}/api/plugins/example-skill-bundle/install-as-skill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(second.status, 200)
    const secondBody = await second.json()
    assert.notEqual(secondBody.skill.id, firstBody.skill.id)
    assert.match(secondBody.skill.id, /^example-bundled-\d+$/)
  })
})

test('POST runtime config reload uses the startup-owned source instead of request env', async () => {
  const pluginId = `route-config-probe-${process.pid}`
  let setupCalls = 0
  await registerPlugin({
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    requires: [],
    contributes: [],
  }, () => {
    setupCalls += 1
  })
  const env = {
    AUTH_MODE: 'local',
    APP_DATA_DIR: path.join(os.tmpdir(), 'foreign-plugin-config-source', String(process.pid)),
  }
  const { token } = bootstrapAuth({ env })
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/plugins/runtime/${pluginId}/config/reload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.plugin.configRevision, 2)
      assert.equal(setupCalls, 2)
    }, env)
  } finally {
    await unregisterPlugin(pluginId)
  }
})
