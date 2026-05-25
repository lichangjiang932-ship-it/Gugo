import test from 'node:test'
import assert from 'node:assert'
import JSZip from 'jszip'
const { createAppServer } = await import('../server/appServer.js')

const { issueTestSession } = await import('./helpers/testAuth.js')

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try { await fn(`http://127.0.0.1:${port}`) }
  finally { await new Promise((r) => server.close(r)) }
}

const H = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra })

test('v0.9: 角色卡 zip 往返 — 导出 zip 含 agent.md/manifest.json/memories/*, 导入新建 agent + 记忆', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    // 1. 建 agent
    const cRes = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: H(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'CardSrc', soulMd: 'I am card', identityMd: '- Name: CardSrc' }),
    })
    assert.equal(cRes.status, 200)
    const agentId = (await cRes.json()).agent.id

    // 2. 给它绑两条记忆 (一条该 agent 专属, 一条全局)
    const upMem = async (payload) => {
      const r = await fetch(`${base}/api/memory/upsert`, {
        method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      })
      assert.equal(r.status, 200, await r.text())
    }
    await upMem({ type: 'user', title: 'card-mem-1', body: 'belongs to card', agentId })
    await upMem({ type: 'project', title: 'card-mem-2', body: 'pinned card mem', pinned: true, agentId })
    await upMem({ type: 'user', title: 'global-mem', body: 'should NOT be in zip' })

    // 3. 导出 zip
    const zipRes = await fetch(`${base}/api/agents/${agentId}/export.zip`, { headers: H(token) })
    assert.equal(zipRes.status, 200)
    assert.equal(zipRes.headers.get('content-type'), 'application/zip')
    const buf = Buffer.from(await zipRes.arrayBuffer())
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file('manifest.json'), 'manifest.json must exist')
    assert.ok(zip.file('agent.md'), 'agent.md must exist')
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    assert.equal(manifest.format, 'yma-agent-card')
    assert.equal(manifest.agent.name, 'CardSrc')

    const memFiles = []
    zip.folder('memories').forEach((rel, f) => { if (!f.dir) memFiles.push(rel) })
    assert.equal(memFiles.length, 2, '只该 agent 专属的 2 条记忆进 zip, 全局不入')

    // 4. 删原 agent (避免撞名)
    await fetch(`${base}/api/agents/${agentId}`, { method: 'DELETE', headers: H(token) })

    // 5. 导入 zip — 用 overrideName 改名避免 import 同进程已存在
    const impRes = await fetch(`${base}/api/agents/import.zip?overrideName=CardImported`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/zip' }),
      body: buf,
    })
    assert.equal(impRes.status, 200)
    const imp = await impRes.json()
    assert.equal(imp.agent.name, 'CardImported')
    assert.equal(imp.memoriesImported, 2)
    assert.match(imp.agent.soulMd, /I am card/)

    // 6. 列新 agent 的记忆 (管理视图过滤)
    const memList = await fetch(`${base}/api/memory/list?agent=${imp.agent.id}`, { headers: H(token) })
    const memData = await memList.json()
    const titles = memData.memories.map((m) => m.title).sort()
    assert.deepStrictEqual(titles, ['card-mem-1', 'card-mem-2'])
  })
})

test('v0.9: import.zip — agent.md 缺失 → 400', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const zip = new JSZip()
    zip.file('random.txt', 'hello')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const r = await fetch(`${base}/api/agents/import.zip`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/zip' }),
      body: buf,
    })
    assert.equal(r.status, 400)
  })
})

test('v0.9: import.zip — 空 body → 400', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/agents/import.zip`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/zip' }),
      body: Buffer.alloc(0),
    })
    assert.equal(r.status, 400)
  })
})

test('v0.9: export.zip?memories=0 → 不带 memories 目录', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const c = await fetch(`${base}/api/agents`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'NoMemCard', soulMd: 'x', identityMd: '- Name: NoMemCard' }),
    })
    const agentId = (await c.json()).agent.id
    await fetch(`${base}/api/memory/upsert`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ type: 'user', title: 'm', body: 'b', agentId }),
    })
    const r = await fetch(`${base}/api/agents/${agentId}/export.zip?memories=0`, { headers: H(token) })
    assert.equal(r.status, 200)
    const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()))
    let memCount = 0
    zip.folder('memories')?.forEach(() => { memCount += 1 })
    assert.equal(memCount, 0)
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    assert.equal(manifest.memoriesIncluded, false)
  })
})
