import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-approval-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { buildEvolutionApprovalReview } = await import('../server/services/evolutionApprovalService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const routeEnv = { AUTH_MODE: 'local', LOCAL_USER_ID: '' }
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, { env: routeEnv }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let sequence = 0

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

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

function seedReview(userId, { verdict = 'pass', permissionsRequested = [] } = {}) {
  sequence += 1
  const suffix = `${sequence}`
  const candidateId = `candidate-${suffix}`
  const suiteId = `suite-${suffix}`
  const replayId = `replay-${suffix}`
  const evaluationId = `evaluation-${suffix}`
  const candidateContent = `candidate prompt ${suffix}`
  const baselineContent = `baseline prompt ${suffix}`
  const candidateSha256 = sha256(candidateContent)
  const baselineSha256 = sha256(baselineContent)
  const replayRunFingerprint = sha256(`replay-${suffix}`)
  const evaluationFingerprint = sha256(`evaluation-${suffix}`)
  const db = getDb()
  db.prepare(`
    INSERT INTO evolution_candidates (
      id, user_id, kind, target, title, summary, content,
      assumptions_json, expected_impact_json, permissions_requested_json,
      dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
      generator_model, generator_mode, content_sha256, created_at
    ) VALUES (?, ?, 'prompt', 'prompt:system', 'Candidate', 'Candidate summary', ?,
      '[]', '[]', ?, ?, 'curation-v1', '[]', '[]',
      'generator-model', 'background_model_no_tools', ?, ?)
  `).run(
    candidateId,
    userId,
    candidateContent,
    JSON.stringify(permissionsRequested),
    sha256(`dataset-${suffix}`),
    candidateSha256,
    sequence,
  )
  db.prepare(`
    INSERT INTO evolution_replay_suites (
      id, user_id, name, dataset_fingerprint, curation_version,
      source_record_ids_json, cases_json, suite_fingerprint, created_at
    ) VALUES (?, ?, 'Suite', ?, 'curation-v1', '[]', '[]', ?, ?)
  `).run(suiteId, userId, sha256(`dataset-${suffix}`), sha256(`suite-${suffix}`), sequence)
  db.prepare(`
    INSERT INTO evolution_replay_runs (
      id, user_id, suite_id, candidate_id, baseline_content, baseline_sha256,
      candidate_sha256, model_name, temperature, max_tokens, isolation_mode,
      results_json, run_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'worker-model', 0, 512,
      'model_no_tools', '[]', ?, ?)
  `).run(
    replayId,
    userId,
    suiteId,
    candidateId,
    baselineContent,
    baselineSha256,
    candidateSha256,
    replayRunFingerprint,
    sequence,
  )
  db.prepare(`
    INSERT INTO evolution_evaluations (
      id, user_id, replay_id, candidate_id, rubric_version, evaluator_model,
      independent, verdict, summary, case_assessments_json, metrics_json,
      issues_json, evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, 'rubric-v1', 'independent-evaluator', 1, ?,
      'Evaluation summary', '[]', ?, '[]', ?, ?)
  `).run(
    evaluationId,
    userId,
    replayId,
    candidateId,
    verdict,
    JSON.stringify({ quality: { improvements: verdict === 'pass' ? 1 : 0 }, permissionReviewRequired: permissionsRequested.length > 0 }),
    evaluationFingerprint,
    sequence,
  )
  return {
    candidateId,
    replayId,
    evaluationId,
    candidateContent,
    baselineContent,
    confirmations: {
      candidateContentSha256: candidateSha256,
      replayRunFingerprint,
      evaluationFingerprint,
      rollbackBaselineSha256: baselineSha256,
    },
  }
}

async function decide(token, seeded, decision = 'approved', overrides = {}) {
  return request(token, '/api/evolution/approvals', {
    method: 'POST',
    body: {
      evaluationId: seeded.evaluationId,
      decision,
      reason: `${decision} after reviewing immutable evidence`,
      confirmations: seeded.confirmations,
      ...overrides,
    },
  })
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('approval review exposes immutable diff, provenance, permissions, and rollback target to the local owner', async () => {
  const owner = issueTestSession({ email: 'approval-owner@example.com' })
  const other = issueTestSession({ email: 'approval-other@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const seeded = seedReview(owner.userId)

  const unauthorized = await fetch(`${origin}/api/evolution/approval-reviews/${seeded.evaluationId}`)
  assert.equal(unauthorized.status, 401)
  const forbidden = await request(other.token, `/api/evolution/approval-reviews/${seeded.evaluationId}`)
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.json()).error.code, 'LOCAL_OWNER_ONLY')

  const response = await request(owner.token, `/api/evolution/approval-reviews/${seeded.evaluationId}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const review = (await response.json()).review
  assert.equal(review.diff.before, seeded.baselineContent)
  assert.equal(review.diff.after, seeded.candidateContent)
  assert.equal(review.candidate.provenance.generatorMode, 'background_model_no_tools')
  assert.equal(review.replay.isolationMode, 'model_no_tools')
  assert.equal(review.evaluation.evaluator.independent, true)
  assert.deepEqual(review.permissionChanges.requested, [])
  assert.deepEqual(review.confirmations, seeded.confirmations)
  assert.equal(review.rollbackTarget.contentSha256, seeded.confirmations.rollbackBaselineSha256)
  assert.equal(review.eligibility.canApprove, true)
  assert.equal(review.existingDecision, null)

  assert.throws(
    () => buildEvolutionApprovalReview({ userId: other.userId, evaluationId: seeded.evaluationId }),
    (error) => error.code === 'EVOLUTION_EVALUATION_NOT_FOUND',
  )
})

test('local owner can record one explicit approval without applying or installing the candidate', async () => {
  const owner = issueTestSession({ email: 'approval-decision@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const seeded = seedReview(owner.userId)
  const response = await decide(owner.token, seeded)
  assert.equal(response.status, 201)
  const approval = (await response.json()).approval
  assert.equal(approval.decision, 'approved')
  assert.equal(approval.approverMode, 'local_owner_loopback')
  assert.deepEqual(approval.confirmations, seeded.confirmations)
  assert.equal(approval.reviewSnapshot.evaluation.verdict, 'pass')
  assert.match(approval.decisionFingerprint, /^[a-f0-9]{64}$/)

  const duplicate = await decide(owner.token, seeded)
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'EVOLUTION_APPROVAL_ALREADY_DECIDED')
  const list = await request(owner.token, '/api/evolution/approvals?limit=10')
  assert.equal((await list.json()).approvals.length, 1)
  const detail = await request(owner.token, `/api/evolution/approvals/${approval.id}`)
  assert.equal((await detail.json()).approval.reviewSnapshot.candidate.id, seeded.candidateId)
  const review = await request(owner.token, `/api/evolution/approval-reviews/${seeded.evaluationId}`)
  assert.equal((await review.json()).review.existingDecision.id, approval.id)

  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM evolution_candidates WHERE id = ?').get(seeded.candidateId).count, 1)
  for (const suffix of ['apply', 'install', 'rollout']) {
    const unsupported = await request(owner.token, `/api/evolution/approvals/${approval.id}/${suffix}`, {
      method: 'POST', body: {},
    })
    assert.equal(unsupported.status, 404)
  }
})

test('approval fails closed for mismatched confirmations, non-pass evaluations, and permission changes', async () => {
  const owner = issueTestSession({ email: 'approval-fail-closed@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const eligible = seedReview(owner.userId)
  const mismatch = await decide(owner.token, eligible, 'approved', {
    confirmations: { ...eligible.confirmations, evaluationFingerprint: 'f'.repeat(64) },
  })
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json()).error.code, 'EVOLUTION_APPROVAL_CONFIRMATION_MISMATCH')

  const failed = seedReview(owner.userId, { verdict: 'fail' })
  const notEligible = await decide(owner.token, failed)
  assert.equal(notEligible.status, 409)
  assert.equal((await notEligible.json()).error.code, 'EVOLUTION_APPROVAL_NOT_ELIGIBLE')
  const rejected = await decide(owner.token, failed, 'rejected')
  assert.equal(rejected.status, 201)
  assert.equal((await rejected.json()).approval.decision, 'rejected')

  const permissioned = seedReview(owner.userId, { permissionsRequested: ['tool:write_file'] })
  const permissionChange = await decide(owner.token, permissioned)
  assert.equal(permissionChange.status, 409)
  assert.equal((await permissionChange.json()).error.code, 'EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED')
})

test('multi-user mode fails closed even for an authenticated loopback request', async () => {
  const user = issueTestSession({ email: 'approval-multi-user@example.com' })
  const seeded = seedReview(user.userId)
  routeEnv.AUTH_MODE = 'multi_user'
  routeEnv.LOCAL_USER_ID = user.userId
  const response = await request(user.token, `/api/evolution/approval-reviews/${seeded.evaluationId}`)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'LOCAL_OWNER_ONLY')
  routeEnv.AUTH_MODE = 'local'
})
