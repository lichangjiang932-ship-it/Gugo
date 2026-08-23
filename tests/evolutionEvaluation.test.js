import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-evaluation-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { evolutionEvaluationDecisionMetrics } = await import('../server/services/evolutionEvaluationService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
let evaluatorProviderId = 'evaluator-provider'
let evaluatorModelName = 'independent-evaluator'
let candidateModel = async () => ({ content: '{}', providerId: 'candidate-provider', modelName: 'candidate-model' })
let replayModel = async () => ({ content: 'output', providerId: 'replay-provider', modelName: 'fixed-worker' })
let evaluationModel = async () => ({ content: '{}', providerId: evaluatorProviderId, modelName: evaluatorModelName })
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  evaluatorProviderId,
  evaluatorModelName,
  runCandidateModel: (input) => candidateModel(input),
  runReplayModel: (input) => replayModel(input),
  runEvaluationModel: (input) => evaluationModel(input),
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test('Evaluation identity excludes optional Provider cost telemetry', () => {
  const metrics = {
    quality: { improvements: 1, regressions: 0 },
    safety: { regressions: 0, unknown: 0 },
    latency: { ratio: 1 },
    cost: { baselineUsd: 0.01, candidateUsd: 999, decisionRole: 'telemetry_only' },
  }
  const projected = evolutionEvaluationDecisionMetrics(metrics)
  assert.equal(Object.hasOwn(projected, 'cost'), false)
  assert.equal(metrics.cost.candidateUsd, 999, 'telemetry record remains unchanged')
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

async function createReplay(token, {
  withUsage = true,
  withCost = withUsage,
  permissionsRequested = [],
} = {}) {
  const feedback = await request(token, '/api/evolution/feedback', {
    method: 'POST',
    body: { feedback: 'Verification quality regression' },
  })
  assert.equal(feedback.status, 201)
  const dataset = (await (await request(token, '/api/evolution/dataset?limit=200')).json()).dataset
  candidateModel = async () => ({
    providerId: 'candidate-provider',
    modelName: 'candidate-model',
    content: JSON.stringify({
      title: 'Prompt candidate',
      summary: 'Improve verification quality',
      content: 'Candidate system instructions',
      assumptions: [],
      expectedImpact: ['Improve quality'],
      permissionsRequested,
    }),
  })
  const candidateResponse = await request(token, '/api/evolution/candidates/generate', {
    method: 'POST',
    body: {
      kind: 'prompt',
      target: 'prompt:evaluation-target',
      objective: 'Improve replay result',
      datasetFingerprint: dataset.datasetFingerprint,
      sourceRecordIds: [dataset.records[0].id],
      providerId: 'candidate-provider',
      modelName: 'candidate-model',
    },
  })
  assert.equal(candidateResponse.status, 201)
  const candidate = (await candidateResponse.json()).candidate
  const suiteResponse = await request(token, '/api/evolution/replay-suites', {
    method: 'POST',
    body: {
      name: 'Evaluation suite',
      datasetFingerprint: dataset.datasetFingerprint,
      cases: [{
        sourceRecordId: dataset.records[0].id,
        title: 'Verification case',
        input: 'token=case-secret explain a safe verification result',
      }],
    },
  })
  assert.equal(suiteResponse.status, 201)
  const suite = (await suiteResponse.json()).suite
  let calls = 0
  replayModel = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, calls % 2 === 1 ? 20 : 2))
    return {
      providerId: 'replay-provider',
      modelName: 'fixed-worker',
      content: calls % 2 === 1
        ? 'token=baseline-result incomplete answer'
        : 'token=candidate-result complete safe answer',
      ...(withUsage ? {
        usage: calls % 2 === 1
          ? { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
          : { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
        ...(withCost ? { costUsd: calls % 2 === 1 ? 0.1 : 0.09 } : {}),
      } : {}),
    }
  }
  const replayResponse = await request(token, '/api/evolution/replays/run', {
    method: 'POST',
    body: {
      suiteId: suite.id,
      candidateId: candidate.id,
      baselineContent: 'Baseline system instructions',
      providerId: 'replay-provider',
      modelName: 'fixed-worker',
      parameters: { temperature: 0, maxTokens: 512 },
    },
  })
  assert.equal(replayResponse.status, 201)
  return { candidate, suite, replay: (await replayResponse.json()).replay }
}

function evaluatorResponse(input, {
  baselineScore = 2,
  candidateScore = 3,
  safety = 'pass',
  evidence = ['candidate is more complete for the supplied case'],
  issues = [],
} = {}) {
  const payload = JSON.parse(input.messages[1].content)
  return {
    providerId: evaluatorProviderId,
    modelName: evaluatorModelName,
    content: JSON.stringify({
      verdict: 'fail',
      summary: 'token=evaluator-secret independent comparison',
      cases: [{
        caseId: payload.cases[0].caseId,
        baselineScore,
        candidateScore,
        safety,
        evidence,
        issues,
      }],
    }),
  }
}

async function evaluate(token, replayId) {
  return request(token, '/api/evolution/evaluations', {
    method: 'POST',
    body: { replayId, evaluatorProviderId, evaluatorModelName },
  })
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('independent evaluation computes a host verdict from quality, safety, latency, and cost evidence', async () => {
  const alice = issueTestSession({ email: 'evaluation-alice@example.com' })
  const bob = issueTestSession({ email: 'evaluation-bob@example.com' })
  const { replay } = await createReplay(alice.token)
  let captured
  evaluationModel = async (input) => {
    captured = input
    return evaluatorResponse(input)
  }
  const response = await evaluate(alice.token, replay.id)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const evaluation = (await response.json()).evaluation
  assert.equal(evaluation.verdict, 'pass')
  assert.deepEqual(evaluation.evaluator, {
    providerId: 'evaluator-provider',
    modelName: 'independent-evaluator',
    independent: true,
  })
  assert.equal(evaluation.metrics.quality.improvements, 1)
  assert.equal(evaluation.metrics.quality.regressions, 0)
  assert.equal(evaluation.metrics.safety.regressions, 0)
  assert.equal(evaluation.metrics.cost.evidence, 'measured')
  assert.equal(evaluation.metrics.cost.ratio, 0.9)
  assert.ok(evaluation.metrics.latency.ratio <= 1.5)
  assert.match(evaluation.evaluationFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(evaluation.caseAssessments[0].evidence.length, 1)
  assert.doesNotMatch(JSON.stringify(evaluation), /evaluator-secret|baseline-result|candidate-result|case-secret/iu)
  assert.match(evaluation.summary, /\[REDACTED\]/)

  assert.equal(captured.providerId, 'evaluator-provider')
  assert.equal(captured.modelName, 'independent-evaluator')
  assert.equal(Object.hasOwn(captured, 'tools'), false)
  const evaluatorInput = JSON.stringify(captured.messages)
  assert.doesNotMatch(evaluatorInput, /baseline-result|candidate-result|case-secret/iu)
  assert.match(evaluatorInput, /\[REDACTED\]/)
  assert.match(evaluatorInput, /Do not announce an aggregate verdict/)

  const list = await request(alice.token, '/api/evolution/evaluations?limit=10')
  const listed = (await list.json()).evaluations
  assert.equal(listed.length, 1)
  assert.equal(Object.hasOwn(listed[0], 'caseAssessments'), false)
  const crossUser = await request(bob.token, `/api/evolution/evaluations/${evaluation.id}`)
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'EVOLUTION_EVALUATION_NOT_FOUND')
  const approve = await request(alice.token, `/api/evolution/evaluations/${evaluation.id}/approve`, {
    method: 'POST', body: {},
  })
  assert.equal(approve.status, 404)
})

test('evaluation treats missing provider cost as optional and still fails on a safety regression', async () => {
  const session = issueTestSession({ email: 'evaluation-policy@example.com' })
  const { replay } = await createReplay(session.token, { withUsage: false })
  evaluationModel = async (input) => evaluatorResponse(input)
  const incomplete = await evaluate(session.token, replay.id)
  assert.equal(incomplete.status, 201)
  const incompleteEvaluation = (await incomplete.json()).evaluation
  assert.equal(incompleteEvaluation.verdict, 'pass')
  assert.equal(incompleteEvaluation.metrics.cost.evidence, 'missing')
  assert.equal(incompleteEvaluation.issues.includes('cost_evidence_missing'), false)

  evaluationModel = async (input) => evaluatorResponse(input, {
    baselineScore: 3,
    candidateScore: 4,
    safety: 'fail',
    issues: ['candidate exposes unsafe behavior'],
  })
  const unsafe = await evaluate(session.token, replay.id)
  assert.equal(unsafe.status, 201)
  const unsafeEvaluation = (await unsafe.json()).evaluation
  assert.equal(unsafeEvaluation.verdict, 'fail')
  assert.ok(unsafeEvaluation.issues.includes('safety_regression'))
})

test('evaluation fails closed when independence or case evidence cannot be proven', async () => {
  const session = issueTestSession({ email: 'evaluation-validation@example.com' })
  const { replay } = await createReplay(session.token)
  evaluatorProviderId = 'replay-provider'
  evaluatorModelName = 'fixed-worker'
  let calls = 0
  evaluationModel = async (input) => {
    calls += 1
    return evaluatorResponse(input)
  }
  const sameModel = await evaluate(session.token, replay.id)
  assert.equal(sameModel.status, 409)
  assert.equal((await sameModel.json()).error.code, 'EVOLUTION_EVALUATOR_NOT_INDEPENDENT')
  assert.equal(calls, 0)

  evaluatorProviderId = 'different-provider'
  evaluationModel = async (input) => evaluatorResponse(input)
  const sameNameDifferentProvider = await evaluate(session.token, replay.id)
  assert.equal(sameNameDifferentProvider.status, 201)
  assert.deepEqual((await sameNameDifferentProvider.json()).evaluation.evaluator, {
    providerId: 'different-provider',
    modelName: 'fixed-worker',
    independent: true,
  })

  evaluatorProviderId = 'evaluator-provider'
  evaluatorModelName = 'independent-evaluator'
  evaluationModel = async (input) => evaluatorResponse(input, { evidence: [] })
  const missingEvidence = await evaluate(session.token, replay.id)
  assert.equal(missingEvidence.status, 502)
  assert.equal((await missingEvidence.json()).error.code, 'EVOLUTION_EVALUATOR_OUTPUT_INVALID')
  const list = await request(session.token, '/api/evolution/evaluations')
  assert.equal((await list.json()).evaluations.length, 1)

  const historical = issueTestSession({ email: 'evaluation-historical@example.com' })
  const { replay: historicalReplay } = await createReplay(historical.token)
  getDb().prepare('UPDATE evolution_replay_runs SET model_provider_id = NULL WHERE id = ?')
    .run(historicalReplay.id)
  calls = 0
  evaluationModel = async (input) => {
    calls += 1
    return evaluatorResponse(input)
  }
  const unknownProvider = await evaluate(historical.token, historicalReplay.id)
  assert.equal(unknownProvider.status, 409)
  assert.equal((await unknownProvider.json()).error.code, 'EVOLUTION_REPLAY_PROVIDER_UNKNOWN')
  assert.equal(calls, 0)
})

test('usage without a measured replay cost remains optional missing evidence instead of measured zero', async () => {
  const session = issueTestSession({ email: 'evaluation-null-cost@example.com' })
  const { replay } = await createReplay(session.token, { withUsage: true, withCost: false })
  assert.ok(replay.results[0].baseline.usage)
  assert.equal(replay.results[0].baseline.costUsd, null)
  assert.equal(replay.results[0].candidate.costUsd, null)

  evaluationModel = async (input) => evaluatorResponse(input)
  const response = await evaluate(session.token, replay.id)
  assert.equal(response.status, 201)
  const evaluation = (await response.json()).evaluation
  assert.equal(evaluation.verdict, 'pass')
  assert.deepEqual(evaluation.metrics.cost, {
    baselineUsd: null,
    candidateUsd: null,
    ratio: null,
    evidence: 'missing',
    decisionRole: 'telemetry_only',
  })
  assert.equal(evaluation.issues.includes('cost_evidence_missing'), false)
})
