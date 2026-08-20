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
const {
  createEvolutionCanaryRollbackPolicy,
} = await import('../server/services/evolutionRollbackService.js')
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

const DEFAULT_ROLLBACK_POLICY = Object.freeze({
  windowSize: 20,
  minimumCandidateOutcomes: 3,
  minimumBaselineOutcomes: 3,
  maximumCandidateFailureRate: 1,
  maximumCandidateCancellationRate: 1,
  maximumLatencyRatio: 10,
  maximumCostRatio: 10,
})

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

function declareRollbackPolicy(userId, releaseId, overrides = {}, now = 1) {
  return createEvolutionCanaryRollbackPolicy({
    userId,
    releaseId,
    policy: { ...DEFAULT_ROLLBACK_POLICY, ...overrides },
    reason: 'Predeclared automatic rollback guardrails',
    now,
  })
}

function collectCanaryAssignments(userId, sessionId, prefix, now = 1_000) {
  const assignments = { baseline: [], candidate: [] }
  for (let index = 0; index < 1_000
    && (assignments.baseline.length < 3 || assignments.candidate.length < 3); index += 1) {
    const assignment = resolveEvolutionCanaryAssignment({
      userId,
      sessionId,
      turnId: `${prefix}-${index}`,
      env: routeEnv,
      now: now + index,
    })
    if (assignments[assignment.variant].length < 3) assignments[assignment.variant].push(assignment)
  }
  assert.equal(assignments.baseline.length, 3)
  assert.equal(assignments.candidate.length, 3)
  return assignments
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
  declareRollbackPolicy(owner.userId, canary.id, {}, 125)
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
  assert.throws(
    () => startEvolutionCanary({
      userId: owner.userId,
      id: canary.id,
      reason: 'Policy is intentionally missing',
      env: routeEnv,
      now: 800,
    }),
    (error) => error.code === 'EVOLUTION_CANARY_ROLLBACK_POLICY_REQUIRED',
  )
  declareRollbackPolicy(owner.userId, canary.id, {}, 800)
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

test('legacy active canary without a rollback policy fails closed to baseline', () => {
  const owner = issueTestSession({ email: 'legacy-canary-policy-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'legacy-canary-policy-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Simulate a release started before v68',
    env: routeEnv,
    now: 850,
  })
  getDb().prepare(`
    INSERT INTO evolution_canary_events (id, user_id, release_id, event_type, reason, created_at)
    VALUES ('legacy-start-event', ?, ?, 'started', 'legacy start', 851)
  `).run(owner.userId, canary.id)
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'legacy-new-turn',
    env: routeEnv,
  }), null)
  getDb().prepare(`
    INSERT INTO evolution_canary_assignments (
      id, user_id, release_id, session_id, turn_id, variant, decision_reason, bucket,
      baseline_sha256, observed_baseline_sha256, candidate_sha256, assigned_at
    ) VALUES ('legacy-assignment', ?, ?, ?, 'legacy-existing-turn', 'candidate',
      'traffic_candidate', 1, ?, ?, ?, 852)
  `).run(
    owner.userId, canary.id, sessionId, seeded.baselineSha256,
    seeded.baselineSha256, seeded.candidateSha256,
  )
  const existing = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'legacy-existing-turn',
    env: routeEnv,
  })
  assert.equal(existing.variant, 'baseline')
  assert.equal(existing.eligible, false)
  assert.equal(existing.decisionReason, 'rollback_policy_missing')
  assert.equal(existing.promptContent, seeded.baselineContent)
})

test('predeclared candidate reliability thresholds automatically roll back the canary overlay', () => {
  const owner = issueTestSession({ email: 'canary-rollback-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-rollback-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Exercise automatic rollback',
    env: routeEnv,
    now: 900,
  })
  const policy = declareRollbackPolicy(owner.userId, canary.id, {
    maximumCandidateFailureRate: 0.2,
    maximumCandidateCancellationRate: 0.2,
  }, 901)
  assert.equal(policy.baselineSha256, seeded.baselineSha256)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start guarded canary',
    env: routeEnv,
    now: 902,
  })

  const assignments = collectCanaryAssignments(
    owner.userId,
    sessionId,
    'rollback-turn',
  )

  for (const [index, assignment] of assignments.baseline.entries()) {
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      usage: { costUsd: 0.01 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 2_000 + index,
    })
  }
  for (const [index, assignment] of assignments.candidate.entries()) {
    const result = recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: index === 2 ? 'failed' : index === 1 ? 'cancelled' : 'completed',
      durationMs: 110,
      usage: { costUsd: 0.011 },
      errorCode: index === 2 ? 'MODEL_FAILED' : index === 1 ? 'USER_CANCELLED' : null,
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 3_000 + index,
    })
    if (index < 2) assert.equal(result.state, 'active')
    else {
      assert.equal(result.state, 'rolled_back')
      assert.deepEqual(
        result.automaticRollback.rollback.reason,
        'Automatic rollback: maximum_candidate_failure_rate, maximum_candidate_cancellation_rate',
      )
      assert.equal(result.automaticRollback.rollback.rollbackBaselineSha256, seeded.baselineSha256)
      assert.equal(result.automaticRollback.rollback.baselineStatus, 'verified')
      assert.deepEqual(
        result.automaticRollback.evaluations[0].breaches,
        ['maximum_candidate_failure_rate', 'maximum_candidate_cancellation_rate'],
      )
    }
  }
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'new-turn-after-automatic-rollback',
    env: routeEnv,
  }), null)
})

