import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import os from 'node:os'

import {
  buildSendCodeResponse,
  issueEmailCode,
  verifyEmailCode,
  getPublicAccount,
  rechargeAccount,
  estimateChatCost,
  chargeForModelUse,
  chargeForToolUse,
  getBillingDiagnostics,
  getMailDiagnostics,
  loadBillingConfig,
} from '../server/adapters/billingAuth.js'
import { getDb } from '../server/db.js'

// 每个测试进程使用独立数据库目录，避免并行测试冲突
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('email code login creates a reusable user token without exposing the code', () => {
  const issued = issueEmailCode({ email: 'person@example.com', code: '123456' })

  assert.equal(issued.ok, true)
  assert.equal(issued.email, 'person@example.com')
  assert.equal('code' in issued, false)

  const session = verifyEmailCode({ email: 'person@example.com', code: '123456' })

  assert.equal(session.ok, true)
  assert.match(session.token, /^tkn_/)
  assert.equal(session.user.email, 'person@example.com')
  assert.equal(session.user.credits, 0)
})

test('email codes are stored as hashes instead of plaintext', () => {
  issueEmailCode({ email: 'hashed@example.com', code: '123456' })

  const row = getDb().prepare('SELECT code FROM login_codes WHERE email = ?').get('hashed@example.com')
  assert.notEqual(row.code, '123456')
  assert.match(row.code, /^sha256:/)
})

test('send-code response exposes local dev code when smtp is not configured', () => {
  assert.deepEqual(
    buildSendCodeResponse({
      issued: { ok: true, email: 'local@example.com', expiresIn: 600, devCode: '123456' },
      delivery: { sent: false, devCode: '123456' },
      env: {},
    }),
    { ok: true, email: 'local@example.com', expiresIn: 600, devCode: '123456' }
  )

  assert.deepEqual(
    buildSendCodeResponse({
      issued: { ok: true, email: 'mail@example.com', expiresIn: 600, devCode: '654321' },
      delivery: { sent: true },
      env: { AUTH_DEV_CODES: 'false' },
    }),
    { ok: true, email: 'mail@example.com', expiresIn: 600 }
  )
})

test('local recharge packages add credits and write ledger entries', () => {
  const { token } = verifyEmailCode({
    email: 'buyer@example.com',
    code: issueEmailCode({ email: 'buyer@example.com', code: '654321' }).devCode,
  })

  const result = rechargeAccount({ token, packageId: 'local-50' })

  assert.equal(result.ok, true)
  assert.equal(result.user.credits, 5000)
  assert.equal(result.ledger[0].type, 'recharge')
  assert.equal(result.ledger[0].credits, 5000)
})

test('model cost uses configured multiplier and max token budget', () => {
  const config = loadBillingConfig({
    MODEL_NAME: 'fast-model',
    MODEL_PRICE_MULTIPLIERS: 'fast-model:1,pro-model:3',
    CREDIT_BASE_PER_1K_TOKENS: '10',
    MODEL_MAX_TOKENS: '2000',
  })

  assert.equal(estimateChatCost({ modelName: 'fast-model', messages: [{ role: 'user', content: 'hello' }], config }), 21)
  assert.equal(estimateChatCost({ modelName: 'pro-model', messages: [{ role: 'user', content: 'hello' }], config }), 63)
})

test('model cost accepts multimodal message content', () => {
  const config = loadBillingConfig({
    MODEL_NAME: 'vision-model',
    MODEL_PRICE_MULTIPLIERS: 'vision-model:1',
    CREDIT_BASE_PER_1K_TOKENS: '10',
    MODEL_MAX_TOKENS: '100',
  })

  const cost = estimateChatCost({
    modelName: 'vision-model',
    config,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this file' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ],
  })

  assert.equal(cost, 2)
})

test('billing and mail diagnostics are safe for browser display', () => {
  const billing = getBillingDiagnostics({
    MODEL_NAME: 'fast-model',
    MODEL_PRICE_MULTIPLIERS: 'fast-model:1,pro-model:3',
    CREDIT_BASE_PER_1K_TOKENS: '10',
    MODEL_MAX_TOKENS: '2000',
  })
  assert.equal(billing.basePer1k, 10)
  assert.equal(billing.multipliers['pro-model'], 3)
  assert.equal(billing.packages.length > 0, true)

  const mail = getMailDiagnostics({
    MAIL_SERVER: 'smtp.qq.com',
    MAIL_PORT: '587',
    MAIL_USE_TLS: 'true',
    MAIL_USERNAME: 'person@qq.com',
    MAIL_PASSWORD: 'secret-auth-code',
    MAIL_DEFAULT_SENDER: 'person@qq.com',
    AUTH_DEV_CODES: 'false',
  })
  assert.equal(mail.configured, true)
  assert.equal(mail.useTls, true)
  assert.equal(mail.devCodes, false)
  assert.equal(JSON.stringify(mail).includes('secret-auth-code'), false)
})

test('charging model use blocks requests when credits are insufficient', () => {
  const { token } = verifyEmailCode({
    email: 'low@example.com',
    code: issueEmailCode({ email: 'low@example.com', code: '111111' }).devCode,
  })
  const user = getPublicAccount({ token })
  assert.equal(user.credits, 0)

  assert.throws(
    () => chargeForModelUse({ token, modelName: 'pro-model', cost: 10 }),
    /积分不足/
  )

  rechargeAccount({ token, packageId: 'local-10' })
  const charged = chargeForModelUse({ token, modelName: 'pro-model', cost: 10 })

  assert.equal(charged.user.credits, 990)
  assert.equal(charged.ledger[0].type, 'model_charge')
})

test('charging tool use deducts credits and records tool ledger entries', () => {
  const { token } = verifyEmailCode({
    email: 'tool-user@example.com',
    code: issueEmailCode({ email: 'tool-user@example.com', code: '222222' }).devCode,
  })

  rechargeAccount({ token, packageId: 'local-10' })
  const charged = chargeForToolUse({ token, toolName: 'web_search', cost: 3 })

  assert.equal(charged.user.credits, 997)
  assert.equal(charged.ledger[0].type, 'tool_charge')
  assert.equal(charged.ledger[0].model_name, 'web_search')
  assert.equal(charged.ledger[0].credits, -3)
})

test('model charges use relative credit deductions', () => {
  const { token } = verifyEmailCode({
    email: 'relative-charge@example.com',
    code: issueEmailCode({ email: 'relative-charge@example.com', code: '444444' }).devCode,
  })
  rechargeAccount({ token, packageId: 'local-10' })

  chargeForModelUse({ token, modelName: 'pro-model', cost: 10 })
  getDb().prepare('UPDATE users SET credits = credits + 5 WHERE email = ?').run('relative-charge@example.com')
  const charged = chargeForModelUse({ token, modelName: 'pro-model', cost: 10 })

  assert.equal(charged.user.credits, 985)
})
