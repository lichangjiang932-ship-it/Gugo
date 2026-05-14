import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSendCodeResponse,
  createMemoryStore,
  getPublicAccount,
  issueEmailCode,
  verifyEmailCode,
  rechargeAccount,
  estimateChatCost,
  chargeForModelUse,
  getBillingDiagnostics,
  getMailDiagnostics,
  loadBillingConfig,
} from '../server/billingAuth.js'

test('email code login creates a reusable user token without exposing the code', () => {
  const store = createMemoryStore()
  const issued = issueEmailCode({ store, email: 'person@example.com', now: 1000, code: '123456' })

  assert.equal(issued.ok, true)
  assert.equal(issued.email, 'person@example.com')
  assert.equal('code' in issued, false)

  const session = verifyEmailCode({ store, email: 'person@example.com', code: '123456', now: 2000 })

  assert.equal(session.ok, true)
  assert.match(session.token, /^usr_/)
  assert.equal(session.user.email, 'person@example.com')
  assert.equal(session.user.credits, 0)
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
  const store = createMemoryStore()
  const { token } = verifyEmailCode({
    store,
    email: 'buyer@example.com',
    code: issueEmailCode({ store, email: 'buyer@example.com', code: '654321' }).devCode,
  })

  const result = rechargeAccount({ store, token, packageId: 'local-50' })

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
  const store = createMemoryStore()
  const { token } = verifyEmailCode({
    store,
    email: 'low@example.com',
    code: issueEmailCode({ store, email: 'low@example.com', code: '111111' }).devCode,
  })
  const user = getPublicAccount({ store, token })
  assert.equal(user.credits, 0)

  assert.throws(
    () => chargeForModelUse({ store, token, modelName: 'pro-model', cost: 10 }),
    /积分不足/
  )

  rechargeAccount({ store, token, packageId: 'local-10' })
  const charged = chargeForModelUse({ store, token, modelName: 'pro-model', cost: 10 })

  assert.equal(charged.user.credits, 990)
  assert.equal(charged.ledger[0].type, 'model_charge')
})
