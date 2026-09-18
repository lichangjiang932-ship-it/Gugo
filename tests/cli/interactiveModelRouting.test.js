import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'

const dataDir = mkdtempSync(path.join(tmpdir(), 'gugo-interactive-model-routing-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64')

const { closeDb, createUser } = await import('../../server/db.js')
const { upsertModelProvider, recordModelProviderReadiness } = await import('../../server/services/modelProviderStore.js')
const { resolveAgentModelRuntimeBinding } = await import('../../server/services/modelReadinessService.js')
const { callBackgroundModel } = await import('../../server/adapters/modelInvocationRuntime.js')
const { createInteractiveModelCatalog } = await import('../../bin/cli/interactiveModelCatalog.js')
const { startInteractiveSession } = await import('../../bin/cli/interactiveSession.js')

test.after(() => {
  closeDb()
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(tmpdir()) + path.sep))
  rmSync(dataDir, { recursive: true, force: true })
})

let sequence = 0
function fixture({ enabled = true, models = ['cloud-model'] } = {}) {
  const userId = `interactive-model-routing-${++sequence}`
  createUser({ id: userId, email: `${userId}@example.invalid` })
  const cloud = upsertModelProvider({ userId, env: {}, provider: {
    key: 'cloud', label: 'Saved cloud fixture', baseUrl: 'https://cloud.example.invalid/v1',
    apiKey: 'fixture-cloud-only', models, defaultModel: models[0], enabled, isDefault: true, supportsTools: true,
  } })
  recordModelProviderReadiness({ userId, id: cloud.id, modelName: cloud.defaultModel,
    expectedConfigRevision: cloud.configRevision, readiness: { chat: true, tools: true, agent: true, mode: 'agent' } })
  const env = { APP_DATA_DIR: dataDir, APP_DB_PATH: process.env.APP_DB_PATH,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
    MODEL_PROVIDERS: 'local', MODEL_PROVIDER_LOCAL_BASE_URL: 'http://127.0.0.1:1234/v1',
    MODEL_PROVIDER_LOCAL_MODELS: 'org/model', MODEL_PROVIDER_LOCAL_API_KEY: 'fixture-local-only',
    MODEL_PROVIDER_LOCAL_PROFILE: JSON.stringify({ kind: 'lmstudio', supportsTools: true, contextWindow: 16384 }) }
  return { userId, cloud, env }
}

test('the actual chat selection and canonical request send an explicit environment model only to its local endpoint', async () => {
  const f = fixture()
  const requests = []
  let responseText = null
  const stream = new Writable({ write(_chunk, _encoding, done) { done() } })
  const code = await startInteractiveSession({ options: { sessionId: 'local-routing' },
    lines: ['/model local/org/model', 'Only reply LOCAL_SELECTION_OK.', '/exit'], env: f.env,
    stdout: stream, stderr: stream, resolveUserId: async () => f.userId,
    runTurn: async (input) => {
      const binding = resolveAgentModelRuntimeBinding({ userId: f.userId, providerId: input.modelProviderId,
        modelName: input.model, env: input.env })
      responseText = await callBackgroundModel({ userId: null, env: binding.env, modelName: binding.modelName,
        modelProviderId: binding.providerId, messages: [{ role: 'user', content: input.prompt }],
        fetchImpl: async (url, init) => {
          requests.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization })
          return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'LOCAL_SELECTION_OK' }, finish_reason: 'stop' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } })
        } })
      return { status: 'completed', exitCode: 0, sessionId: input.sessionId }
    },
  })
  assert.equal(code, 0)
  assert.equal(responseText, 'LOCAL_SELECTION_OK', 'the interactive error handler must not hide a failed model request')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal(requests[0].body.model, 'org/model')
  assert.equal(requests[0].authorization, 'Bearer fixture-local-only')
  assert.ok(requests.every((request) => !request.url.includes('cloud.example.invalid')))
})

test('saved and named environment models share ambiguity rules without losing canonical Provider identity', async () => {
  const f = fixture({ models: ['org/model'] })
  const catalog = createInteractiveModelCatalog(f)
  try {
    await catalog.refresh()
    assert.deepEqual(catalog.list(), [`${f.cloud.id}/org/model`, 'local/org/model'])
    await assert.rejects(catalog.select('org/model'), { code: 'MODEL_PROVIDER_AMBIGUOUS' })
    const local = await catalog.select('org/model', { currentProviderId: 'local' })
    assert.equal(local.providerId, 'local')
    assert.equal(local.modelName, 'org/model')
    const saved = await catalog.select('cloud/org/model')
    assert.equal(saved.providerId, f.cloud.id)
    assert.equal(saved.configRevision, f.cloud.configRevision)
    assert.equal(saved.readiness.agent, true)
    assert.equal(JSON.stringify(catalog.entries()).includes('fixture-local-only'), false)
    assert.equal(JSON.stringify(catalog.entries()).includes('fixture-cloud-only'), false)
  } finally { catalog.close() }
})

test('disabled saved providers do not hide a different active environment Provider', async () => {
  const f = fixture({ enabled: false })
  const catalog = createInteractiveModelCatalog(f)
  try {
    const local = await catalog.select('local/org/model')
    assert.equal(local.providerId, 'local')
    await assert.rejects(catalog.select('cloud/cloud-model'), { code: 'MODEL_PROVIDER_DISABLED' })
    await assert.rejects(catalog.select(`${f.cloud.id}/cloud-model`), { code: 'MODEL_PROVIDER_DISABLED' })
  } finally { catalog.close() }
})

test('the effective catalog does not re-expose an environment namespace shadowed by a saved Provider', async () => {
  const f = fixture()
  Object.assign(f.env, { MODEL_PROVIDERS: 'cloud,local', MODEL_PROVIDER_CLOUD_BASE_URL: 'http://127.0.0.1:4567/v1',
    MODEL_PROVIDER_CLOUD_MODELS: 'shadowed-only-model' })
  const catalog = createInteractiveModelCatalog(f)
  try {
    await catalog.refresh()
    assert.deepEqual(catalog.list(), [`${f.cloud.id}/cloud-model`, 'local/org/model'])
    await assert.rejects(catalog.select('cloud/shadowed-only-model'), { code: 'MODEL_PROVIDER_MODEL_INVALID' })
    assert.equal((await catalog.select('cloud/cloud-model')).providerId, f.cloud.id)
  } finally { catalog.close() }
})
