import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-plugin-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { initPlugins } = await import('../server/plugins/pluginRegistry.js')

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
initPlugins({ rootDir: path.join(repoRoot, 'plugins'), silent: true })

// appServer 启动会走 bootstrap → initPlugins，使用仓库根的 plugins/
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

test('GET /api/plugins/example-warm-ppt-theme 返回详情 + entry 预览', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/example-warm-ppt-theme`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.plugin.id, 'example-warm-ppt-theme')
    assert.equal(body.plugin.type, 'ppt-theme')
    assert.equal(body.plugin.entry, 'theme.json')
    assert.ok(body.entryPreview)
    assert.ok(typeof body.entryPreview.content === 'string')
    assert.ok(body.entryPreview.content.includes('Warm Business'))
    assert.equal(body.entryPreview.truncated, false)
  })
})

test('GET /api/plugins/no-such 返回 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins/no-such`)
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.ok(body.error)
  })
})

test('POST /api/plugins 被拒绝 (只读)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plugins`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 405)
  })
})
