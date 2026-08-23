import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-compaction-binding-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const { resolveCompactionModelContext } = await import('../server/routes/compactionRoutes.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function createReadyProvider({ userId, key, baseUrl }) {
  const provider = upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl,
      apiKey: `${key}-secret`,
      models: ['shared-model'],
      defaultModel: 'shared-model',
      enabled: true,
      kind: 'openai-compatible',
    },
  })
  return recordModelProviderReadiness({
    userId,
    id: provider.id,
    expectedConfigRevision: provider.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
}

test('manual compaction locks duplicate model names to the selected Provider UUID', async () => {
  const userId = 'compaction-provider-user'
  createUser({ id: userId, email: 'compaction-provider@example.com' })
  createReadyProvider({ userId, key: 'first', baseUrl: 'https://first.example/v1' })
  const selected = createReadyProvider({ userId, key: 'second', baseUrl: 'https://second.example/v1' })
  let contextRequest = null
  let modelRequest = null

  const context = resolveCompactionModelContext({
    userId,
    modelName: 'shared-model',
    modelProviderId: selected.id,
    modelConfigRevision: selected.configRevision,
    env: {},
    resolveContextWindow: (request) => {
      contextRequest = request
      return 8192
    },
    invokeModel: async (request) => {
      modelRequest = request
      return 'summary'
    },
  })

  assert.equal(context.modelProviderId, selected.id)
  assert.equal(context.modelConfigRevision, selected.configRevision)
  assert.equal(contextRequest.userId, null)
  assert.equal(contextRequest.modelProviderId, undefined)
  assert.equal(contextRequest.env.MODEL_PROVIDERS, 'second')
  assert.equal(contextRequest.env.MODEL_BASE_URL, 'https://second.example/v1')
  assert.equal(await context.callModel({ messages: [{ role: 'user', content: 'compact' }] }), 'summary')
  assert.equal(modelRequest.userId, null)
  assert.equal(modelRequest.env.MODEL_PROVIDERS, 'second')
  assert.equal(modelRequest.env.MODEL_BASE_URL, 'https://second.example/v1')
})

test('manual compaction rejects configuration drift before context or model calls', () => {
  const userId = 'compaction-drift-user'
  createUser({ id: userId, email: 'compaction-drift@example.com' })
  const original = createReadyProvider({ userId, key: 'drift', baseUrl: 'https://old.example/v1' })
  upsertModelProvider({
    userId,
    provider: {
      ...original,
      baseUrl: 'https://new.example/v1',
      apiKey: '',
    },
  })
  let contextCalls = 0
  let modelCalls = 0

  assert.throws(
    () => resolveCompactionModelContext({
      userId,
      modelName: 'shared-model',
      modelProviderId: original.id,
      modelConfigRevision: original.configRevision,
      env: {},
      resolveContextWindow: () => { contextCalls += 1; return 8192 },
      invokeModel: async () => { modelCalls += 1; return 'unexpected' },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_CONFIG_CHANGED'
      && error?.providerId === original.id
      && error?.configRevision === original.configRevision,
  )
  assert.equal(contextCalls, 0)
  assert.equal(modelCalls, 0)
})
