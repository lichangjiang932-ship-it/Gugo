import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-pwd-'))
}

async function freshModule(dir) {
  process.env.APP_DATA_DIR = dir
  const dbMod = await import('../server/db.js')
  const authMod = await import(`../server/adapters/billingAuth.js?pwd=${Date.now()}_${Math.random()}`)
  return { dbMod, authMod }
}

test('password lifecycle: set, login, change, remove', async () => {
  const dir = tmpDir()
  let dbMod = null
  try {
    const fresh = await freshModule(dir)
    dbMod = fresh.dbMod
    const { authMod } = fresh
    const { issueEmailCode, verifyEmailCode, setPasswordForUser, loginWithPassword, removePasswordForUser } = authMod

    // 邮箱登录拿到 token
    const issued = issueEmailCode({ email: 'pwd-test@example.com' })
    const login = verifyEmailCode({ email: issued.email, code: issued.devCode })
    assert.equal(login.user.hasPassword, false, '新用户初始无密码')
    const token = login.token

    // 强度校验
    assert.throws(() => setPasswordForUser({ token, newPassword: 'short' }), /至少 8/)
    assert.throws(() => setPasswordForUser({ token, newPassword: 'allletters' }), /字母和数字/)
    assert.throws(() => setPasswordForUser({ token, newPassword: '12345678' }), /字母和数字/)

    // 首次设置无需 currentPassword
    const set = setPasswordForUser({ token, newPassword: 'goodPass123' })
    assert.equal(set.ok, true)
    assert.equal(set.user.hasPassword, true)

    // 密码登录
    const pwdLogin = loginWithPassword({ email: 'pwd-test@example.com', password: 'goodPass123' })
    assert.equal(pwdLogin.ok, true)
    assert.equal(pwdLogin.user.hasPassword, true)
    assert.ok(pwdLogin.token)

    // 错误密码
    assert.throws(() => loginWithPassword({ email: 'pwd-test@example.com', password: 'wrongPass999' }), /邮箱或密码/)
    // 不存在的邮箱也返回相同错误（防枚举）
    assert.throws(() => loginWithPassword({ email: 'noone@example.com', password: 'anything123' }), /邮箱或密码/)

    // 修改密码需要当前密码
    assert.throws(() => setPasswordForUser({ token, newPassword: 'newPass456' }), /当前密码/)
    assert.throws(() => setPasswordForUser({ token, currentPassword: 'wrongPass', newPassword: 'newPass456' }), /当前密码不正确/)
    const change = setPasswordForUser({ token, currentPassword: 'goodPass123', newPassword: 'newPass456' })
    assert.equal(change.ok, true)

    // 新密码生效，旧密码失效
    assert.doesNotThrow(() => loginWithPassword({ email: 'pwd-test@example.com', password: 'newPass456' }))
    assert.throws(() => loginWithPassword({ email: 'pwd-test@example.com', password: 'goodPass123' }), /邮箱或密码/)

    // 移除密码
    assert.throws(() => removePasswordForUser({ token, currentPassword: 'wrong' }), /当前密码不正确/)
    const removed = removePasswordForUser({ token, currentPassword: 'newPass456' })
    assert.equal(removed.user.hasPassword, false)
    assert.throws(() => loginWithPassword({ email: 'pwd-test@example.com', password: 'newPass456' }), /邮箱或密码/)
  } finally {
    try { dbMod?.closeDb() } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.APP_DATA_DIR
  }
})
