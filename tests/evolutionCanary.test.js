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
const { default: Database } = await import('../server/adapters/sqliteDriver.js')
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
  evolutionRollbackDecisionMetrics,
} = await import('../server/services/evolutionRollbackService.js')
const {
  createEvolutionCanaryGraderPolicy,
  getEvolutionCanaryOnlineGradeState,
  runEvolutionCanaryOnlineGrade,
} = await import('../server/services/evolutionOnlineGraderService.js')
const {
  buildEvolutionPromotionReview,
  createEvolutionPromotion,
  revokeEvolutionPromotion,
} = await import('../server/services/evolutionPromotionService.js')
const {
  getEvolutionPromotionOnlineGradeState,
  runEvolutionPromotionOnlineGrade,
} = await import('../server/services/evolutionPromotionOnlineGraderService.js')
const {
  closeEvolutionOnlineGraderRuntime,
  createEvolutionOnlineGraderRuntime,
  setEvolutionOnlineGraderRuntimeForTesting,
} = await import('../server/services/evolutionOnlineGraderRuntime.js')
const { prepareTurnPromptContext } = await import('../server/services/turnPromptContext.js')
const { readWorkspaceInstructions } = await import('../server/services/workspaceInstructions.js')
const { getSession, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const routeEnv = {
  AUTH_MODE: 'local',
  LOCAL_USER_ID: '',
  WORKSPACE_FS_ENABLED: '1',
  PROJECT_INSTRUCTIONS_ENABLED: '1',
  WORKSPACE_ROOT: workspaceDir,
}
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
  env: routeEnv,
  readCanarySession: async (scope) => getSession(scope),
}))
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
})

test('Rollback identity excludes optional Provider cost telemetry', () => {
  const base = {
    windowSize: 20,
    candidate: { outcomes: 3, averageDurationMs: 10, costMeasured: 3, averageCostUsd: 1 },
    baseline: { outcomes: 3, averageDurationMs: 10, costMeasured: 3, averageCostUsd: 2 },
    evidence: { candidateReady: true, baselineReady: true, costReady: true },
    latencyRatio: 1,
    costRatio: 0.5,
  }
  const changedCost = {
    ...base,
    candidate: { ...base.candidate, averageCostUsd: 1_000 },
    baseline: { ...base.baseline, averageCostUsd: 0.001 },
    costRatio: 1_000_000,
  }
  assert.deepEqual(
    evolutionRollbackDecisionMetrics(base),
    evolutionRollbackDecisionMetrics(changedCost),
  )
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

function createTestCanary(input) {
  return createEvolutionCanary({
    ...input,
    readSession: async (scope) => getSession(scope),
  })
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

async function createPromotionReadyCanary(
  userId,
  sessionId,
  prefix,
  now = 20_000,
  { productionMonitoringEnabled = false } = {},
) {
  const seeded = seedApprovedCanary(userId)
  const canary = await createTestCanary({
    userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Collect a bounded production-promotion sample',
    env: routeEnv,
    now,
  })
  declareRollbackPolicy(userId, canary.id, {}, now + 1)
  createEvolutionCanaryGraderPolicy({
    userId,
    releaseId: canary.id,
    graderProviderId: 'independent-grader-provider',
    graderModelName: 'independent-grader-model',
    graderModelRevision: 'grader-revision-1',
    policy: {
      minimumQualityScore: 2,
      maximumQualityRegression: 0,
      maximumSafetyFailureRate: 0,
      productionMonitoringEnabled,
    },
    reason: 'Freeze independent production quality and safety evidence',
    now: now + 1,
  })
  startEvolutionCanary({
    userId,
    id: canary.id,
    reason: 'Start promotion qualification canary',
    env: routeEnv,
    now: now + 2,
  })
  const assignments = collectCanaryAssignments(userId, sessionId, prefix, now + 100)
  for (const [variantOffset, variant] of ['baseline', 'candidate'].entries()) {
    for (const [index, assignment] of assignments[variant].entries()) {
      recordEvolutionCanaryOutcome({
        userId,
        sessionId,
        turnId: assignment.turnId,
        terminalState: 'completed',
        durationMs: 100,
        usage: { costUsd: 0.01 },
        effectiveVariant: assignment.variant,
        decisionReason: assignment.decisionReason,
        modelProviderId: 'worker-provider',
        modelName: 'worker-model',
        modelRevision: 'worker-revision-1',
        modelConfigRevision: 1,
        evaluationInput: `Complete production task ${assignment.turnId}`,
        evaluationOutput: `Verified safe result ${assignment.turnId}`,
        env: routeEnv,
        now: now + 1_000 + (variantOffset * 100) + index,
      })
      const outcomeId = getDb().prepare(`
        SELECT id FROM evolution_canary_outcomes WHERE assignment_id = ?
      `).get(assignment.id).id
      await runEvolutionCanaryOnlineGrade({
        userId,
        releaseId: canary.id,
        outcomeId,
        now: now + 1_500 + (variantOffset * 100) + index,
        runModel: async () => ({
          providerId: 'independent-grader-provider',
          modelName: 'independent-grader-model',
          content: JSON.stringify({
            summary: 'The recorded task has a complete and safe result.',
            qualityScore: 3,
            safetyVerdict: 'pass',
            evidence: ['The output contains a verified task result.'],
            issues: [],
          }),
        }),
      })
    }
  }
  const stopped = stopEvolutionCanary({
    userId,
    id: canary.id,
    reason: 'Stop after the immutable promotion threshold passed',
    now: now + 2_000,
  })
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.automaticRollback.evaluations[0].decision, 'continue')
  assert.equal(
    getEvolutionCanaryOnlineGradeState({ userId, releaseId: canary.id }).guard.decision,
    'continue',
  )
  return { seeded, canary: stopped }
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('canary creation awaits its Session Store and never falls back to SQLite', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'canary-session-store-boundary@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const adapterOnlySessionId = 'canary-adapter-only-session'
  assert.equal(getSession({ userId: owner.userId, sessionId: adapterOnlySessionId }), null)

  const availableEvidence = seedApprovedCanary(owner.userId)
  let releaseRead
  const readGate = new Promise((resolve) => { releaseRead = resolve })
  const reads = []
  let creationSettled = false
  const pendingCreation = createEvolutionCanary({
    userId: owner.userId,
    approvalId: availableEvidence.approvalId,
    sessionIds: [adapterOnlySessionId],
    trafficPercent: 5,
    reason: 'Use an adapter-owned session that SQLite cannot see',
    readSession: async (scope) => {
      reads.push(scope)
      await readGate
      return { id: scope.sessionId, userId: scope.userId }
    },
    env: routeEnv,
    now: 90_000,
  })
  void pendingCreation.then(
    () => { creationSettled = true },
    () => { creationSettled = true },
  )
  await Promise.resolve()
  assert.equal(creationSettled, false)
  releaseRead()
  const created = await pendingCreation
  assert.deepEqual(reads, [{ userId: owner.userId, sessionId: adapterOnlySessionId }])
  assert.deepEqual(created.sessionIds, [adapterOnlySessionId])
  assert.equal(getSession({ userId: owner.userId, sessionId: adapterOnlySessionId }), null)

  const sqliteOnlySessionId = createChatSession(owner.userId, 'canary-sqlite-only-session')
  const missingEvidence = seedApprovedCanary(owner.userId)
  await assert.rejects(
    createEvolutionCanary({
      userId: owner.userId,
      approvalId: missingEvidence.approvalId,
      sessionIds: [sqliteOnlySessionId],
      trafficPercent: 5,
      reason: 'An authoritative adapter miss must not fall back to SQLite',
      readSession: async () => null,
      env: routeEnv,
      now: 90_010,
    }),
    (error) => error?.code === 'EVOLUTION_CANARY_SESSION_NOT_FOUND' && error?.statusCode === 404,
  )
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_releases WHERE approval_id = ?
  `).get(missingEvidence.approvalId).count, 0)

  const rejectedEvidence = seedApprovedCanary(owner.userId)
  const backendError = Object.assign(new Error('adapter Session Store unavailable'), {
    code: 'TEST_SESSION_STORE_UNAVAILABLE',
  })
  await assert.rejects(
    createEvolutionCanary({
      userId: owner.userId,
      approvalId: rejectedEvidence.approvalId,
      sessionIds: ['canary-rejected-adapter-session'],
      trafficPercent: 5,
      reason: 'Propagate an adapter read rejection without partial state',
      readSession: async () => { throw backendError },
      env: routeEnv,
      now: 90_020,
    }),
    (error) => error === backendError,
  )
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_releases WHERE approval_id = ?
  `).get(rejectedEvidence.approvalId).count, 0)
})

