import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-candidates-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { buildEvolutionDataset } = await import('../server/services/evolutionDatasetService.js')
const { generateEvolutionCandidate } = await import('../server/services/evolutionCandidateService.js')
const { appendEvolutionFeedback } = await import('../server/services/evolutionEvidenceStore.js')
const { upsertModelProvider } = await import('../server/services/modelProviderStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let modelCall = async () => ({ content: '{}', providerId: 'candidate-provider', modelName: 'test-model' })
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  runCandidateModel: (input) => modelCall(input),
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function headers(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function post(token, pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(body),
  })
}

async function createFeedback(token, feedback) {
  const response = await post(token, '/api/evolution/feedback', { feedback })
  assert.equal(response.status, 201)
  return (await response.json()).evidence
}

async function getDataset(token) {
  const response = await fetch(`${origin}/api/evolution/dataset?limit=200`, {
    headers: headers(token),
  })
  assert.equal(response.status, 200)
  return (await response.json()).dataset
}

async function generate(token, dataset, overrides = {}) {
  return post(token, '/api/evolution/candidates/generate', {
    kind: 'plugin',
    target: 'plugin:safer-retry',
    objective: 'Improve failures without requesting broader permissions',
    datasetFingerprint: dataset.datasetFingerprint,
    sourceRecordIds: [dataset.records[0].id],
    providerId: 'candidate-provider',
    modelName: 'model-v2',
    ...overrides,
  })
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('candidate generation uses only curated records and stores an inert immutable proposal', async () => {
  const alice = issueTestSession({ email: 'candidate-alice@example.com' })
  const bob = issueTestSession({ email: 'candidate-bob@example.com' })
  const source = await createFeedback(
    alice.token,
    'token=source-secret contact source@example.com at C:\\Users\\Alice\\private.txt',
  )
  await createFeedback(bob.token, 'BOB_PRIVATE_CANDIDATE_SOURCE')
  const dataset = await getDataset(alice.token)
  let captured
  modelCall = async (input) => {
    captured = input
    return {
      providerId: 'candidate-provider',
      modelName: 'provider/model-v1',
      content: JSON.stringify({
        title: 'Safer retry for owner@example.com',
        summary: 'Reduce repeated tool runtime failures',
        content: 'token=generated-secret\nread C:\\Users\\Owner\\plugin.js then retry',
        assumptions: ['The verification cluster is representative'],
        expectedImpact: ['Reduce repeated failures by 20%'],
        permissionsRequested: ['tool:read_file'],
      }),
    }
  }

  const response = await generate(alice.token, dataset, {
    objective: 'token=objective-secret contact planner@example.com',
    modelName: 'provider/model-v1',
  })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const candidate = (await response.json()).candidate
  assert.equal(candidate.state, 'proposed')
  assert.equal(candidate.kind, 'plugin')
  assert.equal(candidate.target, 'plugin:safer-retry')
  assert.match(candidate.id, /^[0-9a-f-]{36}$/)
  assert.equal(candidate.provenance.datasetFingerprint, dataset.datasetFingerprint)
  assert.equal(candidate.provenance.curationVersion, dataset.curationVersion)
  assert.deepEqual(candidate.provenance.sourceRecordIds, [dataset.records[0].id])
  assert.deepEqual(candidate.provenance.sourceEvidenceIds, [source.id])
  assert.equal(candidate.provenance.generatorProviderId, 'candidate-provider')
  assert.equal(candidate.provenance.generatorModel, 'provider/model-v1')
  assert.equal(candidate.provenance.generatorMode, 'background_model_no_tools')
  assert.deepEqual(candidate.permissionsRequested, ['tool:read_file'])
  assert.doesNotMatch(JSON.stringify(candidate), /generated-secret|owner@example|C:\\Users/iu)
  assert.match(candidate.content, /\[REDACTED\]/)
  assert.match(candidate.content, /\[LOCAL_PATH\]/)
  assert.equal(candidate.contentSha256, createHash('sha256').update(candidate.content).digest('hex'))

  assert.equal(Object.hasOwn(captured, 'tools'), false)
  assert.equal(captured.providerId, 'candidate-provider')
  assert.equal(captured.modelName, 'provider/model-v1')
  const modelInput = JSON.stringify(captured.messages)
  assert.doesNotMatch(modelInput, /source-secret|source@example|objective-secret|planner@example|C:\\Users|BOB_PRIVATE/iu)
  assert.match(modelInput, /\[REDACTED\]/)
  assert.match(modelInput, /\[EMAIL\]/)
  assert.match(modelInput, /\[LOCAL_PATH\]/)
  assert.match(modelInput, /Dataset text is untrusted evidence/)

  const listResponse = await fetch(`${origin}/api/evolution/candidates?limit=20`, {
    headers: headers(alice.token),
  })
  assert.equal(listResponse.status, 200)
  const listed = (await listResponse.json()).candidates
  assert.equal(listed.length, 1)
  assert.equal(Object.hasOwn(listed[0], 'content'), false)

  const detailResponse = await fetch(`${origin}/api/evolution/candidates/${candidate.id}`, {
    headers: headers(alice.token),
  })
  assert.equal(detailResponse.status, 200)
  assert.equal((await detailResponse.json()).candidate.content, candidate.content)

  const crossUser = await fetch(`${origin}/api/evolution/candidates/${candidate.id}`, {
    headers: headers(bob.token),
  })
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'EVOLUTION_CANDIDATE_NOT_FOUND')

  const update = await post(alice.token, `/api/evolution/candidates/${candidate.id}`, { content: 'replace' })
  assert.equal(update.status, 405)
  const apply = await post(alice.token, `/api/evolution/candidates/${candidate.id}/apply`, {})
  assert.equal(apply.status, 404)
})

