import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-replay-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { evolutionReplayFingerprintResults } = await import('../server/services/evolutionReplayService.js')
const { upsertModelProvider } = await import('../server/services/modelProviderStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let candidateModel = async () => ({ content: '{}', providerId: 'candidate-provider', modelName: 'candidate-model' })
let replayModel = async () => ({ content: 'output', providerId: 'replay-provider', modelName: 'replay-model' })
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  runCandidateModel: (input) => candidateModel(input),
  runReplayModel: (input) => replayModel(input),
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test('Replay identity excludes optional Provider cost telemetry', () => {
  const lowCost = [{
    caseId: 'case:1',
    baseline: { output: 'baseline', durationMs: 10, costUsd: 0.01 },
    candidate: { output: 'candidate', durationMs: 9, costUsd: 0.02 },
  }]
  const highCost = [{
    caseId: 'case:1',
    baseline: { output: 'baseline', durationMs: 10, costUsd: 100 },
    candidate: { output: 'candidate', durationMs: 9, costUsd: 200 },
  }]
  assert.deepEqual(
    evolutionReplayFingerprintResults(lowCost),
    evolutionReplayFingerprintResults(highCost),
  )
  assert.equal(lowCost[0].baseline.costUsd, 0.01, 'telemetry record remains unchanged')
})

function headers(token, json = false) {
  return { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }
}

async function request(token, pathname, { method = 'GET', body } = {}) {
  return fetch(`${origin}${pathname}`, {
    method,
    headers: headers(token, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function createCandidate(token, dataset, kind = 'prompt') {
  candidateModel = async () => ({
    providerId: 'candidate-provider',
    modelName: 'candidate-model',
    content: JSON.stringify({
      title: `${kind} proposal`,
      summary: 'Replay proposal',
      content: `${kind} candidate instructions`,
      assumptions: [],
      expectedImpact: [],
      permissionsRequested: [],
    }),
  })
  const response = await request(token, '/api/evolution/candidates/generate', {
    method: 'POST',
    body: {
      kind,
      target: `${kind}:replay-target`,
      objective: 'Create replay proposal',
      datasetFingerprint: dataset.datasetFingerprint,
      sourceRecordIds: [dataset.records[0].id],
      providerId: 'candidate-provider',
      modelName: 'candidate-model',
    },
  })
  assert.equal(response.status, 201)
  return (await response.json()).candidate
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('isolated replay runs baseline and prompt candidate with identical no-tool model parameters', async () => {
  const alice = issueTestSession({ email: 'replay-alice@example.com' })
  const bob = issueTestSession({ email: 'replay-bob@example.com' })
  const feedback = await request(alice.token, '/api/evolution/feedback', {
    method: 'POST',
    body: { feedback: 'Verification test fails repeatedly' },
  })
  assert.equal(feedback.status, 201)
  const datasetResponse = await request(alice.token, '/api/evolution/dataset?limit=200')
  const dataset = (await datasetResponse.json()).dataset
  const candidate = await createCandidate(alice.token, dataset)

  const suiteResponse = await request(alice.token, '/api/evolution/replay-suites', {
    method: 'POST',
    body: {
      name: 'token=suite-secret replay suite',
      datasetFingerprint: dataset.datasetFingerprint,
      cases: [{
        sourceRecordId: dataset.records[0].id,
        title: 'Case for owner@example.com',
        input: 'token=case-secret inspect C:\\Users\\Owner\\file.txt without tools',
      }],
    },
  })
  assert.equal(suiteResponse.status, 201)
  const suite = (await suiteResponse.json()).suite
  assert.match(suite.name, /\[REDACTED\]/)
  assert.match(suite.cases[0].title, /\[EMAIL\]/)
  assert.match(suite.cases[0].input, /\[LOCAL_PATH\]/)
  assert.doesNotMatch(JSON.stringify(suite), /suite-secret|case-secret|owner@example|C:\\Users/iu)

  const calls = []
  replayModel = async (input) => {
    calls.push(input)
    return {
      providerId: 'replay-provider',
      modelName: 'fixed-model-v1',
      content: `token=result-secret output ${calls.length} C:\\Users\\Model\\result.txt`,
    }
  }
  const replayResponse = await request(alice.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: candidate.id,
      baselineContent: 'token=baseline-secret baseline instructions',
      providerId: 'replay-provider',
      modelName: 'fixed-model-v1',
      parameters: { temperature: 0, maxTokens: 512 },
    },
  })
  assert.equal(replayResponse.status, 201)
  assert.equal(replayResponse.headers.get('cache-control'), 'no-store')
  const replay = (await replayResponse.json()).replay
  assert.equal(replay.state, 'completed')
  assert.equal(replay.isolationMode, 'model_no_tools')
  assert.deepEqual(replay.parameters, { temperature: 0, maxTokens: 512 })
  assert.equal(replay.providerId, 'replay-provider')
  assert.equal(replay.modelName, 'fixed-model-v1')
  assert.equal(replay.results.length, 1)
  assert.equal(Object.hasOwn(replay, 'verdict'), false)
  assert.match(replay.runFingerprint, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(replay), /result-secret|baseline-secret|C:\\Users/iu)
  assert.match(replay.results[0].baseline.output, /\[REDACTED\]/)
  assert.match(replay.results[0].candidate.output, /\[LOCAL_PATH\]/)

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(Object.hasOwn(call, 'tools'), false)
    assert.equal(call.providerId, 'replay-provider')
    assert.equal(call.modelName, 'fixed-model-v1')
    assert.deepEqual(call.parameters, { temperature: 0, maxTokens: 512 })
    assert.doesNotMatch(JSON.stringify(call.messages), /case-secret|baseline-secret|C:\\Users/iu)
    assert.match(JSON.stringify(call.messages), /No tools are available/)
  }
  assert.notEqual(calls[0].messages[1].content, calls[1].messages[1].content)
  assert.equal(calls[0].messages[2].content, calls[1].messages[2].content)

  const list = await request(alice.token, '/api/evolution/replays?limit=10')
  const listed = (await list.json()).replays
  assert.equal(listed.length, 1)
  assert.equal(Object.hasOwn(listed[0], 'results'), false)
  const crossUser = await request(bob.token, `/api/evolution/replays/${replay.id}`)
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'EVOLUTION_REPLAY_NOT_FOUND')

  const evaluation = await request(alice.token, `/api/evolution/replays/${replay.id}/evaluate`, {
    method: 'POST', body: {},
  })
  assert.equal(evaluation.status, 404)
})

test('replay fails closed for stale suites, non-prompt candidates, and model drift', async () => {
  const session = issueTestSession({ email: 'replay-validation@example.com' })
  await request(session.token, '/api/evolution/feedback', {
    method: 'POST', body: { feedback: 'Tool runtime failure' },
  })
  const dataset = (await (await request(session.token, '/api/evolution/dataset?limit=200')).json()).dataset
  const staleSuite = await request(session.token, '/api/evolution/replay-suites', {
    method: 'POST',
    body: {
      name: 'stale',
      datasetFingerprint: '0'.repeat(64),
      cases: [{ sourceRecordId: dataset.records[0].id, title: 'case', input: 'input' }],
    },
  })
  assert.equal(staleSuite.status, 409)
  assert.equal((await staleSuite.json()).error.code, 'EVOLUTION_DATASET_STALE')

  const suite = (await (await request(session.token, '/api/evolution/replay-suites', {
    method: 'POST',
    body: {
      name: 'fixed suite',
      datasetFingerprint: dataset.datasetFingerprint,
      cases: [{ sourceRecordId: dataset.records[0].id, title: 'case', input: 'input' }],
    },
  })).json()).suite
  const plugin = await createCandidate(session.token, dataset, 'plugin')
  let replayCalls = 0
  replayModel = async () => {
    replayCalls += 1
    return { providerId: 'replay-provider', modelName: 'fixed-model', content: 'output' }
  }
  const unsupported = await request(session.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: plugin.id,
      baselineContent: 'baseline',
      providerId: 'replay-provider',
      modelName: 'fixed-model',
      parameters: { temperature: 0, maxTokens: 256 },
    },
  })
  assert.equal(unsupported.status, 409)
  assert.equal((await unsupported.json()).error.code, 'EVOLUTION_REPLAY_KIND_UNSUPPORTED')
  assert.equal(replayCalls, 0)

  const prompt = await createCandidate(session.token, dataset, 'prompt')
  replayModel = async () => ({ providerId: 'different-provider', modelName: 'fixed-model', content: 'output' })
  const drift = await request(session.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: prompt.id,
      baselineContent: 'baseline',
      providerId: 'replay-provider',
      modelName: 'fixed-model',
      parameters: { temperature: 0, maxTokens: 256 },
    },
  })
  assert.equal(drift.status, 502)
  assert.equal((await drift.json()).error.code, 'EVOLUTION_REPLAY_MODEL_MISMATCH')
  const runs = await request(session.token, '/api/evolution/replays')
  assert.deepEqual((await runs.json()).replays, [])
})