test('canary is approval-bound, session-scoped, deterministic, drift-safe, and manually stoppable', async () => {
  const owner = issueTestSession({ email: 'canary-service-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const scopedSession = createChatSession(owner.userId, 'canary-scoped-session')
  const otherSession = createChatSession(owner.userId, 'canary-other-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
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

test('canary outcome snapshots use explicit turn facts without reading SQLite turn projections', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'canary-explicit-snapshot@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-explicit-snapshot-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Prove canary snapshots are independent of Turn storage projections',
    env: routeEnv,
    now: 45_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 45_001)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start the explicit snapshot boundary test',
    env: routeEnv,
    now: 45_002,
  })

  const explicitAssignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'canary-explicit-snapshot-turn',
    env: routeEnv,
    now: 45_010,
  })
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM turn_events
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner.userId, sessionId, explicitAssignment.turnId).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE session_id = ? AND id IN (?, ?)
  `).get(
    sessionId,
    `${explicitAssignment.turnId}:user`,
    `${explicitAssignment.turnId}:assistant`,
  ).count, 0)

  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: explicitAssignment.turnId,
    terminalState: 'completed',
    durationMs: 125,
    modelProviderId: 'explicit-provider',
    modelName: 'explicit-model',
    modelConfigRevision: 17,
    evaluationInput: 'Explicit model input from the active Turn.',
    evaluationOutput: 'Explicit terminal output from the active Turn.',
    env: routeEnv,
    now: 45_020,
  })
  const explicitSnapshot = getDb().prepare(`
    SELECT * FROM evolution_canary_outcome_snapshots WHERE assignment_id = ?
  `).get(explicitAssignment.id)
  assert.equal(explicitSnapshot.evaluated_provider_id, 'explicit-provider')
  assert.equal(explicitSnapshot.evaluated_model, 'explicit-model')
  assert.equal(explicitSnapshot.evaluated_model_revision, 'config:17')
  assert.equal(explicitSnapshot.evaluated_config_revision, 17)
  assert.equal(explicitSnapshot.input_content, 'Explicit model input from the active Turn.')
  assert.equal(explicitSnapshot.output_content, 'Explicit terminal output from the active Turn.')

  const staleTurnId = 'canary-stale-projection-turn'
  const staleAssignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: staleTurnId,
    env: routeEnv,
    now: 45_030,
  })
  appendTurnEvent({
    userId: owner.userId,
    event: createTurnEvent({
      id: `${staleTurnId}:0`,
      sessionId,
      turnId: staleTurnId,
      sequence: 0,
      type: 'turn.started',
      payload: {
        content: 'stale event input',
        modelProviderId: 'stale-provider',
        modelName: 'stale-model',
        modelConfigRevision: 99,
      },
      createdAt: 45_031,
    }),
  })
  upsertMessage({
    id: `${staleTurnId}:user`,
    userId: owner.userId,
    sessionId,
    role: 'user',
    content: 'stale projected user input',
    modelContext: { modelContent: 'stale projected model input' },
    createdAt: 45_031,
    updatedAt: 45_031,
  })
  upsertMessage({
    id: `${staleTurnId}:assistant`,
    userId: owner.userId,
    sessionId,
    role: 'assistant',
    content: 'stale projected output',
    createdAt: 45_032,
    updatedAt: 45_032,
  })
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: staleTurnId,
    terminalState: 'completed',
    durationMs: 100,
    env: routeEnv,
    now: 45_040,
  })
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_outcome_snapshots WHERE assignment_id = ?
  `).get(staleAssignment.id).count, 0)
})

test('canary assignment is fenced when a second SQLite connection stops it after the active read', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'canary-assignment-fence@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-assignment-fence-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Exercise the canary assignment database fence',
    env: routeEnv,
    now: 750,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 760)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start before the concurrent stop',
    env: routeEnv,
    now: 770,
  })

  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('foreign_keys = ON')
  secondDb.pragma('busy_timeout = 5000')
  let stopped = false
  const stopOnWorkspaceRead = new Proxy(routeEnv, {
    get(target, property, receiver) {
      if (!stopped) {
        stopped = true
        secondDb.prepare(`
          INSERT INTO evolution_canary_events (
            id, user_id, release_id, event_type, reason, created_at
          ) VALUES (?, ?, ?, 'stopped', ?, ?)
        `).run(
          `assignment-fence-stop-${canary.id}`,
          owner.userId,
          canary.id,
          'Concurrent second-connection stop',
          780,
        )
      }
      return Reflect.get(target, property, receiver)
    },
  })

  try {
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId,
      turnId: 'canary-assignment-fenced-turn',
      env: stopOnWorkspaceRead,
      now: 790,
    })
    assert.equal(stopped, true)
    assert.equal(assignment, null)
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_canary_assignments
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(owner.userId, sessionId, 'canary-assignment-fenced-turn').count, 0)
  } finally {
    secondDb.close()
  }
})

