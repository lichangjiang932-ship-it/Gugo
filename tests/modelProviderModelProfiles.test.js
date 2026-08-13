import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-profiles-'))
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

const { closeDb, createUser, DB_SCHEMA_VERSION } = await import('../server/db.js')
const { buildUserModelEnv, upsertModelProvider } = await import('../server/services/modelProviderStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
test('v45 stores independent runtime limits for models on the same provider', () => {
  assert.ok(DB_SCHEMA_VERSION >= 45)
  const userId = 'model-profile-user'
  createUser({ id: userId, email: 'model-profiles@example.com' })
  const saved = upsertModelProvider({
    userId,
    provider: {
      key: 'mixed-context',
      label: 'Mixed context',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['short-model', 'long-model'],
      defaultModel: 'short-model',
      modelProfiles: {
        'short-model': { contextWindow: 8192, maxOutputTokens: 2048, source: 'ollama-api-show' },
        'long-model': { contextWindow: 131072, maxOutputTokens: 16384, supportsTools: true, source: 'manual' },
        'removed-model': { contextWindow: 999999 },
      },
    },
  })

  assert.deepEqual(saved.modelProfiles, {
    'short-model': { contextWindow: 8192, maxOutputTokens: 2048, source: 'ollama-api-show' },
    'long-model': { contextWindow: 131072, maxOutputTokens: 16384, supportsTools: true, source: 'manual' },
  })
  const runtimeEnv = buildUserModelEnv({ userId, env: {} })
  const profile = JSON.parse(runtimeEnv.MODEL_PROVIDER_MIXED_CONTEXT_PROFILE)
  assert.equal(profile.models['short-model'].contextWindow, 8192)
  assert.equal(profile.models['long-model'].contextWindow, 131072)
})
