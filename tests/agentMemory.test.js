import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-agentmem-'))
  return d
}

test('阶段 6: memory agent_id 过滤 — agent 专属 vs 全局', async () => {
  process.env.APP_DATA_DIR = tmpDir()
  const auth = await import(`../server/adapters/billingAuth.js?am=${Date.now()}`)
  const issued = auth.issueEmailCode({ email: 'agentmem@example.com' })
  const u = auth.verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id

  const ag = await import(`../server/services/agentStore.js?am=${Date.now()}`)
  const a1 = ag.ensureDefaultAgent({ userId: u })
  const a2 = ag.createAgent({ userId: u, name: 'Sharp', soulMd: 'be sharp', identityMd: '- Name: Sharp', isDefault: false })

  const mem = await import(`../server/services/memoryStore.js?am=${Date.now()}`)
  // 三条记忆：全局 / a1 专属 / a2 专属
  mem.upsertMemory({ userId: u, type: 'user', title: 'global', body: 'global mem' })
  mem.upsertMemory({ userId: u, type: 'user', title: 'for-a1', body: 'a1 mem', agentId: a1.id })
  mem.upsertMemory({ userId: u, type: 'user', title: 'for-a2', body: 'a2 mem', agentId: a2.id })

  // 注入 a1 → 看到 global + a1 (不能看到 a2)
  const picked1 = mem.selectActiveMemoriesForInjection({ userId: u, agentId: a1.id })
  const titles1 = picked1.memories.map((m) => m.title).sort()
  assert.deepStrictEqual(titles1, ['for-a1', 'global'])

  // 注入 a2 → 看到 global + a2
  const picked2 = mem.selectActiveMemoriesForInjection({ userId: u, agentId: a2.id })
  const titles2 = picked2.memories.map((m) => m.title).sort()
  assert.deepStrictEqual(titles2, ['for-a2', 'global'])

  // 不传 agentId → 只看到 global
  const pickedNone = mem.selectActiveMemoriesForInjection({ userId: u })
  const titlesN = pickedNone.memories.map((m) => m.title)
  assert.deepStrictEqual(titlesN, ['global'])
})

test('阶段 6: DB schema v6 migration 干净，memories.agent_id 列存在', async () => {
  process.env.APP_DATA_DIR = tmpDir()
  const dbMod = await import(`../server/db.js?am=${Date.now()}`)
  const db = dbMod.getDb()
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name)
  assert.ok(cols.includes('agent_id'), 'memories.agent_id 必须存在')
  const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
  assert.equal(Number(ver.value), 6)
})

test('阶段 6: 删除 agent 后其记忆 agent_id SET NULL → 退回全局', async () => {
  process.env.APP_DATA_DIR = tmpDir()
  const auth = await import(`../server/adapters/billingAuth.js?am2=${Date.now()}`)
  const issued = auth.issueEmailCode({ email: 'agentmem2@example.com' })
  const u = auth.verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id

  const ag = await import(`../server/services/agentStore.js?am2=${Date.now()}`)
  const a = ag.createAgent({ userId: u, name: 'Throwaway', soulMd: 's', identityMd: 'i', isDefault: false })

  const mem = await import(`../server/services/memoryStore.js?am2=${Date.now()}`)
  const m = mem.upsertMemory({ userId: u, type: 'user', title: 'bound', body: 'b', agentId: a.id })
  assert.equal(m.agentId, a.id)

  ag.deleteAgent({ userId: u, id: a.id })

  // 重新拉 memory：agentId 应为 null（不再绑定）
  const after = mem.getMemory(u, m.id)
  assert.equal(after.agentId, null, '删 agent 后 memory.agentId 应 SET NULL')
})
