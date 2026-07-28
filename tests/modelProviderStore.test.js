import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-providers-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const {
  buildUserModelEnv,
  deleteModelProvider,
  listModelProviders,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('model providers are user-scoped, redacted and converted to runtime env', () => {
  createUser({ id: 'u-model-1', email: 'model-1@example.com' })
  createUser({ id: 'u-model-2', email: 'model-2@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-1',
    provider: {
      key: 'custom-openai',
      label: 'Custom OpenAI',
      baseUrl: 'https://models.example.com/v1/',
      apiKey: 'sk-secret',
      models: ['alpha', 'beta', 'alpha'],
      defaultModel: 'beta',
      headers: { 'X-Tenant': 'atelier' },
      enabled: true,
      isDefault: true,
    },
  })

  assert.equal(provider.baseUrl, 'https://models.example.com/v1')
  assert.equal(provider.hasApiKey, true)
  assert.equal('apiKey' in provider, false)
  assert.deepEqual(provider.models, ['alpha', 'beta'])
  assert.equal(listModelProviders({ userId: 'u-model-2' }).length, 0)

  const env = buildUserModelEnv({ userId: 'u-model-1', env: {} })
  assert.equal(env.MODEL_NAME, 'beta')
  assert.equal(env.MODEL_PROVIDER_CUSTOM_OPENAI_API_KEY, 'sk-secret')
  assert.equal(env.MODEL_PROVIDER_CUSTOM_OPENAI_MODELS, 'alpha,beta')
  assert.equal(JSON.parse(env.MODEL_PROVIDER_CUSTOM_OPENAI_HEADERS)['X-Tenant'], 'atelier')

  const updated = upsertModelProvider({
    userId: 'u-model-1',
    provider: { ...provider, apiKey: '', models: ['beta'], defaultModel: 'beta' },
  })
  assert.equal(updated.hasApiKey, true, 'blank API key keeps the existing secret')
  assert.equal(buildUserModelEnv({ userId: 'u-model-1', env: {} }).MODEL_PROVIDER_CUSTOM_OPENAI_HEADERS,
    JSON.stringify({ 'X-Tenant': 'atelier' }), 'redacted headers keep their existing values')
  assert.equal(deleteModelProvider({ userId: 'u-model-2', id: provider.id }), false)
  assert.equal(deleteModelProvider({ userId: 'u-model-1', id: provider.id }), true)
})

test('local model provider works without an API key', () => {
  createUser({ id: 'u-model-local', email: 'model-local@example.com' })
  const provider = upsertModelProvider({
    userId: 'u-model-local',
    provider: {
      key: 'ollama',
      label: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      models: ['qwen3:8b'],
      defaultModel: 'qwen3:8b',
      enabled: true,
    },
  })

  assert.equal(provider.hasApiKey, false)
  assert.equal(provider.isDefault, true)
  const env = buildUserModelEnv({ userId: 'u-model-local', env: {} })
  assert.equal(env.MODEL_PROVIDER_OLLAMA_API_KEY, '')
  assert.equal(env.MODEL_PROVIDER_OLLAMA_BASE_URL, 'http://127.0.0.1:11434/v1')
  assert.equal(env.MODEL_NAME, 'qwen3:8b')
})

test('model provider validation rejects unsafe identifiers and protocols', () => {
  assert.throws(() => upsertModelProvider({
    userId: 'u-model-1',
    provider: { key: '../bad', baseUrl: 'file:///tmp/model', apiKey: 'x', models: ['m'] },
  }), /Provider ID|Base URL/)
})