test('canary start revalidates the baseline after release creation', async () => {
  const owner = issueTestSession({ email: 'canary-start-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-start-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
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

test('legacy active canary without a rollback policy fails closed to baseline', async () => {
  const owner = issueTestSession({ email: 'legacy-canary-policy-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'legacy-canary-policy-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
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

test('predeclared candidate reliability thresholds automatically roll back the canary overlay', async () => {
  const owner = issueTestSession({ email: 'canary-rollback-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-rollback-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
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

test('latency can roll back while Provider cost remains telemetry only', async () => {
  const owner = issueTestSession({ email: 'canary-ratio-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-ratio-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
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
    ['maximum_latency_ratio'],
  )
  assert.equal(rolledBack.automaticRollback.evaluations[0].metrics.latencyRatio, 2)
  assert.equal(rolledBack.automaticRollback.evaluations[0].metrics.costRatio, 2)
})

test('incomplete optional provider cost evidence neither triggers rollback nor blocks other evidence', async () => {
  const owner = issueTestSession({ email: 'canary-missing-cost-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-missing-cost-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Require complete cost evidence',
    env: routeEnv,
    now: 7_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 7_001)
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
  assert.equal(result.automaticRollback.evaluations[0].decision, 'continue')
  assert.equal(result.automaticRollback.evaluations[0].metrics.evidence.costReady, false)
  assert.equal(result.automaticRollback.evaluations[0].metrics.costRatio, null)
  assert.deepEqual(result.automaticRollback.evaluations[0].breaches, [])
})

test('stopped canary promotes atomically, routes all new turns, and revokes without changing old turns', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const canarySession = createChatSession(owner.userId, 'promotion-canary-session')
  const runtimeSession = createChatSession(owner.userId, 'promotion-runtime-session')
  const { seeded, canary } = await createPromotionReadyCanary(
    owner.userId,
    canarySession,
    'promotion-evidence-turn',
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: canary.id,
    env: routeEnv,
  })
  assert.equal(review.guard.decision, 'continue')
  assert.equal(review.confirmations.candidateContentSha256, seeded.candidateSha256)
  assert.throws(
    () => createEvolutionPromotion({
      userId: owner.userId,
      canaryReleaseId: canary.id,
      reason: 'Reject a stale human confirmation',
      confirmations: { ...review.confirmations, rollbackPolicyFingerprint: '0'.repeat(64) },
      env: routeEnv,
      now: 22_100,
    }),
    (error) => error.code === 'EVOLUTION_PROMOTION_CONFIRMATION_MISMATCH',
  )
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: canary.id,
    reason: 'Promote the reviewed immutable candidate to production',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 22_200,
  })
  assert.equal(promotion.state, 'active')
  assert.equal(promotion.stats.assignments, 0)

  const assignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId: runtimeSession,
    turnId: 'production-turn-before-revoke',
    env: routeEnv,
    now: 22_300,
  })
  assert.equal(assignment.assignmentKind, 'production_promotion')
  assert.equal(assignment.variant, 'candidate')
  assert.equal(assignment.decisionReason, 'production_candidate')
  assert.equal(assignment.promptContent, seeded.candidateContent)
  assert.equal(assignment.promotionId, promotion.id)

  const outcome = recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId: runtimeSession,
    turnId: assignment.turnId,
    terminalState: 'completed',
    durationMs: 321,
    usage: { totalTokens: 42, costUsd: 0.02, ignored: true },
    now: 22_400,
  })
  assert.equal(outcome.stats.assignments, 1)
  assert.equal(outcome.stats.outcomes.completed, 1)

  assert.throws(
    () => startEvolutionCanary({
      userId: owner.userId,
      id: canary.id,
      reason: 'Cannot restart a completed lifecycle',
      env: routeEnv,
      now: 22_450,
    }),
    (error) => error.code === 'EVOLUTION_CANARY_NOT_STARTABLE',
  )
  const revoked = revokeEvolutionPromotion({
    userId: owner.userId,
    id: promotion.id,
    reason: 'Explicitly return new turns to the local workspace baseline',
    now: 22_500,
  })
  assert.equal(revoked.state, 'revoked')
  assert.equal(resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId: runtimeSession,
    turnId: 'production-turn-after-revoke',
    env: routeEnv,
  }), null)
  const restored = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId: runtimeSession,
    turnId: assignment.turnId,
    env: routeEnv,
  })
  assert.equal(restored.id, assignment.id)
  assert.equal(restored.promptContent, seeded.candidateContent)
})

test('production assignment is fenced when a second SQLite connection revokes after the active read', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-assignment-fence@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-assignment-fence-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-assignment-fence-canary',
    23_000,
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Exercise the production assignment database fence',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 25_100,
  })

  const secondDb = new Database(process.env.APP_DB_PATH)
  secondDb.pragma('foreign_keys = ON')
  secondDb.pragma('busy_timeout = 5000')
  let revoked = false
  const revokeOnWorkspaceRead = new Proxy(routeEnv, {
    get(target, property, receiver) {
      if (!revoked) {
        revoked = true
        secondDb.transaction(() => {
          const removed = secondDb.prepare(`
            DELETE FROM evolution_active_promotions
            WHERE user_id = ? AND target = ? AND promotion_id = ?
          `).run(owner.userId, promotion.target, promotion.id)
          assert.equal(removed.changes, 1)
          secondDb.prepare(`
            INSERT INTO evolution_promotion_events (
              id, user_id, promotion_id, event_type, reason, created_at
            ) VALUES (?, ?, ?, 'revoked', ?, ?)
          `).run(
            `assignment-fence-revoke-${promotion.id}`,
            owner.userId,
            promotion.id,
            'Concurrent second-connection revoke',
            25_200,
          )
        }).immediate()
      }
      return Reflect.get(target, property, receiver)
    },
  })

  try {
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId,
      turnId: 'production-assignment-fenced-turn',
      env: revokeOnWorkspaceRead,
      now: 25_300,
    })
    assert.equal(revoked, true)
    assert.equal(assignment, null)
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_promotion_assignments
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).get(owner.userId, sessionId, 'production-assignment-fenced-turn').count, 0)
  } finally {
    secondDb.close()
  }
})

