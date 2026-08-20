import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-canary-'))
const workspaceDir = path.join(tempDir, 'workspace')
fs.mkdirSync(workspaceDir, { recursive: true })
fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const {
  createEvolutionCanary,
  recordEvolutionCanaryOutcome,
  resolveEvolutionCanaryAssignment,
  startEvolutionCanary,
  stopEvolutionCanary,
} = await import('../server/services/evolutionCanaryService.js')
const { prepareTurnPromptContext } = await import('../server/services/turnPromptContext.js')
const { readWorkspaceInstructions } = await import('../server/services/workspaceInstructions.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const routeEnv = {
  AUTH_MODE: 'local',
  LOCAL_USER_ID: '',
  WORKSPACE_FS_ENABLED: '1',
  PROJECT_INSTRUCTIONS_ENABLED: '1',
  WORKSPACE_ROOT: workspaceDir,
}
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, { env: routeEnv }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let sequence = 0

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function currentBaseline() {
  return readWorkspaceInstructions({ env: routeEnv }).text.trim()
}

function seedApprovedCanary(userId, { target = 'prompt:workspace-instructions', verdict = 'pass' } = {}) {
  sequence += 1
  const suffix = String(sequence)
  const candidateId = `canary-candidate-${suffix}`
  const suiteId = `canary-suite-${suffix}`
  const replayId = `canary-replay-${suffix}`
  const evaluationId = `canary-evaluation-${suffix}`
  const approvalId = `canary-approval-${suffix}`
  const baselineContent = currentBaseline()
  const candidateContent = `Candidate workspace instructions ${suffix}.`
  const candidateSha256 = sha256(candidateContent)
  const baselineSha256 = sha256(baselineContent)
  const replayFingerprint = sha256(`canary-replay-fingerprint-${suffix}`)
  const evaluationFingerprint = sha256(`canary-evaluation-fingerprint-${suffix}`)
  const decisionFingerprint = sha256(`canary-decision-fingerprint-${suffix}`)
  const db = getDb()
  db.prepare(`
    INSERT INTO evolution_candidates (
      id, user_id, kind, target, title, summary, content,
      assumptions_json, expected_impact_json, permissions_requested_json,
      dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
      generator_model, generator_mode, content_sha256, created_at
    ) VALUES (?, ?, 'prompt', ?, 'Canary candidate', 'Scoped prompt candidate', ?,
      '[]', '[]', '[]', ?, 'curation-v1', '[]', '[]',
      'generator-model', 'background_model_no_tools', ?, ?)
  `).run(candidateId, userId, target, candidateContent, sha256(`dataset-${suffix}`), candidateSha256, sequence)
  db.prepare(`
    INSERT INTO evolution_replay_suites (
      id, user_id, name, dataset_fingerprint, curation_version,
      source_record_ids_json, cases_json, suite_fingerprint, created_at
    ) VALUES (?, ?, 'Canary suite', ?, 'curation-v1', '[]', '[]', ?, ?)
  `).run(suiteId, userId, sha256(`dataset-${suffix}`), sha256(`suite-${suffix}`), sequence)
  db.prepare(`
    INSERT INTO evolution_replay_runs (
      id, user_id, suite_id, candidate_id, baseline_content, baseline_sha256,
      candidate_sha256, model_name, temperature, max_tokens, isolation_mode,
      results_json, run_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'worker-model', 0, 512,
      'model_no_tools', '[]', ?, ?)
  `).run(
    replayId, userId, suiteId, candidateId, baselineContent, baselineSha256,
    candidateSha256, replayFingerprint, sequence,
  )
  db.prepare(`
    INSERT INTO evolution_evaluations (
      id, user_id, replay_id, candidate_id, rubric_version, evaluator_model,
      independent, verdict, summary, case_assessments_json, metrics_json,
      issues_json, evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, 'rubric-v1', 'independent-evaluator', 1, ?,
      'Canary-ready evaluation', '[]', '{}', '[]', ?, ?)
  `).run(evaluationId, userId, replayId, candidateId, verdict, evaluationFingerprint, sequence)
  db.prepare(`
    INSERT INTO evolution_approval_decisions (
      id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
      candidate_sha256, replay_fingerprint, evaluation_fingerprint,
      rollback_baseline_sha256, rollback_target_json, review_snapshot_json,
      approver_mode, decision_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, 'approved', 'Approved for a scoped canary', ?, ?, ?, ?,
      ?, '{}', 'local_owner_loopback', ?, ?)
  `).run(
    approvalId, userId, evaluationId, replayId, candidateId,
    candidateSha256, replayFingerprint, evaluationFingerprint, baselineSha256,
    JSON.stringify({ target, contentSha256: baselineSha256 }), decisionFingerprint, sequence,
  )
  return { approvalId, candidateContent, baselineContent, baselineSha256, candidateSha256 }
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

function createChatSession(userId, id) {
  upsertSession({ id, userId, title: `Canary ${id}` })
  return id
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('canary is approval-bound, session-scoped, deterministic, drift-safe, and manually stoppable', () => {
  const owner = issueTestSession({ email: 'canary-service-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const scopedSession = createChatSession(owner.userId, 'canary-scoped-session')
  const otherSession = createChatSession(owner.userId, 'canary-other-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [scopedSession],
    trafficPercent: 10,
    reason: 'Start a bounded local canary',
    env: routeEnv,
    now: 100,
  })
  assert.equal(canary.state, 'created')
  assert.deepEqual(canary.sessionIds, [scopedSession])
  assert.equal(canary.trafficPercent, 10)
  assert.equal(canary.baselineSha256, seeded.baselineSha256)
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: scopedSession, turnId: 'before-start', env: routeEnv,
  }), null)
  const started = startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Explicit local-owner start',
    env: routeEnv,
    now: 150,
  })
  assert.equal(started.state, 'active')

  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: otherSession, turnId: 'outside-scope', env: routeEnv,
  }), null)

  let candidate = null
  let baseline = null
  for (let index = 0; index < 300 && (!candidate || !baseline); index += 1) {
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId: scopedSession,
      turnId: `turn-${index}`,
      env: routeEnv,
      now: 200 + index,
    })
    if (assignment.variant === 'candidate') candidate ||= assignment
    else baseline ||= assignment
  }
  assert.ok(candidate)
  assert.ok(baseline)
  assert.equal(candidate.promptContent, seeded.candidateContent)
  assert.equal(baseline.promptContent, seeded.baselineContent)
  const repeated = resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: scopedSession, turnId: candidate.turnId, env: routeEnv,
  })
  assert.equal(repeated.id, candidate.id)
  assert.equal(repeated.variant, candidate.variant)

  const outcome = recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId: scopedSession,
    turnId: candidate.turnId,
    terminalState: 'completed',
    durationMs: 1250,
    usage: { totalTokens: 120, costUsd: 0.02, rawPayload: 'must-not-persist' },
    now: 600,
  })
  assert.equal(outcome.stats.outcomes.candidate.completed, 1)
  assert.equal(outcome.stats.outcomes.candidate.costUsd, 0.02)
  const candidateObservation = outcome.observations.find(({ turnId }) => turnId === candidate.turnId)
  assert.deepEqual(candidateObservation.outcome.usage, { totalTokens: 120, costUsd: 0.02 })
  assert.equal('rawPayload' in candidateObservation.outcome.usage, false)

  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nBaseline drifted.\n')
  const drifted = resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: scopedSession, turnId: 'turn-after-drift', env: routeEnv,
  })
  assert.equal(drifted.variant, 'baseline')
  assert.equal(drifted.eligible, false)
  assert.equal(drifted.decisionReason, 'baseline_mismatch')
  assert.equal(drifted.promptContent.includes('Baseline drifted.'), true)
  assert.notEqual(drifted.observedBaselineSha256, seeded.baselineSha256)
  const driftOutcome = recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId: scopedSession,
    turnId: 'turn-after-drift',
    terminalState: 'failed',
    durationMs: 25,
    errorCode: 'BASELINE_DRIFT_OBSERVED',
    now: 650,
  })
  assert.equal(driftOutcome.stats.assignmentReasons.baseline_mismatch, 1)
  assert.equal(driftOutcome.stats.outcomes.baseline.failed, 1)

  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const stopped = stopEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Manual stop after observing the bounded sample',
    now: 700,
  })
  assert.equal(stopped.state, 'stopped')
  const assignedBeforeStop = resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: scopedSession, turnId: candidate.turnId, env: routeEnv,
  })
  assert.equal(assignedBeforeStop.id, candidate.id)
  assert.equal(assignedBeforeStop.variant, 'candidate')
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId: scopedSession, turnId: 'turn-after-stop', env: routeEnv,
  }), null)
})

