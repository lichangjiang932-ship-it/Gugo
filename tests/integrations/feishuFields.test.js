import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离 DB（listProviderRegistry 不查 DB，但导入链可能触发 db.js 初始化）
process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-feishu-fields-'))

const { listProviderRegistry, upsertIntegration } = await import('../../server/services/integrationsStore.js')
const authMod = await import('../../server/adapters/authAccount.js')

test('feishu provider: 必填字段简化到 appId + appSecret', () => {
  const providers = listProviderRegistry()
  const feishu = providers.find((p) => p.provider === 'feishu')
  assert.ok(feishu, 'feishu provider 应该存在')
  assert.deepEqual(feishu.fields.config, ['appId'])
  assert.deepEqual(feishu.fields.secret, ['appSecret'])
})

test('feishu provider: optional 字段透传到前端', () => {
  const providers = listProviderRegistry()
  const feishu = providers.find((p) => p.provider === 'feishu')
  assert.ok(feishu.fields.optional, 'fields.optional 必须存在')
  assert.ok(Array.isArray(feishu.fields.optional.config), 'optional.config 必须是数组')
  assert.ok(feishu.fields.optional.config.includes('botName'), 'optional.config 应该包含 botName')
  assert.ok(feishu.fields.optional.config.includes('defaultAgentId'), 'optional.config 应该包含 defaultAgentId')
  assert.ok(Array.isArray(feishu.fields.optional.secret), 'optional.secret 必须是数组')
  assert.ok(feishu.fields.optional.secret.includes('verificationToken'), 'optional.secret 应该包含 verificationToken')
  assert.ok(feishu.fields.optional.secret.includes('encryptKey'), 'optional.secret 应该包含 encryptKey')
})

test('feishu upsertIntegration: 缺少 optional 字段不报错', () => {
  const issued = authMod.issueEmailCode({ email: `feishu-fields-${Date.now()}@example.com` })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  const integration = upsertIntegration({
    userId: login.user.id,
    provider: 'feishu',
    name: '飞书测试',
    enabled: false,
    config: { appId: 'cli_test_123' },
    secret: { appSecret: 'secret-abc' },
  })
  assert.ok(integration?.id, '应该成功创建 integration')
  assert.equal(integration.provider, 'feishu')
  assert.equal(integration.config.appId, 'cli_test_123')
})
