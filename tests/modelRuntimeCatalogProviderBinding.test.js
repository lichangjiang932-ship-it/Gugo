import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-catalog-provider-binding-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const { getModelContextWindow } = await import('../server/adapters/modelRuntimeCatalog.js')
const {
  buildUserModelEnv,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function createProvider({ userId, key, contextWindow, isDefault = false }) {
  return upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl: `https://${key}.example/v1`,
      models: ['shared-model'],
      defaultModel: 'shared-model',
      enabled: true,
      isDefault,
      modelProfiles: {
        'shared-model': { contextWindow },
      },
    },
  })
}

test('context-window lookup resolves duplicate model names by durable Provider UUID', () => {
  const userId = 'runtime-catalog-provider-user'
  createUser({ id: userId, email: 'runtime-catalog-provider@example.com' })
  const first = createProvider({ userId, key: 'first', contextWindow: 8192, isDefault: true })
  const second = createProvider({ userId, key: 'second', contextWindow: 65_536 })
  const env = buildUserModelEnv({ userId, env: {} })

  assert.equal(getModelContextWindow({
    modelName: 'shared-model',
    modelProviderId: first.id,
    env,
  }), 8192)
  assert.equal(getModelContextWindow({
    modelName: 'shared-model',
    modelProviderId: second.id,
    env,
  }), 65_536)
})

test('context-window lookup fails closed for an unknown Provider UUID', () => {
  const userId = 'runtime-catalog-unknown-provider-user'
  createUser({ id: userId, email: 'runtime-catalog-unknown-provider@example.com' })
  createProvider({ userId, key: 'only', contextWindow: 16_384, isDefault: true })
  const env = buildUserModelEnv({ userId, env: {} })

  assert.throws(
    () => getModelContextWindow({
      modelName: 'shared-model',
      modelProviderId: '00000000-0000-4000-8000-000000000000',
      env,
    }),
    (error) => error?.code === 'MODEL_PROVIDER_BINDING_MISSING'
      && error?.providerId === '00000000-0000-4000-8000-000000000000'
      && error?.retryable === false,
  )
})
