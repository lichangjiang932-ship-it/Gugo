/**
 * tests/mobileAccessKey.test.js
 *
 * Mobile/LAN access key (V14 迁移) 创建 / 校验 / 撤销 / 过期 测试。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-mak-'))
}

async function freshModule(dir) {
  process.env.APP_DATA_DIR = dir
  const dbMod = await import(`../server/db.js?mak=${Date.now()}_${Math.random()}`)
  const authMod = await import(`../server/adapters/billingAuth.js?mak=${Date.now()}_${Math.random()}`)
  const makMod = await import(`../server/services/mobileAccessKeyStore.js?mak=${Date.now()}_${Math.random()}`)
  return { dbMod, authMod, makMod }
}

async function makeUser(dir, email = 'mak@example.com') {
  const { authMod } = await freshModule(dir)
  const issued = authMod.issueEmailCode({ email })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  return login.user.id
}

test('mobileAccessKey: create 返回 rawKey 一次，verify 命中', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'create@mak.example')
  const { makMod } = await freshModule(dir)

  const { record, rawKey } = makMod.createMobileKey({ userId, label: '手机' })
  assert.ok(rawKey.startsWith('ymak_'))
  assert.ok(record.id.startsWith('mak_'))
  assert.equal(record.label, '手机')
  assert.equal(record.revokedAt, null)
  assert.equal(record.lastUsedAt, null)
  assert.equal(record.keyPrefix, rawKey.slice(0, 8))

  const verified = makMod.verifyAccessKey(rawKey)
  assert.ok(verified)
  assert.equal(verified.userId, userId)
  assert.equal(verified.keyId, record.id)

  // verify 后 last_used_at 应更新
  const list = makMod.listMobileKeys({ userId })
  assert.equal(list.length, 1)
  assert.ok(list[0].lastUsedAt > 0)
})

test('mobileAccessKey: revoke 后 verify 失败，但 list 仍可见', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'revoke@mak.example')
  const { makMod } = await freshModule(dir)

  const { record, rawKey } = makMod.createMobileKey({ userId })
  assert.equal(makMod.revokeMobileKey({ userId, id: record.id }), true)
  assert.equal(makMod.verifyAccessKey(rawKey), null)

  // 重复撤销 → false
  assert.equal(makMod.revokeMobileKey({ userId, id: record.id }), false)

  const list = makMod.listMobileKeys({ userId })
  assert.equal(list.length, 1)
  assert.ok(list[0].revokedAt > 0)
})

test('mobileAccessKey: 过期 key verify 失败', { concurrency: false }, async () => {
  const dir = tmpDir()
  const userId = await makeUser(dir, 'expire@mak.example')
  const { makMod } = await freshModule(dir)

  const past = Date.now() - 1000
  const { rawKey } = makMod.createMobileKey({ userId, ttlMs: -10_000, now: past })
  assert.equal(makMod.verifyAccessKey(rawKey), null)
})

test('mobileAccessKey: 错误 key / 空 key 安全拒绝', { concurrency: false }, async () => {
  const dir = tmpDir()
  await makeUser(dir, 'bad@mak.example')
  const { makMod } = await freshModule(dir)

  assert.equal(makMod.verifyAccessKey(''), null)
  assert.equal(makMod.verifyAccessKey('not-a-key'), null)
  assert.equal(makMod.verifyAccessKey(null), null)
  assert.equal(makMod.verifyAccessKey('ymak_' + 'x'.repeat(40)), null)
})

test('mobileAccessKey: 不同用户互不可见', { concurrency: false }, async () => {
  const dir = tmpDir()
  const u1 = await makeUser(dir, 'u1@mak.example')
  const u2 = await makeUser(dir, 'u2@mak.example')
  const { makMod } = await freshModule(dir)

  const { record } = makMod.createMobileKey({ userId: u1 })
  assert.equal(makMod.listMobileKeys({ userId: u2 }).length, 0)
  assert.equal(makMod.revokeMobileKey({ userId: u2, id: record.id }), false)
})