test('promotion refuses baseline drift and insufficient canary evidence', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-guard-owner@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-guard-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Create a canary with no sufficient production evidence',
    env: routeEnv,
    now: 23_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 23_001)
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start then stop before the sample threshold',
    env: routeEnv,
    now: 23_002,
  })
  stopEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Stop without a passing guard evaluation',
    now: 23_003,
  })
  assert.throws(
    () => buildEvolutionPromotionReview({
      userId: owner.userId,
      canaryReleaseId: canary.id,
      env: routeEnv,
    }),
    (error) => error.code === 'EVOLUTION_PROMOTION_GUARD_NOT_PASSED',
  )

  const ready = await createPromotionReadyCanary(owner.userId, sessionId, 'promotion-drift-turn', 24_000)
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nChanged after canary.\n')
  assert.throws(
    () => buildEvolutionPromotionReview({
      userId: owner.userId,
      canaryReleaseId: ready.canary.id,
      env: routeEnv,
    }),
    (error) => error.code === 'EVOLUTION_PROMOTION_BASELINE_MISMATCH',
  )
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
})

test('promotion production monitoring is explicit opt-in and preserves immutable snapshots when disabled', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-monitoring-disabled@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-monitoring-disabled-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-monitoring-disabled-canary',
    31_000,
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Promote without opting into production model calls',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 33_100,
  })
  let modelCalls = 0
  const runtime = createEvolutionOnlineGraderRuntime({
    runGrade: (task) => runEvolutionPromotionOnlineGrade({
      ...task,
      runModel: async () => {
        modelCalls += 1
        throw new Error('disabled monitoring must not call the grader')
      },
    }),
    onError() {},
  })
  setEvolutionOnlineGraderRuntimeForTesting(runtime)
  await runtime.start()
  const assignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'promotion-monitoring-disabled-outcome',
    env: routeEnv,
    now: 33_200,
  })
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: assignment.turnId,
    terminalState: 'completed',
    durationMs: 80,
    modelProviderId: 'worker-provider',
    modelName: 'worker-model',
    modelRevision: 'worker-revision-1',
    evaluationInput: 'Complete a production task without monitoring.',
    evaluationOutput: 'Completed locally.',
    now: 33_300,
  })
  await closeEvolutionOnlineGraderRuntime()

  assert.equal(modelCalls, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_online_grades WHERE promotion_id = ?
  `).get(promotion.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_outcome_snapshots AS snapshot
    JOIN evolution_promotion_outcomes AS outcome ON outcome.id = snapshot.outcome_id
    WHERE outcome.promotion_id = ?
  `).get(promotion.id).count, 1)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_active_promotions WHERE promotion_id = ?
  `).get(promotion.id).count, 1)
})

test('promotion monitoring recovers backlog, grades new outcomes, and skips revoked promotions', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-monitoring-enabled@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-monitoring-enabled-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-monitoring-enabled-canary',
    34_000,
    { productionMonitoringEnabled: true },
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Promote with immutable production monitoring enabled',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 36_100,
  })
  const recordOutcome = (index, now) => {
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId,
      turnId: `promotion-monitoring-enabled-outcome-${index}`,
      env: routeEnv,
      now,
    })
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 90,
      modelProviderId: 'worker-provider',
      modelName: 'worker-model',
      modelRevision: 'worker-revision-1',
      evaluationInput: `Complete monitored task ${index}.`,
      evaluationOutput: `Verified monitored result ${index}.`,
      now: now + 1,
    })
    return assignment
  }
  recordOutcome(0, 36_200)

  let modelCalls = 0
  const runModel = async () => {
    modelCalls += 1
    return {
      providerId: 'independent-grader-provider',
      modelName: 'independent-grader-model',
      content: JSON.stringify({
        summary: 'The production result is complete and safe.',
        qualityScore: 3,
        safetyVerdict: 'pass',
        evidence: ['The recorded output completes the requested task.'],
        issues: [],
      }),
    }
  }
  const runtime = createEvolutionOnlineGraderRuntime({
    concurrency: 2,
    runGrade: (task) => runEvolutionPromotionOnlineGrade({ ...task, runModel }),
    onError() {},
  })
  setEvolutionOnlineGraderRuntimeForTesting(runtime)
  await runtime.start()
  recordOutcome(1, 36_300)
  recordOutcome(2, 36_400)
  await closeEvolutionOnlineGraderRuntime()

  const state = getEvolutionPromotionOnlineGradeState({
    userId: owner.userId,
    promotionId: promotion.id,
  })
  assert.equal(modelCalls, 3)
  assert.equal(state.monitoringEnabled, true)
  assert.equal(state.grades.length, 3)
  assert.equal(state.guard.decision, 'continue')
  assert.equal(state.rollback, null)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_active_promotions WHERE promotion_id = ?
  `).get(promotion.id).count, 1)

  const assignmentAfterRevoke = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'promotion-monitoring-outcome-after-revoke',
    env: routeEnv,
    now: 36_500,
  })
  revokeEvolutionPromotion({
    userId: owner.userId,
    id: promotion.id,
    reason: 'Verify revoked promotions never invoke the grader',
    now: 36_510,
  })
  const revokedRuntime = createEvolutionOnlineGraderRuntime({
    runGrade: (task) => runEvolutionPromotionOnlineGrade({ ...task, runModel }),
    onError() {},
  })
  setEvolutionOnlineGraderRuntimeForTesting(revokedRuntime)
  await revokedRuntime.start()
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: assignmentAfterRevoke.turnId,
    terminalState: 'completed',
    durationMs: 90,
    modelProviderId: 'worker-provider',
    modelName: 'worker-model',
    modelRevision: 'worker-revision-1',
    evaluationInput: 'This outcome completed after revocation.',
    evaluationOutput: 'No production grading should occur.',
    now: 36_520,
  })
  await closeEvolutionOnlineGraderRuntime()
  assert.equal(modelCalls, 3)
  assert.equal(getEvolutionPromotionOnlineGradeState({
    userId: owner.userId,
    promotionId: promotion.id,
  }).grades.length, 3)
})

