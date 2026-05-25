/**
 * tests/agentRoutes.test.js
 *
 * Agent REST 路由端到端测试。
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-agent-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

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

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('GET /api/agents 未登录返回 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agents`)
    assert.equal(res.status, 401)
  })
})

test('Agent 路由：POST 创建 → GET 列表 → PATCH 更新 → DELETE 删除', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    // 列表初始为空
    let res = await fetch(`${base}/api/agents`, { headers: authHeaders(token) })
    assert.equal(res.status, 200)
    let body = await res.json()
    assert.deepEqual(body.agents, [])

    // 创建
    res = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: 'Routes Test', soulMd: '# soul', identityMd: '# id', isDefault: true }),
    })
    assert.equal(res.status, 200)
    body = await res.json()
    assert.ok(body.agent.id.startsWith('agt_'))
    assert.equal(body.agent.isDefault, true)
    const agentId = body.agent.id

    // GET 列表
    res = await fetch(`${base}/api/agents`, { headers: authHeaders(token) })
    body = await res.json()
    assert.equal(body.agents.length, 1)

    // GET 详情
    res = await fetch(`${base}/api/agents/${agentId}`, { headers: authHeaders(token) })
    assert.equal(res.status, 200)
    body = await res.json()
    assert.equal(body.agent.soulMd, '# soul')

    // PATCH
    res = await fetch(`${base}/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ soulMd: '# soul v2' }),
    })
    assert.equal(res.status, 200)
    body = await res.json()
    assert.equal(body.agent.soulMd, '# soul v2')

    // DELETE
    res = await fetch(`${base}/api/agents/${agentId}`, { method: 'DELETE', headers: authHeaders(token) })
    assert.equal(res.status, 200)
    res = await fetch(`${base}/api/agents/${agentId}`, { headers: authHeaders(token) })
    assert.equal(res.status, 404)
  })
})

test('GET /api/agents/default 首次自动 seed 默认 Atelier', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agents/default`, { headers: authHeaders(token) })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.agent.name, 'Atelier')
    assert.equal(body.agent.isDefault, true)
    assert.match(body.agent.soulMd, /SOUL/)
  })
})

test('Agent 路由：非法 id / 404 / method not allowed', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    let res = await fetch(`${base}/api/agents/not_exist_xyz`, { headers: authHeaders(token) })
    assert.equal(res.status, 404)

    // 创建后试 PUT (不支持)
    const created = await (await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: '_mna_' }),
    })).json()
    res = await fetch(`${base}/api/agents/${created.agent.id}`, { method: 'PUT', headers: authHeaders(token), body: '{}' })
    assert.equal(res.status, 405)
  })
})

test('GET /api/agents/:id/export → text/markdown + 可被 POST /import 还原', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const created = await (await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name: 'ExportMe', soulMd: '## be sharp', identityMd: '- Name: ExportMe' }),
    })).json()

    const exportRes = await fetch(`${base}/api/agents/${created.agent.id}/export`, { headers: authHeaders(token) })
    assert.equal(exportRes.status, 200)
    assert.match(exportRes.headers.get('content-type') || '', /markdown/)
    const text = await exportRes.text()
    assert.match(text, /^---/)
    assert.match(text, /name: "ExportMe"/)
    assert.match(text, /## IDENTITY/)
    assert.match(text, /## SOUL/)
    assert.match(text, /be sharp/)

    // 删原 agent 避免 import 撞名
    await fetch(`${base}/api/agents/${created.agent.id}`, { method: 'DELETE', headers: authHeaders(token) })

    const importRes = await fetch(`${base}/api/agents/import`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ source: text }),
    })
    assert.equal(importRes.status, 200)
    const imported = await importRes.json()
    assert.equal(imported.agent.name, 'ExportMe')
    assert.match(imported.agent.soulMd, /be sharp/)
    assert.match(imported.agent.identityMd, /- Name: ExportMe/)
    assert.equal(imported.agent.isDefault, false, 'import 不应抢默认')
  })
})

test('POST /api/agents/import: 空 source → 400', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agents/import`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ source: '' }),
    })
    assert.equal(res.status, 400)
  })
})

test('POST /api/agents/import: 无 frontmatter 也能 fallback', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agents/import`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ source: '# FallbackName\n\nThis is everything as soul.' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.agent.name, 'FallbackName')
    assert.match(body.agent.soulMd, /everything as soul/)
  })
})

test('POST /api/agents/import: overrideName 撞名重命名', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const source = '---\nname: "DupName"\n---\n# DupName\n\n## SOUL\nx'
    // 首次 import 成功
    const r1 = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ source }),
    })
    assert.equal(r1.status, 200)

    // 再次同 source 撞名 → 400/500
    const r2 = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ source }),
    })
    assert.notEqual(r2.status, 200)

    // 带 overrideName 改名 → 200
    const r3 = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ source, overrideName: 'DupName (copy)' }),
    })
    assert.equal(r3.status, 200)
    const body = await r3.json()
    assert.equal(body.agent.name, 'DupName (copy)')
    // soul/identity 内容来自原 source 不受 override 影响
    assert.match(body.agent.soulMd, /^x/)
  })
})
