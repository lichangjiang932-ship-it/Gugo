import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-profiles-'))
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

const { closeDb, createUser, getDb, DB_SCHEMA_VERSION } = await import('../server/db.js')
const { buildUserModelEnv, getModelProvider, upsertModelProvider } = await import('../server/services/modelProviderStore.js')
const { normalizeModelProfiles } = await import('../server/services/modelProviderConfig.js')
const { resolveModelConfigForModel } = await import('../server/adapters/modelProviderConfig.js')
const { profileForConfig } = await import('../server/adapters/modelEndpoint.js')

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

test('stored model profiles preserve the controlled legacy cache flag through reopen and canonical config resolution', () => {
  const userId = 'cache-ttl-profile-user'
  createUser({ id: userId, email: 'cache-ttl-profiles@example.invalid' })
  const saved = upsertModelProvider({ userId, env: {}, provider: {
    key: 'cache-ttl', label: 'Cache TTL', baseUrl: 'https://legacy-gateway.example.invalid/v1', kind: 'anthropic',
    models: ['legacy', 'ga', 'ordinary'], defaultModel: 'legacy',
    modelProfiles: { legacy: { requiresPromptCacheTtlBeta: true, unrelatedFlag: true },
      ga: { requiresPromptCacheTtlBeta: false }, removed: { requiresPromptCacheTtlBeta: true } },
  } })
  const expected = { legacy: { requiresPromptCacheTtlBeta: true }, ga: { requiresPromptCacheTtlBeta: false } }
  assert.deepEqual(saved.modelProfiles, expected)
  const stored = getDb().prepare('SELECT model_profiles_json FROM model_providers WHERE id = ? AND user_id = ?').get(saved.id, userId)
  assert.deepEqual(JSON.parse(stored.model_profiles_json), expected)
  closeDb()
  assert.deepEqual(getModelProvider({ userId, id: saved.id }).modelProfiles, expected)
  assert.equal(getModelProvider({ userId: 'different-owner', id: saved.id }), null)
  const renamed = upsertModelProvider({ userId, env: {}, provider: {
    id: saved.id, configRevision: saved.configRevision, key: saved.key, label: 'Renamed cache TTL',
    baseUrl: saved.baseUrl, models: saved.models, defaultModel: saved.defaultModel,
  } })
  assert.deepEqual(renamed.modelProfiles, expected, 'an unrelated update must not erase the compatibility flag')
  const env = buildUserModelEnv({ userId, env: {} })
  assert.deepEqual(JSON.parse(env.MODEL_PROVIDER_CACHE_TTL_PROFILE).models, expected)
  for (const modelName of saved.models) {
    const config = resolveModelConfigForModel({ modelName, providerId: saved.id, env })
    assert.equal(config.configured, true)
    const profile = profileForConfig(config, env)
    assert.equal(profile.kind, 'anthropic')
    assert.equal(profile.requiresPromptCacheTtlBeta, modelName === 'legacy')
  }
  const disabled = upsertModelProvider({ userId, env: {}, provider: {
    ...renamed, modelProfiles: { legacy: { requiresPromptCacheTtlBeta: false } },
  } })
  assert.equal(disabled.modelProfiles.legacy.requiresPromptCacheTtlBeta, false)
  assert.ok(disabled.configRevision > renamed.configRevision, 'changing the flag remains a runtime config change')
  const updatedEnv = buildUserModelEnv({ userId, env: {} })
  const updatedConfig = resolveModelConfigForModel({ modelName: 'legacy', providerId: saved.id, env: updatedEnv })
  assert.equal(profileForConfig(updatedConfig, updatedEnv).requiresPromptCacheTtlBeta, false)
})

test('only declared boolean cache compatibility flags survive model-profile normalization', () => {
  for (const value of [true, false]) {
    const expected = { legacy: { requiresPromptCacheTtlBeta: value } }
    assert.deepEqual(normalizeModelProfiles(JSON.stringify(expected), ['legacy']), expected)
  }
  for (const value of [undefined, null, '', 1, 0, 'true', 'false', {}, []]) {
    assert.deepEqual(normalizeModelProfiles({ legacy: { requiresPromptCacheTtlBeta: value, unrelatedFlag: true } }, ['legacy']), {})
  }
  assert.deepEqual(normalizeModelProfiles({ removed: { requiresPromptCacheTtlBeta: true } }, ['legacy']), {})
})
