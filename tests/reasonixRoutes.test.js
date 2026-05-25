import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-reasonix-'))
}

async function freshModule(dir) {
  process.env.APP_DATA_DIR = dir
  const dbMod = await import(`../server/db.js?rx=${Date.now()}_${Math.random()}`)
  const authMod = await import(`../server/billingAuth.js?rx=${Date.now()}_${Math.random()}`)
  const rxMod = await import(`../server/routes/reasonixRoutes.js?rx=${Date.now()}_${Math.random()}`)
  return { dbMod, authMod, rxMod }
}

async function makeUser() {
  const dir = tmpDir()
  const { authMod } = await freshModule(dir)
  const issued = authMod.issueEmailCode({ email: 'rx@example.com' })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  return { dir, userId: login.user.id }
}

test('memory: create / list / update / disable / build prefix', async () => {
  const { dir, userId } = await makeUser()
  try {
    const { rxMod } = await freshModule(dir)
    const m = rxMod.createMemory({ userId, title: '我喜欢喝拿铁', content: '每天必喝一杯' })
    assert.ok(m.id.startsWith('mem_'))
    assert.equal(m.enabled, true)
    assert.ok(m.tokens > 0)

    const list = rxMod.listMemories({ userId })
    assert.equal(list.length, 1)

    const updated = rxMod.updateMemory({ userId, id: m.id, patch: { enabled: false } })
    assert.equal(updated.enabled, false)

    const enabledOnly = rxMod.listMemories({ userId, enabledOnly: true })
    assert.equal(enabledOnly.length, 0)

    rxMod.updateMemory({ userId, id: m.id, patch: { enabled: true } })
    const prefix = rxMod.buildMemoryPrefix({ userId })
    assert.match(prefix, /Pinned Memories/)
    assert.match(prefix, /拿铁/)

    rxMod.deleteMemory({ userId, id: m.id })
    assert.equal(rxMod.listMemories({ userId }).length, 0)

    // 隔离：另一个 user 看不到
    const issued2 = (await freshModule(dir)).authMod.issueEmailCode({ email: 'other@example.com' })
    const other = (await freshModule(dir)).authMod.verifyEmailCode({ email: issued2.email, code: issued2.devCode })
    rxMod.createMemory({ userId, title: 't', content: 'c' })
    assert.equal(rxMod.listMemories({ userId: other.user.id }).length, 0)

    // 强度校验
    assert.throws(() => rxMod.createMemory({ userId, title: 't', content: 'c', kind: 'evil' }), /kind/)
    assert.throws(() => rxMod.createMemory({ userId, title: '', content: 'c' }), /title/)
    assert.throws(() => rxMod.createMemory({ userId, title: 't', content: 'x'.repeat(5000) }), /4000/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.APP_DATA_DIR
  }
})

test('todo: lifecycle + status filter + user isolation', async () => {
  const { dir, userId } = await makeUser()
  try {
    const { rxMod, authMod } = await freshModule(dir)
    const t1 = rxMod.createTodo({ userId, title: '修 bug', priority: 5 })
    const t2 = rxMod.createTodo({ userId, title: '写文档', priority: 1 })
    assert.equal(rxMod.listTodos({ userId }).length, 2)
    // 按 priority 排序
    const sorted = rxMod.listTodos({ userId, status: 'pending' })
    assert.equal(sorted[0].id, t1.id)

    const done = rxMod.updateTodo({ userId, id: t1.id, patch: { status: 'done' } })
    assert.equal(done.status, 'done')
    assert.ok(done.completedAt > 0)

    assert.equal(rxMod.listTodos({ userId, status: 'done' }).length, 1)
    assert.equal(rxMod.listTodos({ userId, status: 'pending' }).length, 1)

    assert.throws(() => rxMod.updateTodo({ userId, id: t2.id, patch: { status: 'bogus' } }), /status/)

    // 隔离
    const issued = authMod.issueEmailCode({ email: 'b@x.com' })
    const other = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
    assert.equal(rxMod.listTodos({ userId: other.user.id }).length, 0)
    assert.throws(() => rxMod.updateTodo({ userId: other.user.id, id: t1.id, patch: { status: 'done' } }), /不存在/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.APP_DATA_DIR
  }
})

test('effort: default medium + switch levels', async () => {
  const { dir, userId } = await makeUser()
  try {
    const { rxMod } = await freshModule(dir)
    const def = rxMod.getEffortSetting({ userId })
    assert.equal(def.effort, 'medium')
    assert.equal(def.maxSteps, 12)
    assert.ok(def.presets.high)

    const high = rxMod.setEffortSetting({ userId, effort: 'high' })
    assert.equal(high.effort, 'high')
    assert.equal(high.maxSteps, 24)

    assert.throws(() => rxMod.setEffortSetting({ userId, effort: 'evil' }), /effort/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.APP_DATA_DIR
  }
})

test('session meter: bump and cache hit rate', async () => {
  const { dir, userId } = await makeUser()
  try {
    const { rxMod } = await freshModule(dir)
    const m1 = rxMod.bumpSessionMeter({ userId, sessionId: 's1', tokensIn: 1000, tokensOut: 200, tokensCached: 800, costCredits: 5 })
    assert.equal(m1.turns, 1)
    assert.equal(m1.tokensIn, 1000)
    assert.ok(Math.abs(m1.cacheHitRate - 800 / 1200) < 0.001)

    const m2 = rxMod.bumpSessionMeter({ userId, sessionId: 's1', tokensIn: 500, tokensOut: 100, tokensCached: 480, costCredits: 2 })
    assert.equal(m2.turns, 2)
    assert.equal(m2.tokensIn, 1500)
    assert.equal(m2.costCredits, 7)

    const recents = rxMod.listRecentMeters({ userId })
    assert.equal(recents.length, 1)
    assert.equal(recents[0].sessionId, 's1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.APP_DATA_DIR
  }
})