test('canary start revalidates the baseline after release creation', () => {
  const owner = issueTestSession({ email: 'canary-start-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-start-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 5,
    reason: 'Create before an explicit start',
    env: routeEnv,
    now: 800,
  })
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nChanged before start.\n')
  assert.throws(
    () => startEvolutionCanary({
      userId: owner.userId,
      id: canary.id,
      reason: 'Must fail closed',
      env: routeEnv,
      now: 801,
    }),
    (error) => error.code === 'EVOLUTION_CANARY_BASELINE_MISMATCH',
  )
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId, sessionId, turnId: 'never-started', env: routeEnv,
  }), null)
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  assert.equal(startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start after restoring the exact baseline',
    env: routeEnv,
    now: 802,
  }).state, 'active')
  stopEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'End start-revalidation test',
    now: 803,
  })
})

test('workspace prompt context replaces only the workspace instruction block', async () => {
  const result = await prepareTurnPromptContext({
    userId: 'prompt-canary-user',
    query: 'test',
    canaryAssignment: {
      id: 'assignment-1',
      releaseId: 'release-1',
      variant: 'candidate',
      bucket: 1,
      target: 'prompt:workspace-instructions',
      baselineSha256: 'a'.repeat(64),
      candidateSha256: 'b'.repeat(64),
      releaseFingerprint: 'c'.repeat(64),
      promptContent: 'Scoped candidate workspace instructions.',
    },
    env: { AGENT_INJECT_ENABLED: '0', MEMORY_INJECT_TOKEN_CAP: '0' },
  }, {
    prepareSkillsForPrompt: () => [],
    prepareSkillCatalogForPrompt: () => [],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    readWorkspaceInstructions: () => ({ text: 'Original workspace instructions.' }),
  })
  assert.equal(result.messages.at(-1).content, 'Scoped candidate workspace instructions.')
  assert.equal(result.messages.some(({ content }) => content === 'Original workspace instructions.'), false)
  assert.equal(result.canaryAssignment.releaseId, 'release-1')
  assert.equal('promptContent' in result.canaryAssignment, false)
})

