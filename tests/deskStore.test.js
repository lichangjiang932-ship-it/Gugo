/**
 * tests/deskStore.test.js
 *
 * Desk Notes (V14 迁移) CRUD + 排序 + agent 过滤测试。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-desk-'))
}

async function freshModule(dir) {
  process.env.APP_DATA_DIR = dir
  const dbMod = await import(`../server/db.js?desk=${Date.now()}_${Math.random()}`)
  const authMod = await import(`../server/adapters/authAccount.js?desk=${Date.now()}_${Math.random()}`)
  const deskMod = await import(`../server/services/deskStore.js?desk=${Date.now()}_${Math.random()}`)
  const agMod = await import(`../server/services/agentStore.js?desk=${Date.now()}_${Math.random()}`)
  return { dbMod, authMod, deskMod, agMod }
}

async function makeUser(dir, email = 'desk@example.com') {
  const { authMod } = await freshModule(dir)
  const issued = authMod.issueEmailCode({ email })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  return login.user.id
}

test('deskStore: create / get / list / update / delete', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'crud.desk@example.com')
  const { deskMod } = await freshModule(dir)

  const a = deskMod.createDeskNote({ userId, title: '提醒', body: '买牛奶' })
  assert.ok(a.id.startsWith('note_'))
  assert.equal(a.title, '提醒')
  assert.equal(a.body, '买牛奶')
  assert.equal(a.pinned, false)
  assert.equal(a.agentId, null)

  const fetched = deskMod.getDeskNote({ userId, id: a.id })
  assert.equal(fetched.id, a.id)

  const updated = deskMod.updateDeskNote({
    userId,
    id: a.id,
    patch: { title: '提醒2', pinned: true },
  })
  assert.equal(updated.title, '提醒2')
  assert.equal(updated.pinned, true)
  assert.equal(updated.body, '买牛奶') // 未传字段保持

  const list = deskMod.listDeskNotes({ userId })
  assert.equal(list.length, 1)

  const ok = deskMod.deleteDeskNote({ userId, id: a.id })
  assert.equal(ok, true)
  assert.equal(deskMod.getDeskNote({ userId, id: a.id }), null)
})

test('deskStore: pinned 排在前，更新顺序 updated_at desc', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'sort.desk@example.com')
  const { deskMod } = await freshModule(dir)

  const n1 = deskMod.createDeskNote({ userId, title: 'A', now: 1000 })
  const n2 = deskMod.createDeskNote({ userId, title: 'B', now: 2000 })
  const n3 = deskMod.createDeskNote({ userId, title: 'C', pinned: true, now: 1500 })

  const list = deskMod.listDeskNotes({ userId })
  assert.equal(list.length, 3)
  assert.equal(list[0].id, n3.id, 'pinned 排第一')
  assert.equal(list[1].id, n2.id, '未 pinned 中按 updated_at desc')
  assert.equal(list[2].id, n1.id)
})

test('deskStore: agent 过滤 — agentId 与 null（未绑定）分别隔离', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'agent.desk@example.com')
  const { deskMod, agMod } = await freshModule(dir)

  const agent = agMod.createAgent({ userId, name: 'X', soulMd: '## s', identityMd: '## i' })

  deskMod.createDeskNote({ userId, title: 'global1' })
  deskMod.createDeskNote({ userId, title: 'global2' })
  deskMod.createDeskNote({ userId, agentId: agent.id, title: 'agent-x-1' })

  const all = deskMod.listDeskNotes({ userId })
  assert.equal(all.length, 3)

  const unbound = deskMod.listDeskNotes({ userId, agentId: null })
  assert.equal(unbound.length, 2)

  const bound = deskMod.listDeskNotes({ userId, agentId: agent.id })
  assert.equal(bound.length, 1)
  assert.equal(bound[0].title, 'agent-x-1')
})

test('deskStore: 不同用户互不可见', { concurrency: false }, async () => {
  const dir = tmpDir()
  const u1 = await makeUser(dir, 'u1.desk@example.com')
  const u2 = await makeUser(dir, 'u2.desk@example.com')
  const { deskMod } = await freshModule(dir)

  const a = deskMod.createDeskNote({ userId: u1, title: 'u1-only' })
  assert.equal(deskMod.getDeskNote({ userId: u2, id: a.id }), null)
  assert.equal(deskMod.listDeskNotes({ userId: u2 }).length, 0)
  assert.equal(deskMod.deleteDeskNote({ userId: u2, id: a.id }), false)
})