test('production online grade discards model evidence when manual revoke wins the await race', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-grade-revoke-race@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-grade-revoke-race-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-grade-revoke-race-canary',
    36_600,
    { productionMonitoringEnabled: true },
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Exercise the production grading revoke fence',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 38_700,
  })
  const assignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'promotion-grade-revoke-race-turn',
    env: routeEnv,
    now: 38_800,
  })
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: assignment.turnId,
    terminalState: 'completed',
    durationMs: 100,
    modelProviderId: 'worker-provider',
    modelName: 'worker-model',
    modelRevision: 'worker-revision-1',
    evaluationInput: 'Grade the in-flight production result.',
    evaluationOutput: 'This result completed before the manual revoke.',
    now: 38_900,
  })
  const outcomeId = getDb().prepare(`
    SELECT id FROM evolution_promotion_outcomes WHERE assignment_id = ?
  `).get(assignment.id).id

  let releaseModel
  let markModelStarted
  const modelStarted = new Promise((resolve) => { markModelStarted = resolve })
  const modelGate = new Promise((resolve) => { releaseModel = resolve })
  const gradePromise = runEvolutionPromotionOnlineGrade({
    userId: owner.userId,
    promotionId: promotion.id,
    outcomeId,
    now: 39_000,
    runModel: async () => {
      markModelStarted()
      await modelGate
      return {
        providerId: 'independent-grader-provider',
        modelName: 'independent-grader-model',
        content: JSON.stringify({
          summary: 'The production result is complete and safe.',
          qualityScore: 3,
          safetyVerdict: 'pass',
          evidence: ['The output completed the recorded request.'],
          issues: [],
        }),
      }
    },
  })
  await modelStarted
  revokeEvolutionPromotion({
    userId: owner.userId,
    id: promotion.id,
    reason: 'Manual revoke must fence the in-flight grader write',
    now: 39_100,
  })
  releaseModel()

  assert.equal(await gradePromise, null)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_online_grades WHERE promotion_id = ?
  `).get(promotion.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_online_guard_evaluations
    WHERE promotion_id = ?
  `).get(promotion.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_rollbacks WHERE promotion_id = ?
  `).get(promotion.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_events
    WHERE promotion_id = ? AND event_type = 'revoked'
  `).get(promotion.id).count, 1)
})

test('promotion grader configuration failures are audited without revoking production', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-monitoring-failure@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-monitoring-failure-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-monitoring-failure-canary',
    37_000,
    { productionMonitoringEnabled: true },
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Exercise fail-closed production grader auditing',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 39_100,
  })
  const assignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'promotion-monitoring-failed-grade',
    env: routeEnv,
    now: 39_200,
  })
  const runtime = createEvolutionOnlineGraderRuntime({
    runGrade: (task) => runEvolutionPromotionOnlineGrade({
      ...task,
      runModel: async () => { throw new Error('grader unavailable') },
    }),
    onError() {},
  })
  setEvolutionOnlineGraderRuntimeForTesting(runtime)
  await runtime.start()
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: assignment.turnId,
    terminalState: 'completed',
    durationMs: 100,
    modelProviderId: 'worker-provider',
    modelName: 'worker-model',
    modelRevision: 'worker-revision-1',
    evaluationInput: 'Grade this result.',
    evaluationOutput: 'The result remains available locally.',
    now: 39_300,
  })
  await closeEvolutionOnlineGraderRuntime()

  const state = getEvolutionPromotionOnlineGradeState({
    userId: owner.userId,
    promotionId: promotion.id,
  })
  assert.equal(state.grades.length, 1)
  assert.equal(state.grades[0].status, 'failed')
  assert.equal(state.grades[0].errorCode, 'EVOLUTION_PROMOTION_ONLINE_GRADER_MODEL_FAILED')
  assert.equal(state.guard.decision, 'insufficient_evidence')
  assert.equal(state.rollback, null)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_active_promotions WHERE promotion_id = ?
  `).get(promotion.id).count, 1)
})

test('promotion grade, guard, rollback, and revoke remain atomic and retryable', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-monitoring-atomic@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-monitoring-atomic-session')
  const ready = await createPromotionReadyCanary(
    owner.userId,
    sessionId,
    'promotion-monitoring-atomic-canary',
    40_000,
    { productionMonitoringEnabled: true },
  )
  const review = buildEvolutionPromotionReview({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    env: routeEnv,
  })
  const promotion = createEvolutionPromotion({
    userId: owner.userId,
    canaryReleaseId: ready.canary.id,
    reason: 'Exercise atomic production quality rollback',
    confirmations: review.confirmations,
    env: routeEnv,
    now: 42_100,
  })
  const outcomeIds = []
  for (let index = 0; index < 3; index += 1) {
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId,
      turnId: `promotion-monitoring-atomic-outcome-${index}`,
      env: routeEnv,
      now: 42_200 + index,
    })
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      modelProviderId: 'worker-provider',
      modelName: 'worker-model',
      modelRevision: 'worker-revision-1',
      evaluationInput: `Assess degraded task ${index}.`,
      evaluationOutput: `Incomplete result ${index}.`,
      now: 42_300 + index,
    })
    outcomeIds.push(getDb().prepare(`
      SELECT id FROM evolution_promotion_outcomes WHERE assignment_id = ?
    `).get(assignment.id).id)
  }
  const runModel = async () => ({
    providerId: 'independent-grader-provider',
    modelName: 'independent-grader-model',
    content: JSON.stringify({
      summary: 'The production output is materially incomplete.',
      qualityScore: 1,
      safetyVerdict: 'pass',
      evidence: ['The output does not complete the requested task.'],
      issues: ['Material result is missing.'],
    }),
  })
  for (const [index, outcomeId] of outcomeIds.slice(0, 2).entries()) {
    await runEvolutionPromotionOnlineGrade({
      userId: owner.userId,
      promotionId: promotion.id,
      outcomeId,
      now: 42_500 + index,
      runModel,
    })
  }
  getDb().exec(`
    CREATE TRIGGER fail_promotion_online_revoke
    BEFORE INSERT ON evolution_promotion_events
    WHEN NEW.event_type = 'revoked' AND NEW.promotion_id = '${promotion.id}'
    BEGIN
      SELECT RAISE(ABORT, 'injected promotion revoke failure');
    END;
  `)
  try {
    await assert.rejects(
      runEvolutionPromotionOnlineGrade({
        userId: owner.userId,
        promotionId: promotion.id,
        outcomeId: outcomeIds[2],
        now: 42_600,
        runModel,
      }),
      /injected promotion revoke failure/u,
    )
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_promotion_online_grades WHERE promotion_id = ?
    `).get(promotion.id).count, 2)
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_promotion_online_guard_evaluations
      WHERE promotion_id = ?
    `).get(promotion.id).count, 2)
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_promotion_rollbacks WHERE promotion_id = ?
    `).get(promotion.id).count, 0)
    assert.equal(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_active_promotions WHERE promotion_id = ?
    `).get(promotion.id).count, 1)
  } finally {
    getDb().exec('DROP TRIGGER IF EXISTS fail_promotion_online_revoke')
  }

  await runEvolutionPromotionOnlineGrade({
    userId: owner.userId,
    promotionId: promotion.id,
    outcomeId: outcomeIds[2],
    now: 42_700,
    runModel,
  })
  await runEvolutionPromotionOnlineGrade({
    userId: owner.userId,
    promotionId: promotion.id,
    outcomeId: outcomeIds[2],
    now: 42_800,
    runModel,
  })
  const state = getEvolutionPromotionOnlineGradeState({
    userId: owner.userId,
    promotionId: promotion.id,
  })
  assert.equal(state.grades.length, 3)
  assert.equal(state.guard.decision, 'rollback')
  assert.ok(state.rollback)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_active_promotions WHERE promotion_id = ?
  `).get(promotion.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_events
    WHERE promotion_id = ? AND event_type = 'revoked'
  `).get(promotion.id).count, 1)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_rollbacks WHERE promotion_id = ?
  `).get(promotion.id).count, 1)
})

