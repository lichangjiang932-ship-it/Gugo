import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-model-runtime-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const {
  assertEvolutionModelIdentityCurrent,
  callEvolutionBackgroundModel,
  resolveEvolutionModelIdentity,
} = await import('../server/services/evolutionModelRuntime.js')
const { upsertModelProvider } = await import('../server/services/modelProviderStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()

function startModelServer(label, calls) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: label },
        finish_reason: 'stop',
      }],
    }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('evolution model runtime pins one Provider snapshot and rejects a changed revision', async (t) => {
  const firstCalls = []
  const secondCalls = []
  const firstServer = await startModelServer('first endpoint', firstCalls)
  const secondServer = await startModelServer('second endpoint', secondCalls)
  t.after(() => Promise.all([
    new Promise((resolve) => firstServer.close(resolve)),
    new Promise((resolve) => secondServer.close(resolve)),
  ]))

  const { userId } = issueTestSession({ email: 'evolution-runtime-owner@example.com' })
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'revisionpin',
      label: 'Revision pin',
      baseUrl: `http://127.0.0.1:${firstServer.address().port}/v1`,
      apiKey: 'first-secret',
      models: ['fixed-model'],
      defaultModel: 'fixed-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  const identity = resolveEvolutionModelIdentity({
    userId,
    providerId: provider.id,
    modelName: 'fixed-model',
  })

  assert.equal(identity.providerId, provider.id)
  assert.equal(identity.runtimeProviderId, provider.key)
  assert.equal(identity.configRevision, 1)

  const updated = upsertModelProvider({
    userId,
    provider: {
      id: provider.id,
      key: provider.key,
      configRevision: provider.configRevision,
      label: provider.label,
      baseUrl: `http://127.0.0.1:${secondServer.address().port}/v1`,
      apiKey: 'second-secret',
      models: ['fixed-model'],
      defaultModel: 'fixed-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  assert.equal(updated.configRevision, 2)

  const response = await callEvolutionBackgroundModel({
    messages: [{ role: 'user', content: 'use the pinned endpoint' }],
    userId,
    providerId: identity.providerId,
    runtimeProviderId: identity.runtimeProviderId,
    runtimeEnv: identity.runtimeEnv,
    modelName: identity.modelName,
  })

  assert.equal(response.providerId, provider.id)
  assert.equal(response.modelName, 'fixed-model')
  assert.equal(response.content, 'first endpoint')
  assert.equal(firstCalls.length, 1)
  assert.equal(firstCalls[0].authorization, 'Bearer first-secret')
  assert.equal(firstCalls[0].body.model, 'fixed-model')
  assert.equal(secondCalls.length, 0)
  assert.throws(
    () => assertEvolutionModelIdentityCurrent({ userId, identity }),
    (error) => error?.code === 'EVOLUTION_MODEL_PROVIDER_CONFIG_CHANGED'
      && error?.statusCode === 409,
  )
})

test('evolution model runtime gives a durable UUID precedence over another Provider legacy key', () => {
  const { userId } = issueTestSession({ email: 'evolution-runtime-uuid-owner@example.com' })
  let target = null
  for (let index = 0; index < 64 && !target; index += 1) {
    const candidate = upsertModelProvider({
      userId,
      provider: {
        key: `evolution-uuid-target-${index}`,
        label: `Evolution UUID target ${index}`,
        baseUrl: 'https://evolution-uuid-target.example.test/v1',
        models: ['evolution-uuid-model'],
        defaultModel: 'evolution-uuid-model',
        enabled: true,
      },
    })
    if (/^[a-f]/.test(candidate.id)) target = candidate
  }
  assert.ok(target, 'fixture must obtain a UUID that is also a valid Provider key')

  const shadow = upsertModelProvider({
    userId,
    provider: {
      key: target.id,
      label: 'Legacy key shadow',
      baseUrl: 'https://evolution-uuid-shadow.example.test/v1',
      models: ['evolution-uuid-model'],
      defaultModel: 'evolution-uuid-model',
      enabled: true,
      isDefault: true,
    },
  })
  assert.notEqual(shadow.id, target.id)

  const identity = resolveEvolutionModelIdentity({
    userId,
    providerId: target.id,
    modelName: 'evolution-uuid-model',
  })
  assert.equal(identity.providerId, target.id)
  assert.equal(identity.runtimeProviderId, target.key)
  assert.equal(identity.configRevision, target.configRevision)
})
