import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSensitiveEnvKey, sanitizeChildEnv } from '../server/utils/sensitiveEnv.js'

test('isSensitiveEnvKey: explicit deny list', () => {
  assert.equal(isSensitiveEnvKey('MODEL_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('OPENAI_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('ANTHROPIC_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('GITHUB_TOKEN'), true)
  assert.equal(isSensitiveEnvKey('MAIL_PASSWORD'), true)
  assert.equal(isSensitiveEnvKey('AWS_ACCESS_KEY_ID'), true)
})

test('isSensitiveEnvKey: suffix-based catch-all', () => {
  // 新 provider 不用改代码就能挡住
  assert.equal(isSensitiveEnvKey('XAI_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('FUTURE_PROVIDER_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('REDIS_PASSWORD'), true)
  assert.equal(isSensitiveEnvKey('STRIPE_SECRET'), true)
  assert.equal(isSensitiveEnvKey('SLACK_TOKEN'), true)
  assert.equal(isSensitiveEnvKey('VAULT_CREDENTIALS'), true)
  assert.equal(isSensitiveEnvKey('SSH_PRIVATE_KEY'), true)
})

test('isSensitiveEnvKey: harmless keys pass', () => {
  assert.equal(isSensitiveEnvKey('PATH'), false)
  assert.equal(isSensitiveEnvKey('HOME'), false)
  assert.equal(isSensitiveEnvKey('LANG'), false)
  assert.equal(isSensitiveEnvKey('NODE_ENV'), false)
  assert.equal(isSensitiveEnvKey('USER'), false)
  // suffix 必须真的在末尾
  assert.equal(isSensitiveEnvKey('MY_TOKEN_ISSUER'), false)
  assert.equal(isSensitiveEnvKey('PASSWORD_RULES'), false)
})

test('isSensitiveEnvKey: edge cases', () => {
  assert.equal(isSensitiveEnvKey(''), false)
  assert.equal(isSensitiveEnvKey(null), false)
  assert.equal(isSensitiveEnvKey(undefined), false)
  assert.equal(isSensitiveEnvKey(123), false)
  // 后缀本身但 key 长度==后缀长度不算(因为 length > suffix.length)
  assert.equal(isSensitiveEnvKey('_API_KEY'), false)
})

test('sanitizeChildEnv: strips sensitive process.env', () => {
  const originals = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    HOME: process.env.HOME,
  }
  process.env.OPENAI_API_KEY = 'sk-real-key'
  process.env.XAI_API_KEY = 'xai-real'
  try {
    const env = sanitizeChildEnv()
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.XAI_API_KEY, undefined)
    assert.ok(env.HOME != null || env.PATH != null || env.Path != null, 'should keep harmless env')
  } finally {
    if (originals.OPENAI_API_KEY == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originals.OPENAI_API_KEY
    if (originals.XAI_API_KEY == null) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originals.XAI_API_KEY
  }
})

test('sanitizeChildEnv: extra may add safe keys but cannot inject secrets', () => {
  const env = sanitizeChildEnv({ MY_FLAG: '1', OPENAI_API_KEY: 'sneaky' })
  assert.equal(env.MY_FLAG, '1')
  assert.equal(env.OPENAI_API_KEY, undefined, 'extra must also be filtered')
})

test('sanitizeChildEnv: skips null/undefined values', () => {
  const env = sanitizeChildEnv({ A: null, B: undefined, C: 'ok' })
  assert.equal(env.A, undefined)
  assert.equal(env.B, undefined)
  assert.equal(env.C, 'ok')
})
