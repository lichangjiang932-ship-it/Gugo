/**
 * tests/agentStore.test.js
 *
 * Agent 人格管理 CRUD 测试。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 每个 test 都在改 process.env.APP_DATA_DIR + 重新 import 模块，
// node:test 同文件 top-level test 默认串行。
// 每个 test 用不同 email 避免 user 串载。

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-agent-'))
}

async function freshModule(dir) {
  process.env.APP_DATA_DIR = dir
  const dbMod = await import(`../server/db.js?ag=${Date.now()}_${Math.random()}`)
  const authMod = await import(`../server/adapters/authAccount.js?ag=${Date.now()}_${Math.random()}`)
  const agMod = await import(`../server/services/agentStore.js?ag=${Date.now()}_${Math.random()}`)
  return { dbMod, authMod, agMod }
}

async function makeUser(dir, email = 'a@example.com') {
  const { authMod } = await freshModule(dir)
  const issued = authMod.issueEmailCode({ email })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  return login.user.id
}

test('agentStore: create / get / list / update / delete', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'crud@example.com')
  const { agMod } = await freshModule(dir)

  const a = agMod.createAgent({ userId, name: 'Sage', soulMd: '## soul', identityMd: '## id', isDefault: true })
  assert.ok(a.id.startsWith('agt_'))
  assert.equal(a.name, 'Sage')
  assert.equal(a.isDefault, true)
  assert.equal(a.soulMd, '## soul')

  const got = agMod.getAgent({ userId, id: a.id })
  assert.equal(got.id, a.id)

  const def = agMod.getDefaultAgent({ userId })
  assert.equal(def.id, a.id)

  const list = agMod.listAgents({ userId })
  assert.equal(list.length, 1)

  const upd = agMod.updateAgent({ userId, id: a.id, patch: { name: 'Sage v2', soulMd: 'new soul' } })
  assert.equal(upd.name, 'Sage v2')
  assert.equal(upd.soulMd, 'new soul')

  const removed = agMod.deleteAgent({ userId, id: a.id })
  assert.equal(removed, true)
  assert.equal(agMod.getAgent({ userId, id: a.id }), null)
})

test('agentStore: 用户间隔离', { concurrency: false }, async () => {
  const dir = tmpDir()
  const u1 = await makeUser(dir, 'u1@example.com')
  const u2 = await makeUser(dir, 'u2@example.com')
  const { agMod } = await freshModule(dir)

  agMod.createAgent({ userId: u1, name: 'Mine' })
  assert.equal(agMod.listAgents({ userId: u2 }).length, 0)
  assert.equal(agMod.getAgent({ userId: u2, id: agMod.listAgents({ userId: u1 })[0].id }), null)
})

test('agentStore: 同 user 同名拒绝、isDefault 互斥', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'dup@example.com')
  const { agMod } = await freshModule(dir)

  agMod.createAgent({ userId, name: 'A', isDefault: true })
  assert.throws(() => agMod.createAgent({ userId, name: 'A' }), /已存在同名/)

  const b = agMod.createAgent({ userId, name: 'B', isDefault: true })
  const list = agMod.listAgents({ userId })
  const defaults = list.filter(x => x.isDefault)
  assert.equal(defaults.length, 1, '同时只能有一个 default')
  assert.equal(defaults[0].id, b.id)
})

test('agentStore: ensureDefaultAgent 幂等', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'ensure@example.com')
  const { agMod } = await freshModule(dir)

  const a = agMod.ensureDefaultAgent({ userId })
  assert.equal(a.name, 'Gugo')
  assert.equal(a.isDefault, true)
  assert.equal(a.personaManifest.defaultPermissionMode, 'normal')
  assert.ok(a.soulMd.length > 0)

  const b = agMod.ensureDefaultAgent({ userId })
  assert.equal(b.id, a.id, '第二次应返回同一个 agent')
  assert.equal(agMod.listAgents({ userId }).length, 1)
})

test('agentStore: 输入校验 — 空 name / 超长 md / 非法类型', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'validate@example.com')
  const { agMod } = await freshModule(dir)

  assert.throws(() => agMod.createAgent({ userId, name: '   ' }), /name/)
  assert.throws(() => agMod.createAgent({ userId, name: 'X', soulMd: 'x'.repeat(33000) }), /超长/)
  assert.throws(() => agMod.createAgent({ userId, name: 'Y', soulMd: 123 }), /字符串/)
})

test('agentStore: 删除不存在的 / 跨用户删除', { concurrency: false }, async () => {
  const dir = tmpDir()
  const u1 = await makeUser(dir, 'd1@example.com')
  const u2 = await makeUser(dir, 'd2@example.com')
  const { agMod } = await freshModule(dir)

  const a = agMod.createAgent({ userId: u1, name: 'Only' })
  assert.equal(agMod.deleteAgent({ userId: u2, id: a.id }), false, 'u2 不能删 u1 的 agent')
  assert.equal(agMod.deleteAgent({ userId: u1, id: 'not_exist' }), false)
  assert.ok(agMod.getAgent({ userId: u1, id: a.id }), 'u1 的 agent 应仍在')
})
