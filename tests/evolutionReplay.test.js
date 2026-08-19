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
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let candidateModel = async () => ({ content: '{}', modelName: 'candidate-model' })
let replayModel = async () => ({ content: 'output', modelName: 'replay-model' })
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  runCandidateModel: (input) => candidateModel(input),
  runReplayModel: (input) => replayModel(input),
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

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
    return { modelName: 'fixed-model', content: 'output' }
  }
  const unsupported = await request(session.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: plugin.id,
      baselineContent: 'baseline',
      modelName: 'fixed-model',
      parameters: { temperature: 0, maxTokens: 256 },
    },
  })
  assert.equal(unsupported.status, 409)
  assert.equal((await unsupported.json()).error.code, 'EVOLUTION_REPLAY_KIND_UNSUPPORTED')
  assert.equal(replayCalls, 0)

  const prompt = await createCandidate(session.token, dataset, 'prompt')
  replayModel = async () => ({ modelName: 'different-model', content: 'output' })
  const drift = await request(session.token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: prompt.id,
      baselineContent: 'baseline',
      modelName: 'fixed-model',
      parameters: { temperature: 0, maxTokens: 256 },
    },
  })
  assert.equal(drift.status, 502)
  assert.equal((await drift.json()).error.code, 'EVOLUTION_REPLAY_MODEL_MISMATCH')
  const runs = await request(session.token, '/api/evolution/replays')
  assert.deepEqual((await runs.json()).replays, [])
})
