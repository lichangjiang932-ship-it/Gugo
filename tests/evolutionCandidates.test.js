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
const { appendEvolutionFeedback } = await import('../server/services/evolutionEvidenceStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let modelCall = async () => ({ content: '{}', modelName: 'test-model' })
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
  assert.equal(candidate.provenance.generatorModel, 'provider/model-v1')
  assert.equal(candidate.provenance.generatorMode, 'background_model_no_tools')
  assert.deepEqual(candidate.permissionsRequested, ['tool:read_file'])
  assert.doesNotMatch(JSON.stringify(candidate), /generated-secret|owner@example|C:\\Users/iu)
  assert.match(candidate.content, /\[REDACTED\]/)
  assert.match(candidate.content, /\[LOCAL_PATH\]/)
  assert.equal(candidate.contentSha256, createHash('sha256').update(candidate.content).digest('hex'))

  assert.equal(Object.hasOwn(captured, 'tools'), false)
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
  modelCall = async () => ({ modelName: 'model-v2', content: 'not json' })
  const invalidOutput = await generate(session.token, dataset)
  assert.equal(invalidOutput.status, 502)
  assert.equal((await invalidOutput.json()).error.code, 'EVOLUTION_CANDIDATE_OUTPUT_INVALID')

  const invalidTarget = await generate(session.token, dataset, { target: 'prompt:wrong-kind' })
  assert.equal(invalidTarget.status, 400)
  assert.equal((await invalidTarget.json()).error.code, 'EVOLUTION_CANDIDATE_TARGET_INVALID')

  const invalidLimit = await fetch(`${origin}/api/evolution/candidates?limit=101`, {
    headers: headers(session.token),
  })
  assert.equal(invalidLimit.status, 400)
  assert.equal((await invalidLimit.json()).error.code, 'EVOLUTION_CANDIDATE_LIMIT_INVALID')
})
