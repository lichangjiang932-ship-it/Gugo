import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isProviderFailoverError,
  resolveModelFailoverConfigs,
  runWithProviderFailover,
  streamWithProviderFailover,
} from '../server/adapters/modelProxy.js'

test('provider candidates keep the selected provider first and add alternatives', () => {
  const env = {
    MODEL_NAME: 'primary-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'p',
    MODEL_PROVIDER_PRIMARY_MODELS: 'primary-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'b',
    // ★ 备用 provider 必须提供**同名**模型才算合格备选。
    // 原来这里是 'backup-model'(不同模型)也被当成备选 —— 那正是
    // 「选了 deepseek-v4-flash 却按 mimo-v2.5 计费」的成因。
    MODEL_PROVIDER_BACKUP_MODELS: 'primary-model',
  }
  const configs = resolveModelFailoverConfigs({ env })
  assert.deepEqual(configs.map((config) => config.providerId), ['primary', 'backup'])
  assert.deepEqual(configs.map((config) => config.modelName), ['primary-model', 'primary-model'])
})

test('★ 备用 provider 没有同名模型时被剔除 —— 不能静默换模型并按它计费', () => {
  const env = {
    MODEL_NAME: 'primary-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'p',
    MODEL_PROVIDER_PRIMARY_MODELS: 'primary-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'b',
    MODEL_PROVIDER_BACKUP_MODELS: 'backup-model',
  }
  const configs = resolveModelFailoverConfigs({ env })
  assert.deepEqual(configs.map((config) => config.modelName), ['primary-model'])

  // 显式开启后才允许跨模型
  const opened = resolveModelFailoverConfigs({
    env: { ...env, MODEL_STRICT_SELECTION: '0', MODEL_FAILOVER_CROSS_MODEL: '1' },
  })
  assert.deepEqual(opened.map((config) => config.modelName), ['primary-model', 'backup-model'])
})

test('provider failover changes provider for recoverable failures', async () => {
  const attempted = []
  const result = await runWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], async (config) => {
    attempted.push(config.providerId)
    if (config.providerId === 'primary') throw Object.assign(new Error('upstream down'), { status: 503 })
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.deepEqual(attempted, ['primary', 'backup'])
})

test('provider failover does not hide authentication or request errors', async () => {
  assert.equal(isProviderFailoverError(Object.assign(new Error('down'), { status: 503 })), true)
  assert.equal(isProviderFailoverError(Object.assign(new Error('timeout'), { status: 504 })), true)
  assert.equal(isProviderFailoverError(Object.assign(new Error('bad key'), { status: 401 })), false)
  assert.equal(isProviderFailoverError(Object.assign(new Error('cancelled'), { name: 'AbortError' })), false)
  let calls = 0
  await assert.rejects(() => runWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], async () => {
    calls += 1
    throw Object.assign(new Error('bad request'), { status: 400 })
  }), /bad request/)
  assert.equal(calls, 1)
})

test('stream failover only switches before the first emitted event', async () => {
  async function* beforeFirst(config) {
    if (config.providerId === 'primary') throw Object.assign(new Error('down'), { status: 503 })
    yield 'backup text'
  }
  const received = []
  for await (const item of streamWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], beforeFirst)) received.push(item)
  assert.deepEqual(received, [{ event: 'backup text', config: { providerId: 'backup' } }])

  async function* afterFirst() {
    yield 'partial'
    throw Object.assign(new Error('late failure'), { status: 503 })
  }
  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover([
      { providerId: 'primary' },
      { providerId: 'backup' },
    ], afterFirst)) {
      // Consume the first event; a late failure must surface without replaying.
      void item
    }
  }, /late failure/)
})
