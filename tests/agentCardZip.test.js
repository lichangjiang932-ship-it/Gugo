import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-agent-card-zip-'))

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

test('v0.10: zip 携带 avatar.png + skills/<id>/ 完整往返', async () => {
  const { token, userId } = issueTestSession()
  await withServer(async (base) => {
    // 1. 直接装一个 user skill（避开 plugin route 对 initPlugins 的依赖）
    const { installSkill } = await import('../server/services/skillStore.js')
    const skillId = `e2e-card-skill-${Date.now()}-${process.pid}`
    installSkill({
      id: skillId, userId, name: 'CardSk', description: 'card-pkg',
      version: '0.1.0', icon: 'star', permissions: [],
      files: {
        'skill.json': JSON.stringify({ id: skillId, name: 'CardSk', description: 'card-pkg', version: '0.1.0', icon: 'star', permissions: [] }),
        'prompts/system.md': '# CardSk',
      },
    })

    // 2. 建带 data-URL avatar 的 agent
    const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORk5ErkJggg=='
    const dataUrl = `data:image/png;base64,${tinyPngB64}`
    const cRes = await fetch(`${base}/api/agents`, {
      method: 'POST',
      headers: H(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'AvaCard', soulMd: 'I have face', identityMd: '- Avatar: yes', avatarUrl: dataUrl }),
    })
    assert.equal(cRes.status, 200)
    const agentId = (await cRes.json()).agent.id

    // 3. 导 zip
    const eRes = await fetch(`${base}/api/agents/${agentId}/export.zip`, { headers: H(token) })
    assert.equal(eRes.status, 200)
    const buf = Buffer.from(await eRes.arrayBuffer())
    const zip = await JSZip.loadAsync(buf)
    assert.ok(zip.file('avatar.png'), 'zip 应含 avatar.png')
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    assert.equal(manifest.version, '0.3')
    assert.equal(manifest.avatarFile, 'avatar.png')
    assert.ok(Array.isArray(manifest.skills) && manifest.skills.includes(skillId), 'manifest.skills 应含装的 skill')
    assert.ok(zip.file(`skills/${skillId}/skill.json`), 'skills/<id>/skill.json 应存在')

    // 4. 导入到第二个 user, agent + skill 都应入新库
    const { token: t2 } = issueTestSession()
    const iRes = await fetch(`${base}/api/agents/import.zip?overrideName=AvaCardCopy`, {
      method: 'POST', headers: H(t2, { 'Content-Type': 'application/zip' }), body: buf,
    })
    assert.equal(iRes.status, 200)
    const body = await iRes.json()
    assert.equal(body.ok, true)
    assert.ok(body.agent.avatarUrl?.startsWith('data:image/png;base64,'), '导入 agent 应回灌 data-URL avatar')
    assert.ok(body.skillsImported >= 1, 'skillsImported 应 ≥ 1')

    // 5. user2 的 skill 列表里能查到
    const sList = await fetch(`${base}/api/skills`, { headers: H(t2) })
    assert.equal(sList.status, 200)
    const sBody = await sList.json()
    const ids = (sBody.skills || []).map((s) => s.id)
    // dedup 后可能改名, 但至少有一条来自上面装的 e2e-card-skill
    assert.ok(ids.some((id) => id.startsWith('e2e-card-skill-')), `user2 skills 应含 e2e-card-skill-*, got ${ids.join(',')}`)
  })
})

test('v0.10: ?avatar=0 + ?skills=0 抑制对应导出', async () => {
  const { token } = issueTestSession()
  await withServer(async (base) => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORk5ErkJggg=='
    const cRes = await fetch(`${base}/api/agents`, {
      method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'OptSrc', soulMd: 's', avatarUrl: dataUrl }),
    })
    const agentId = (await cRes.json()).agent.id
    const eRes = await fetch(`${base}/api/agents/${agentId}/export.zip?avatar=0&skills=0`, { headers: H(token) })
    const buf = Buffer.from(await eRes.arrayBuffer())
    const zip = await JSZip.loadAsync(buf)
    assert.equal(zip.file('avatar.png'), null)
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
    assert.equal(manifest.avatarFile, null)
    assert.deepEqual(manifest.skills, [])
  })
})