test('canary online grade discards model evidence when manual stop wins the await race', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'canary-grade-stop-race@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'canary-grade-stop-race-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Exercise the canary grading stop fence',
    env: routeEnv,
    now: 24_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 24_001)
  createEvolutionCanaryGraderPolicy({
    userId: owner.userId,
    releaseId: canary.id,
    graderProviderId: 'independent-grader-provider',
    graderModelName: 'independent-grader-model',
    graderModelRevision: 'grader-revision-1',
    policy: {
      minimumQualityScore: 2,
      maximumQualityRegression: 0,
      maximumSafetyFailureRate: 0,
    },
    reason: 'Freeze the canary grading stop fence',
    now: 24_002,
  })
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start the canary grading stop race',
    env: routeEnv,
    now: 24_003,
  })
  const assignment = resolveEvolutionCanaryAssignment({
    userId: owner.userId,
    sessionId,
    turnId: 'canary-grade-stop-race-turn',
    env: routeEnv,
    now: 24_100,
  })
  recordEvolutionCanaryOutcome({
    userId: owner.userId,
    sessionId,
    turnId: assignment.turnId,
    terminalState: 'completed',
    durationMs: 100,
    usage: { costUsd: 0.01 },
    effectiveVariant: assignment.variant,
    decisionReason: assignment.decisionReason,
    modelProviderId: 'worker-provider',
    modelName: 'worker-model',
    modelRevision: 'worker-revision-1',
    modelConfigRevision: 1,
    evaluationInput: 'Grade the in-flight canary result.',
    evaluationOutput: 'The canary result completed before the manual stop.',
    env: routeEnv,
    now: 24_200,
  })
  const outcomeId = getDb().prepare(`
    SELECT id FROM evolution_canary_outcomes WHERE assignment_id = ?
  `).get(assignment.id).id

  let releaseModel
  let markModelStarted
  const modelStarted = new Promise((resolve) => { markModelStarted = resolve })
  const modelGate = new Promise((resolve) => { releaseModel = resolve })
  const gradePromise = runEvolutionCanaryOnlineGrade({
    userId: owner.userId,
    releaseId: canary.id,
    outcomeId,
    now: 24_300,
    runModel: async () => {
      markModelStarted()
      await modelGate
      return {
        providerId: 'independent-grader-provider',
        modelName: 'independent-grader-model',
        content: JSON.stringify({
          summary: 'The canary result is complete and safe.',
          qualityScore: 3,
          safetyVerdict: 'pass',
          evidence: ['The recorded result completes the task.'],
          issues: [],
        }),
      }
    },
  })
  await modelStarted
  stopEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Manual stop must freeze canary grading evidence',
    now: 24_400,
  })
  releaseModel()

  assert.equal(await gradePromise, null)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_online_grades WHERE release_id = ?
  `).get(canary.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_online_guard_evaluations WHERE release_id = ?
  `).get(canary.id).count, 0)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_canary_rollbacks WHERE release_id = ?
  `).get(canary.id).count, 0)
})

test('online grader records self-evaluation and model failures without ever continuing', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const scenarios = [
    {
      name: 'self',
      graderProviderId: 'worker-provider',
      graderModelName: 'worker-model',
      expectedCode: 'EVOLUTION_ONLINE_GRADER_NOT_INDEPENDENT',
      runModel: async () => { throw new Error('must not be called') },
      expectedCalls: 0,
    },
    {
      name: 'failure',
      graderProviderId: 'independent-failing-provider',
      graderModelName: 'independent-failing-model',
      expectedCode: 'EVOLUTION_ONLINE_GRADER_MODEL_FAILED',
      runModel: async () => { throw new Error('grader unavailable') },
      expectedCalls: 1,
    },
  ]
  for (const [offset, scenario] of scenarios.entries()) {
    const owner = issueTestSession({ email: `online-grader-${scenario.name}@example.com` })
    routeEnv.LOCAL_USER_ID = owner.userId
    const sessionId = createChatSession(owner.userId, `online-grader-${scenario.name}-session`)
    const seeded = seedApprovedCanary(owner.userId)
    const canary = await createTestCanary({
      userId: owner.userId,
      approvalId: seeded.approvalId,
      sessionIds: [sessionId],
      trafficPercent: 10,
      reason: `Exercise ${scenario.name} fail-closed grading`,
      env: routeEnv,
      now: 25_000 + (offset * 1_000),
    })
    declareRollbackPolicy(owner.userId, canary.id, {}, 25_001 + (offset * 1_000))
    createEvolutionCanaryGraderPolicy({
      userId: owner.userId,
      releaseId: canary.id,
      graderProviderId: scenario.graderProviderId,
      graderModelName: scenario.graderModelName,
      graderModelRevision: 'grader-revision-1',
      reason: 'Freeze the independent grader before start',
      now: 25_002 + (offset * 1_000),
    })
    startEvolutionCanary({
      userId: owner.userId,
      id: canary.id,
      reason: 'Start the fail-closed grading scenario',
      env: routeEnv,
      now: 25_003 + (offset * 1_000),
    })
    const assignment = resolveEvolutionCanaryAssignment({
      userId: owner.userId,
      sessionId,
      turnId: `online-grader-${scenario.name}-turn`,
      env: routeEnv,
      now: 25_100 + (offset * 1_000),
    })
    recordEvolutionCanaryOutcome({
      userId: owner.userId,
      sessionId,
      turnId: assignment.turnId,
      terminalState: 'completed',
      durationMs: 100,
      usage: { costUsd: 0.01 },
      effectiveVariant: assignment.variant,
      decisionReason: assignment.decisionReason,
      modelProviderId: 'worker-provider',
      modelName: 'worker-model',
      modelRevision: 'worker-revision-1',
      modelConfigRevision: 1,
      evaluationInput: 'Complete the recorded task safely.',
      evaluationOutput: 'A concrete safe result.',
      env: routeEnv,
      now: 25_200 + (offset * 1_000),
    })
    const outcomeId = getDb().prepare(`
      SELECT id FROM evolution_canary_outcomes WHERE assignment_id = ?
    `).get(assignment.id).id
    const pendingState = getEvolutionCanaryOnlineGradeState({
      userId: owner.userId,
      releaseId: canary.id,
    })
    assert.deepEqual(pendingState.outcomes, [{
      id: outcomeId,
      variant: assignment.variant,
      terminalState: 'completed',
      createdAt: 25_200 + (offset * 1_000),
      graded: false,
      gradeStatus: null,
    }])
    let calls = 0
    await assert.rejects(
      runEvolutionCanaryOnlineGrade({
        userId: owner.userId,
        releaseId: canary.id,
        outcomeId,
        now: 25_300 + (offset * 1_000),
        runModel: async (...args) => {
          calls += 1
          return scenario.runModel(...args)
        },
      }),
      (error) => error.code === scenario.expectedCode,
    )
    assert.equal(calls, scenario.expectedCalls)
    const state = getEvolutionCanaryOnlineGradeState({ userId: owner.userId, releaseId: canary.id })
    assert.equal(state.outcomes[0].id, outcomeId)
    assert.equal(state.outcomes[0].graded, true)
    assert.equal(state.outcomes[0].gradeStatus, 'failed')
    assert.equal(state.grades[0].status, 'failed')
    assert.equal(state.grades[0].errorCode, scenario.expectedCode)
    assert.equal(state.guard.decision, 'insufficient_evidence')
    assert.equal(state.currentEvidence.decision, 'insufficient_evidence')
    assert.equal(state.currentEvidence.blockers.includes('grader_execution_failed'), true)
  }
})

test('online quality and safety thresholds trigger exactly one automatic rollback', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'online-grader-rollback@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'online-grader-rollback-session')
  const seeded = seedApprovedCanary(owner.userId)
  const canary = await createTestCanary({
    userId: owner.userId,
    approvalId: seeded.approvalId,
    sessionIds: [sessionId],
    trafficPercent: 10,
    reason: 'Exercise online quality and safety rollback',
    env: routeEnv,
    now: 28_000,
  })
  declareRollbackPolicy(owner.userId, canary.id, {}, 28_001)
  createEvolutionCanaryGraderPolicy({
    userId: owner.userId,
    releaseId: canary.id,
    graderProviderId: 'quality-grader-provider',
    graderModelName: 'quality-grader-model',
    graderModelRevision: 'quality-grader-revision-1',
    policy: {
      minimumQualityScore: 2,
      maximumQualityRegression: 0,
      maximumSafetyFailureRate: 0,
    },
    reason: 'Freeze strict online quality and safety thresholds',
    now: 28_002,
  })
  startEvolutionCanary({
    userId: owner.userId,
    id: canary.id,
    reason: 'Start the online quality rollback scenario',
    env: routeEnv,
    now: 28_003,
  })
  const assignments = collectCanaryAssignments(owner.userId, sessionId, 'online-quality-turn', 28_100)
  const outcomes = []
  for (const variant of ['baseline', 'candidate']) {
    for (const [index, assignment] of assignments[variant].entries()) {
      recordEvolutionCanaryOutcome({
        userId: owner.userId,
        sessionId,
        turnId: assignment.turnId,
        terminalState: 'completed',
        durationMs: 100,
        usage: { costUsd: 0.01 },
        effectiveVariant: assignment.variant,
        decisionReason: assignment.decisionReason,
        modelProviderId: 'worker-provider',
        modelName: 'worker-model',
        modelRevision: 'worker-revision-1',
        modelConfigRevision: 1,
        evaluationInput: `Complete ${variant} task ${index}`,
        evaluationOutput: `${variant} task result ${index}`,
        env: routeEnv,
        now: 29_000 + outcomes.length,
      })
      outcomes.push({
        variant,
        id: getDb().prepare(`
          SELECT id FROM evolution_canary_outcomes WHERE assignment_id = ?
        `).get(assignment.id).id,
      })
    }
  }
  for (const [index, outcome] of outcomes.entries()) {
    const runGrade = () => runEvolutionCanaryOnlineGrade({
      userId: owner.userId,
      releaseId: canary.id,
      outcomeId: outcome.id,
      now: 30_000 + index,
      runModel: async () => ({
        providerId: 'quality-grader-provider',
        modelName: 'quality-grader-model',
        content: JSON.stringify({
          summary: 'Structured online assessment.',
          qualityScore: outcome.variant === 'candidate' ? 1 : 3,
          safetyVerdict: outcome.variant === 'candidate' ? 'fail' : 'pass',
          evidence: [`${outcome.variant} evidence is explicit.`],
          issues: outcome.variant === 'candidate' ? ['unsafe regression'] : [],
        }),
      }),
    })
    if (index === outcomes.length - 1) {
      getDb().exec(`
        CREATE TEMP TRIGGER reject_online_rollback
        BEFORE INSERT ON evolution_canary_rollbacks
        WHEN NEW.online_guard_evaluation_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'injected online rollback failure');
        END;
      `)
      await assert.rejects(runGrade(), /injected online rollback failure/u)
      assert.equal(getDb().prepare(`
        SELECT COUNT(*) AS count FROM evolution_canary_online_grades WHERE outcome_id = ?
      `).get(outcome.id).count, 0)
      assert.equal(getDb().prepare(`
        SELECT COUNT(*) AS count FROM evolution_canary_online_guard_evaluations
        WHERE trigger_grade_id IN (
          SELECT id FROM evolution_canary_online_grades WHERE outcome_id = ?
        )
      `).get(outcome.id).count, 0)
      assert.equal(getDb().prepare(`
        SELECT COUNT(*) AS count FROM evolution_canary_rollbacks WHERE release_id = ?
      `).get(canary.id).count, 0)
      getDb().exec('DROP TRIGGER reject_online_rollback')
    }
    await runGrade()
  }
  const state = getEvolutionCanaryOnlineGradeState({ userId: owner.userId, releaseId: canary.id })
  assert.equal(state.guard.decision, 'rollback')
  assert.deepEqual(state.guard.breaches, [
    'minimum_quality_score',
    'maximum_quality_regression',
    'maximum_safety_failure_rate',
  ])
  const rollbackRows = getDb().prepare(`
    SELECT * FROM evolution_canary_rollbacks WHERE release_id = ?
  `).all(canary.id)
  assert.equal(rollbackRows.length, 1)
  assert.equal(Boolean(rollbackRows[0].online_guard_evaluation_id), true)
  assert.match(rollbackRows[0].reason, /online_quality_safety/u)
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

  const retiredCostPolicy = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: { ...DEFAULT_ROLLBACK_POLICY, maximumCostRatio: 2 },
        reason: 'A retired Provider cost gate must be rejected',
      },
    },
  )
  assert.equal(retiredCostPolicy.status, 400)
  assert.equal(
    (await retiredCostPolicy.json()).error.code,
    'EVOLUTION_CANARY_ROLLBACK_POLICY_FIELD_RETIRED',
  )

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

  const forbiddenGraderPolicy = await request(
    other.token,
    `/api/evolution/canaries/${created.id}/online-grader-policy`,
    {
      method: 'POST',
      body: {
        graderProviderId: 'route-grader-provider',
        graderModelName: 'route-grader-model',
        graderModelRevision: 'route-grader-revision-1',
        reason: 'Another user cannot freeze the grader',
      },
    },
  )
  assert.equal(forbiddenGraderPolicy.status, 403)
  assert.equal((await forbiddenGraderPolicy.json()).error.code, 'LOCAL_OWNER_ONLY')

  const graderPolicyResponse = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/online-grader-policy`,
    {
      method: 'POST',
      body: {
        graderProviderId: 'route-grader-provider',
        graderModelName: 'route-grader-model',
        graderModelRevision: 'route-grader-revision-1',
        policy: {
          minimumQualityScore: 2,
          maximumQualityRegression: 0,
          maximumSafetyFailureRate: 0,
        },
        reason: 'Freeze the independent online grader before start',
      },
    },
  )
  assert.equal(graderPolicyResponse.status, 201)
  const graderPolicy = (await graderPolicyResponse.json()).policy
  assert.equal(graderPolicy.version, 'canary-online-grader-v1')
  assert.match(graderPolicy.policyFingerprint, /^[a-f0-9]{64}$/u)

  const forbiddenGrades = await request(
    other.token,
    `/api/evolution/canaries/${created.id}/online-grades`,
  )
  assert.equal(forbiddenGrades.status, 403)
  const gradesResponse = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/online-grades`,
  )
  assert.equal(gradesResponse.status, 200)
  assert.equal(gradesResponse.headers.get('cache-control'), 'no-store')
  const onlineState = (await gradesResponse.json()).state
  assert.equal(onlineState.policy.policyFingerprint, graderPolicy.policyFingerprint)
  assert.equal(onlineState.currentEvidence.decision, 'insufficient_evidence')

  const duplicatePolicy = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/rollback-policy`,
    {
      method: 'POST',
      body: {
        policy: DEFAULT_ROLLBACK_POLICY,
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

  const lockedGraderPolicy = await request(
    owner.token,
    `/api/evolution/canaries/${created.id}/online-grader-policy`,
    {
      method: 'POST',
      body: {
        graderProviderId: 'replacement-provider',
        graderModelName: 'replacement-model',
        graderModelRevision: 'replacement-revision',
        reason: 'Cannot replace the frozen grader after start',
      },
    },
  )
  assert.equal(lockedGraderPolicy.status, 409)
  assert.equal((await lockedGraderPolicy.json()).error.code, 'EVOLUTION_ONLINE_GRADER_POLICY_LOCKED')

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

test('promotion API is local-owner-only and requires the exact reviewed immutable fingerprints', async () => {
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), '# Workspace\n\nUse the approved baseline.\n')
  const owner = issueTestSession({ email: 'promotion-route-owner@example.com' })
  const other = issueTestSession({ email: 'promotion-route-other@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  const sessionId = createChatSession(owner.userId, 'promotion-route-session')
  const ready = await createPromotionReadyCanary(owner.userId, sessionId, 'promotion-route-turn', 30_000)
  const reviewPath = `/api/evolution/canaries/${ready.canary.id}/promotion-review`

  const forbiddenReview = await request(other.token, reviewPath)
  assert.equal(forbiddenReview.status, 403)
  assert.equal((await forbiddenReview.json()).error.code, 'LOCAL_OWNER_ONLY')

  const reviewResponse = await request(owner.token, reviewPath)
  assert.equal(reviewResponse.status, 200)
  assert.equal(reviewResponse.headers.get('cache-control'), 'no-store')
  const review = (await reviewResponse.json()).review
  assert.equal(review.guard.decision, 'continue')

  const stale = await request(owner.token, '/api/evolution/promotions', {
    method: 'POST',
    body: {
      canaryReleaseId: ready.canary.id,
      reason: 'Reject stale confirmation',
      confirmations: { ...review.confirmations, candidateContentSha256: '0'.repeat(64) },
    },
  })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'EVOLUTION_PROMOTION_CONFIRMATION_MISMATCH')

  const createdResponse = await request(owner.token, '/api/evolution/promotions', {
    method: 'POST',
    body: {
      canaryReleaseId: ready.canary.id,
      reason: 'Activate reviewed production candidate',
      confirmations: review.confirmations,
    },
  })
  assert.equal(createdResponse.status, 201)
  const promotion = (await createdResponse.json()).promotion
  assert.equal(promotion.state, 'active')

  const listedResponse = await request(owner.token, '/api/evolution/promotions')
  assert.equal(listedResponse.status, 200)
  assert.equal((await listedResponse.json()).promotions[0].id, promotion.id)

  const forbiddenRevoke = await request(other.token, `/api/evolution/promotions/${promotion.id}/revoke`, {
    method: 'POST', body: { reason: 'Not the owner' },
  })
  assert.equal(forbiddenRevoke.status, 403)

  const revokedResponse = await request(owner.token, `/api/evolution/promotions/${promotion.id}/revoke`, {
    method: 'POST', body: { reason: 'Explicit route-level revoke' },
  })
  assert.equal(revokedResponse.status, 200)
  assert.equal((await revokedResponse.json()).promotion.state, 'revoked')
})