test('replay keeps one Provider snapshot and fails atomically when its revision changes mid-run', async () => {
  const session = issueTestSession({ email: 'replay-revision-drift@example.com' })
  await request(session.token, '/api/evolution/feedback', {
    method: 'POST', body: { feedback: 'Replay must never mix Provider revisions' },
  })
  const dataset = (await (await request(session.token, '/api/evolution/dataset?limit=200')).json()).dataset
  const suite = (await (await request(session.token, '/api/evolution/replay-suites', {
    method: 'POST',
    body: {
      name: 'revision drift suite',
      datasetFingerprint: dataset.datasetFingerprint,
      cases: [{ sourceRecordId: dataset.records[0].id, title: 'case', input: 'input' }],
    },
  })).json()).suite
  const candidate = await createCandidate(session.token, dataset, 'prompt')
  const provider = upsertModelProvider({
    userId: session.userId,
    provider: {
      key: 'replayrevision',
      label: 'Replay revision',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'revision-one',
      models: ['revision-model'],
      defaultModel: 'revision-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  const snapshots = []
  replayModel = async (input) => {
    snapshots.push({
      runtimeEnv: input.runtimeEnv,
      configRevision: input.configRevision,
      runtimeProviderId: input.runtimeProviderId,
    })
    if (snapshots.length === 1) {
      upsertModelProvider({
        userId: session.userId,
        provider: {
          ...provider,
          baseUrl: 'http://127.0.0.1:11435/v1',
          apiKey: 'revision-two',
        },
      })
    }
    return { providerId: provider.id, modelName: 'revision-model', content: `output-${snapshots.length}` }
  }

  const response = await request(session.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: candidate.id,
      baselineContent: 'baseline',
      providerId: provider.id,
      modelName: 'revision-model',
      parameters: { temperature: 0, maxTokens: 256 },
    },
  })

  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'EVOLUTION_MODEL_PROVIDER_CONFIG_CHANGED')
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0].runtimeEnv, snapshots[1].runtimeEnv)
  assert.equal(snapshots[0].configRevision, provider.configRevision)
  assert.equal(snapshots[1].configRevision, provider.configRevision)
  assert.equal(snapshots[0].runtimeProviderId, provider.key)
  assert.equal(snapshots[1].runtimeProviderId, provider.key)
  assert.equal(snapshots[0].runtimeEnv.MODEL_API_KEY, 'revision-one')
  const runs = await request(session.token, '/api/evolution/replays')
  assert.deepEqual((await runs.json()).replays, [])
})