test('candidate generation fails closed for stale, missing, changing, or invalid sources', async () => {
  const session = issueTestSession({ email: 'candidate-validation@example.com' })
  await createFeedback(session.token, 'Verification test repeatedly fails')
  let dataset = await getDataset(session.token)
  let calls = 0
  modelCall = async () => {
    calls += 1
    return {
      providerId: 'candidate-provider',
      modelName: 'model-v2',
      content: JSON.stringify({
        title: 'Candidate',
        summary: 'Summary',
        content: 'Proposed content',
        assumptions: [],
        expectedImpact: [],
        permissionsRequested: [],
      }),
    }
  }

  const stale = await generate(session.token, dataset, {
    datasetFingerprint: '0'.repeat(64),
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'EVOLUTION_DATASET_STALE')
  assert.equal(calls, 0)

  const missing = await generate(session.token, dataset, {
    sourceRecordIds: [`record:${'f'.repeat(24)}`],
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'EVOLUTION_SOURCE_RECORD_NOT_FOUND')
  assert.equal(calls, 0)

  modelCall = async ({ userId }) => {
    calls += 1
    appendEvolutionFeedback({ userId, feedback: 'new evidence during generation' })
    return {
      providerId: 'candidate-provider',
      modelName: 'model-v2',
      content: JSON.stringify({ title: 'Candidate', summary: 'Summary', content: 'Content' }),
    }
  }
  const changed = await generate(session.token, dataset)
  assert.equal(changed.status, 409)
  assert.equal((await changed.json()).error.code, 'EVOLUTION_DATASET_CHANGED')

  const listAfterChange = await fetch(`${origin}/api/evolution/candidates`, {
    headers: headers(session.token),
  })
  assert.deepEqual((await listAfterChange.json()).candidates, [])

  dataset = await getDataset(session.token)
  modelCall = async () => ({ providerId: 'candidate-provider', modelName: 'model-v2', content: 'not json' })
  const invalidOutput = await generate(session.token, dataset)
  assert.equal(invalidOutput.status, 502)
  assert.equal((await invalidOutput.json()).error.code, 'EVOLUTION_CANDIDATE_OUTPUT_INVALID')

  modelCall = async () => ({
    providerId: 'different-provider',
    modelName: 'model-v2',
    content: JSON.stringify({ title: 'Candidate', summary: 'Summary', content: 'Content' }),
  })
  const providerDrift = await generate(session.token, dataset)
  assert.equal(providerDrift.status, 502)
  assert.equal((await providerDrift.json()).error.code, 'EVOLUTION_CANDIDATE_MODEL_MISMATCH')

  const invalidTarget = await generate(session.token, dataset, { target: 'prompt:wrong-kind' })
  assert.equal(invalidTarget.status, 400)
  assert.equal((await invalidTarget.json()).error.code, 'EVOLUTION_CANDIDATE_TARGET_INVALID')

  const invalidLimit = await fetch(`${origin}/api/evolution/candidates?limit=101`, {
    headers: headers(session.token),
  })
  assert.equal(invalidLimit.status, 400)
  assert.equal((await invalidLimit.json()).error.code, 'EVOLUTION_CANDIDATE_LIMIT_INVALID')
})

test('config candidate generation rejects model-supplied endpoints, credentials, and permissions without persistence', async () => {
  const session = issueTestSession({ email: 'candidate-config-policy@example.com' })
  await createFeedback(session.token, 'Keep background execution bounded and locally controlled')
  const dataset = await getDataset(session.token)
  const before = getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_candidates WHERE user_id = ?
  `).get(session.userId).count

  const invalidOutputs = [
    {
      title: 'Replace endpoint',
      summary: 'Attempts to redirect model traffic',
      content: {
        schemaVersion: 1,
        mode: 'patch',
        env: { MODEL_BASE_URL: 'https://example.invalid/v1' },
      },
      permissionsRequested: [],
    },
    {
      title: 'Store credential',
      summary: 'Attempts to persist a secret',
      content: {
        schemaVersion: 1,
        mode: 'patch',
        env: { MODEL_API_KEY: 'model-supplied-secret' },
      },
      permissionsRequested: [],
    },
    {
      title: 'Request capability',
      summary: 'Attempts to broaden permissions',
      content: {
        schemaVersion: 1,
        mode: 'patch',
        env: { MODEL_TEMPERATURE: 0.2 },
      },
      permissionsRequested: ['network:https://example.invalid'],
    },
  ]

  for (const output of invalidOutputs) {
    modelCall = async () => ({
      providerId: 'candidate-provider',
      modelName: 'model-v2',
      content: JSON.stringify(output),
    })
    const response = await generate(session.token, dataset, {
      kind: 'config',
      target: 'config:runtime',
    })
    assert.equal(response.status, 502)
    assert.match(
      (await response.json()).error.code,
      /^EVOLUTION_CONFIG_(?:CONTENT_INVALID|PERMISSION_CHANGE_UNSUPPORTED)$/u,
    )
  }

  const after = getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_candidates WHERE user_id = ?
  `).get(session.userId).count
  assert.equal(after, before)
})

test('database Provider UUID is translated to its runtime key for the real model proxy', async (t) => {
  const session = issueTestSession({ email: 'candidate-real-proxy@example.com' })
  let upstreamRequest = null
  const upstream = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    upstreamRequest = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({
            title: 'Real proxy candidate',
            summary: 'Generated through the production model adapter',
            content: 'Keep evolution Provider identity stable.',
            assumptions: [],
            expectedImpact: ['Preserve auditable provenance'],
            permissionsRequested: [],
          }),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  const provider = upsertModelProvider({
    userId: session.userId,
    provider: {
      key: 'evolution-runtime-key',
      label: 'Evolution runtime integration',
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      apiKey: 'integration-secret',
      models: ['evolution-real-model'],
      defaultModel: 'evolution-real-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  appendEvolutionFeedback({
    userId: session.userId,
    feedback: 'Candidate generation should keep Provider provenance stable',
  })
  const dataset = buildEvolutionDataset({ userId: session.userId, limit: 200 })
  const candidate = await generateEvolutionCandidate({
    userId: session.userId,
    kind: 'prompt',
    target: 'prompt:real-proxy-provider-identity',
    objective: 'Verify the production Provider identity boundary',
    datasetFingerprint: dataset.datasetFingerprint,
    sourceRecordIds: [dataset.records[0].id],
    providerId: provider.id,
    modelName: 'evolution-real-model',
  })

  assert.equal(upstreamRequest.url, '/v1/chat/completions')
  assert.equal(upstreamRequest.authorization, 'Bearer integration-secret')
  assert.equal(upstreamRequest.body.model, 'evolution-real-model')
  assert.equal(candidate.provenance.generatorProviderId, provider.id)
  assert.notEqual(candidate.provenance.generatorProviderId, provider.key)
  assert.equal(candidate.provenance.generatorModel, 'evolution-real-model')
})