test('predeclared latency and cost ratios automatically roll back with complete evidence', () => {
  const owner = issueTestSession({ email: 'canary-ratio-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-ratio-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Exercise comparative rollback guardrails',
    env: routeEnv,
    now: 4_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {
    maximumLatencyRatio: 1.5,
    maximumCostRatio: 1.5,
  }, 4_001)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start comparative canary',
    env: routeEnv,
    now: 4_002,
  })
  const assignments = collectCanaryAssignments(
    owner.userId,
    sessionId,
    'ratio-turn',
    4_100,
  )
  for (const [index, assignment] of assignments.baseline.entries()) {
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      usage: { costUsd: 0.01 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 5_000 + index,
    })
  }
  let rolledBack = null
  for (const [index, assignment] of assignments.candidate.entries()) {
    rolledBack = recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 200,
      usage: { costUsd: 0.02 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 6_000 + index,
    })
  }
  assert.equal(rolledBack.state, 'rolled_back')
  assert.deepEqual(
    rolledBack.automaticRollback.evaluations[0].breaches,
    ['maximum_latency_ratio', 'maximum_cost_ratio'],
  )
  assert.equal(rolledBack.automaticRollback.evaluations[0].metrics.latencyRatio, 2)
  assert.equal(rolledBack.automaticRollback.evaluations[0].metrics.costRatio, 2)
})

test('incomplete cost evidence cannot trigger a cost rollback', () => {
  const owner = issueTestSession({ email: 'canary-missing-cost-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-missing-cost-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = createEvolutionCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Require complete cost evidence',
    env: routeEnv,
    now: 7_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {
    maximumCostRatio: 1.1,
  }, 7_001)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start cost evidence canary',
    env: routeEnv,
    now: 7_002,
  })
  const assignments = collectCanaryAssignments(
    owner.userId,
    sessionId,
    'missing-cost-turn',
    7_100,
  )
  for (const [index, assignment] of assignments.baseline.entries()) {
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      usage: { costUsd: 0.01 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 8_000 + index,
    })
  }
  let result = null
  for (const [index, assignment] of assignments.candidate.entries()) {
    result = recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      usage: index === 1 ? {} : { costUsd: 1 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      env: routeEnv,
      now: 9_000 + index,
    })
  }
  assert.equal(result.state, 'active')
  assert.equal(result.automaticRollback.rollback, null)
  assert.equal(result.automaticRollback.evaluations[0].decision, 'insufficient_evidence')
  assert.equal(result.automaticRollback.evaluations[0].metrics.evidence.costReady, false)
  assert.equal(result.automaticRollback.evaluations[0].metrics.costRatio, null)
  assert.deepEqual(result.automaticRollback.evaluations[0].breaches, [])
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

test('canary API is local-owner-only, bounded, no-store, and exposes no global or manual rollback action', async () => {
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

  const forbiddenPolicy = await request(
    other.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: DEFAULT_ROLLBACK_POLICY,
        reason: 'Another user cannot declare the policy',
      },
    },
  )
  assert.equal(forbiddenPolicy.status, 403)
  assert.equal((await forbiddenPolicy.json()).error.code, 'LOCAL_OWNER_ONLY')

  const policyResponse = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: DEFAULT_ROLLBACK_POLICY,
        reason: 'Declare automatic rollback thresholds before start',
      },
    },
  )
  assert.equal(policyResponse.status, 201)
  assert.equal((await policyResponse.json()).policy.version, 'canary-rollback-v1')

  const duplicatePolicy = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: { ...DEFAULT_ROLLBACK_POLICY, maximumCostRatio: 2 },
        reason: 'Cannot replace an immutable policy',
      },
    },
  )
  assert.equal(duplicatePolicy.status, 409)
  assert.equal((await duplicatePolicy.json()).error.code, 'EVOLUTION_CANARY_ROLLBACK_POLICY_EXISTS')

  const startedResponse = await request(owner.token, `/api/evolution/canaries/${created.id}/start`, {
    method: 'POST', body: { reason: 'Explicit manual start' },
  })
  assert.equal(startedResponse.status, 200)
  assert.equal((await startedResponse.json()).canary.state, 'active')

  const lockedPolicy = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: DEFAULT_ROLLBACK_POLICY,
        reason: 'Cannot mutate thresholds after start',
      },
    },
  )
  assert.equal(lockedPolicy.status, 409)
  assert.equal((await lockedPolicy.json()).error.code, 'EVOLUTION_CANARY_ROLLBACK_POLICY_LOCKED')

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