test('canary API is local-owner-only, bounded, no-store, and exposes no global or rollback action', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'canary-route-owner@example.com' })
  const other = issueTestSession({ email: 'canary-route-other@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-route-session')
  const seeded = seedApprovedCanary(owner.userId)

  const forbidden = await request(other.token, '/api/evolution/canaries')
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.json()).error.code, 'LOCAL_OWNER_ONLY')

  const invalid = await request(owner.token, '/api/evolution/canaries', {
    method: 'POST',
    body: {
      approvalId: seeded.approvalId,
      sessionIds: [sessionId],
      trafficPercent: 100,
      reason: 'A forbidden global rollout',
    },
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'EVOLUTION_CANARY_TRAFFIC_INVALID')

  const createdResponse = await request(owner.token, '/api/evolution/canaries', {
    method: 'POST',
    body: {
      approvalId: seeded.approvalId,
      sessionIds: [sessionId],
      trafficPercent: 5,
      reason: 'Start a five percent scoped canary',
    },
  })
  assert.equal(createdResponse.status, 201)
  assert.equal(createdResponse.headers.get('cache-control'), 'no-store')
  const created = (await createdResponse.json()).canary
  assert.equal(created.state, 'created')

  const startedResponse = await request(owner.token, `/api/evolution/canaries/${created.id}/start`, {
    method: 'POST', body: { reason: 'Explicit manual start' },
  })
  assert.equal(startedResponse.status, 200)
  assert.equal((await startedResponse.json()).canary.state, 'active')

  const listedResponse = await request(owner.token, '/api/evolution/canaries')
  const listed = (await listedResponse.json()).canaries.find(({ id }) => id === created.id)
  assert.equal('sessionIds' in listed, false)
  assert.equal('promptContent' in listed, false)

  const rollback = await request(owner.token, `/api/evolution/canaries/${created.id}/rollback`, {
    method: 'POST', body: { reason: 'P12 is not implemented' },
  })
  assert.equal(rollback.status, 404)

  const stoppedResponse = await request(owner.token, `/api/evolution/canaries/${created.id}/stop`, {
    method: 'POST', body: { reason: 'Manual stop only' },
  })
  assert.equal(stoppedResponse.status, 200)
  assert.equal((await stoppedResponse.json()).canary.state, 'stopped')
})
