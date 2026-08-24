import { createHash, randomUUID } from 'node:crypto'

import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { getDb } from '../db.js'
import { getEvolutionApprovalDecision } from './evolutionApprovalService.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import { getEvolutionEvaluation } from './evolutionEvaluationService.js'
import { assertEvolutionOnlineGuardPassed } from './evolutionOnlineGraderService.js'
import { enqueueEvolutionPromotionOutcomeGrade } from './evolutionOnlineGraderRuntime.js'
import { recordEvolutionPromotionOutcomeSnapshot } from './evolutionPromotionOnlineGraderService.js'
import { getEvolutionReplayRun } from './evolutionReplayService.js'
import { evolutionRollbackDecisionMetrics } from './evolutionRollbackService.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

const SUPPORTED_TARGET = 'prompt:workspace-instructions'
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const AUTOMATIC_PROMOTION_RUN_STATES = new Set(['canary_active', 'validated'])
const MAX_LIMIT = 100

function serviceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function ownerId(value) {
  const owner = String(value || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return owner
}

function timestamp(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw serviceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return number
}

function boundedReason(value, code = 'EVOLUTION_PROMOTION_REASON_INVALID') {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2_000) {
    throw serviceError(code, 'reason must contain between 1 and 2000 characters')
  }
  return sanitizeEvolutionText(raw)
}

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_PROMOTION_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function currentWorkspaceInstructions(env) {
  const text = String(readWorkspaceInstructions({ env })?.text || '').trim()
  if (!text) {
    throw serviceError('EVOLUTION_PROMOTION_BASELINE_UNAVAILABLE', 'workspace instructions are not available', 409)
  }
  return text
}

function promotionRow(userId, id) {
  const row = getDb().prepare(`
    SELECT * FROM evolution_promotions WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), userId)
  if (!row) throw serviceError('EVOLUTION_PROMOTION_NOT_FOUND', 'promotion was not found', 404)
  return row
}

function canaryRow(userId, id) {
  const row = getDb().prepare(`
    SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), userId)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  return row
}

function latestCanaryEvent(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_events WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
}

function policyForRelease(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_policies WHERE release_id = ?
  `).get(releaseId) || null
}

function latestGuardEvaluation(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_evaluations
    WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
}

function automaticPromotionRun(owner, automationRunId, evidence) {
  const runId = String(automationRunId || '').trim()
  const run = runId && getDb().prepare(`
    SELECT run.*, config.enabled AS config_enabled,
      config.target AS config_target, config.config_revision AS current_config_revision
    FROM evolution_auto_runs AS run
    JOIN evolution_auto_configs AS config ON config.user_id = run.user_id
    WHERE run.id = ? AND run.user_id = ?
  `).get(runId, owner)
  if (!run
    || !AUTOMATIC_PROMOTION_RUN_STATES.has(run.state)
    || run.config_enabled !== 1
    || run.current_config_revision !== run.config_revision
    || run.config_target !== SUPPORTED_TARGET
    || run.candidate_id !== evidence.candidate.id
    || run.replay_id !== evidence.replay.id
    || run.evaluation_id !== evidence.evaluation.id
    || run.approval_id !== evidence.approval.id
    || run.canary_id !== evidence.release.id
    || run.promotion_id
    || evidence.approval.decisionOrigin !== 'automatic_policy'
    || evidence.approval.automationRunId !== runId
    || evidence.onlineEvidence.policy.productionMonitoringEnabled !== true) {
    throw serviceError(
      'EVOLUTION_AUTOMATIC_PROMOTION_INVALID',
      'automatic promotion requires an enabled, unchanged workspace-prompt run with production monitoring',
      409,
    )
  }
  return run
}

function policyValue(row) {
  return {
    windowSize: row.window_size,
    minimumCandidateOutcomes: row.minimum_candidate_outcomes,
    minimumBaselineOutcomes: row.minimum_baseline_outcomes,
    maximumCandidateFailureRate: row.maximum_candidate_failure_rate,
    maximumCandidateCancellationRate: row.maximum_candidate_cancellation_rate,
    maximumLatencyRatio: row.maximum_latency_ratio,
  }
}

function legacyPolicyValue(row) {
  return { ...policyValue(row), maximumCostRatio: row.maximum_cost_ratio }
}

function assertConfirmations(value, expected) {
  const confirmations = value && typeof value === 'object' ? value : {}
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (String(confirmations[key] || '').trim() !== expectedValue) {
      throw serviceError(
        'EVOLUTION_PROMOTION_CONFIRMATION_MISMATCH',
        `promotion confirmation ${key} does not match the reviewed release`,
        409,
      )
    }
  }
}

function assertPromotionEvidence(owner, releaseId, env) {
  const release = canaryRow(owner, releaseId)
  const event = latestCanaryEvent(release.id)
  if (event?.event_type !== 'stopped') {
    throw serviceError(
      'EVOLUTION_PROMOTION_CANARY_NOT_STOPPED',
      'canary must be explicitly stopped before promotion',
      409,
    )
  }
  if (getDb().prepare('SELECT 1 FROM evolution_canary_rollbacks WHERE release_id = ?').get(release.id)) {
    throw serviceError(
      'EVOLUTION_PROMOTION_CANARY_ROLLED_BACK',
      'an automatically rolled back canary cannot be promoted',
      409,
    )
  }
  const policy = policyForRelease(release.id)
  if (!policy) {
    throw serviceError(
      'EVOLUTION_PROMOTION_ROLLBACK_POLICY_REQUIRED',
      'an immutable rollback policy is required before promotion',
      409,
    )
  }
  const guard = latestGuardEvaluation(release.id)
  if (!guard || guard.decision !== 'continue') {
    throw serviceError(
      'EVOLUTION_PROMOTION_GUARD_NOT_PASSED',
      'the latest canary guard decision must be continue',
      409,
    )
  }
  const metrics = parseJson(guard.metrics_json, {})
  if (Number(metrics?.candidate?.outcomes) < policy.minimum_candidate_outcomes
    || Number(metrics?.baseline?.outcomes) < policy.minimum_baseline_outcomes
    || metrics?.evidence?.candidateReady !== true
    || metrics?.evidence?.baselineReady !== true) {
    throw serviceError(
      'EVOLUTION_PROMOTION_EVIDENCE_INSUFFICIENT',
      'canary samples do not satisfy the immutable promotion threshold',
      409,
    )
  }
  const onlineEvidence = assertEvolutionOnlineGuardPassed({
    userId: owner,
    releaseId: release.id,
  })

  const approval = getEvolutionApprovalDecision({ userId: owner, id: release.approval_id })
  const candidate = getEvolutionCandidate({ userId: owner, id: release.candidate_id })
  const replay = getEvolutionReplayRun({ userId: owner, id: release.replay_id })
  const evaluation = getEvolutionEvaluation({ userId: owner, id: release.evaluation_id })
  const sessionIds = parseJson(release.session_ids_json, [])
  const expectedReleaseFingerprint = sha256({
    approvalFingerprint: approval.decisionFingerprint,
    target: candidate.target,
    trafficPercent: release.traffic_percent,
    sessionIds,
    baselineSha256: replay.baselineSha256,
    candidateSha256: candidate.contentSha256,
  })
  const expectedPolicyFingerprint = sha256({
    version: policy.policy_version,
    releaseFingerprint: release.release_fingerprint,
    baselineSha256: release.baseline_sha256,
    policy: policyValue(policy),
  })
  const legacyExpectedPolicyFingerprint = sha256({
    version: policy.policy_version,
    releaseFingerprint: release.release_fingerprint,
    baselineSha256: release.baseline_sha256,
    policy: legacyPolicyValue(policy),
  })
  const guardMetrics = parseJson(guard.metrics_json, {})
  const guardBreaches = parseJson(guard.breaches_json, [])
  const expectedGuardFingerprint = sha256({
    policyFingerprint: policy.policy_fingerprint,
    outcomeId: guard.outcome_id,
    metrics: evolutionRollbackDecisionMetrics(guardMetrics),
    breaches: guardBreaches,
    decision: guard.decision,
  })
  const legacyExpectedGuardFingerprint = sha256({
    policyFingerprint: policy.policy_fingerprint,
    outcomeId: guard.outcome_id,
    metrics: guardMetrics,
    breaches: guardBreaches,
    decision: guard.decision,
  })
  if (approval.decision !== 'approved'
    || candidate.kind !== 'prompt'
    || candidate.target !== SUPPORTED_TARGET
    || candidate.permissionsRequested.length > 0
    || evaluation.verdict !== 'pass'
    || release.approval_id !== approval.id
    || release.evaluation_id !== evaluation.id
    || release.replay_id !== replay.id
    || release.candidate_id !== candidate.id
    || evaluation.replayId !== replay.id
    || evaluation.candidateId !== candidate.id
    || replay.candidateId !== candidate.id
    || sha256(replay.baselineContent) !== replay.baselineSha256
    || sha256(candidate.content) !== candidate.contentSha256
    || replay.candidateSha256 !== candidate.contentSha256
    || approval.confirmations.candidateContentSha256 !== candidate.contentSha256
    || approval.confirmations.replayRunFingerprint !== replay.runFingerprint
    || approval.confirmations.evaluationFingerprint !== evaluation.evaluationFingerprint
    || approval.confirmations.rollbackBaselineSha256 !== replay.baselineSha256
    || release.target !== candidate.target
    || release.baseline_sha256 !== replay.baselineSha256
    || release.candidate_sha256 !== candidate.contentSha256
    || release.release_fingerprint !== expectedReleaseFingerprint
    || policy.baseline_sha256 !== release.baseline_sha256
    || policy.release_fingerprint !== release.release_fingerprint
    || (policy.policy_fingerprint !== expectedPolicyFingerprint
      && policy.policy_fingerprint !== legacyExpectedPolicyFingerprint)
    || guard.policy_id !== policy.id
    || (guard.evaluation_fingerprint !== expectedGuardFingerprint
      && guard.evaluation_fingerprint !== legacyExpectedGuardFingerprint)
    || guardBreaches.length !== 0) {
    throw serviceError(
      'EVOLUTION_PROMOTION_PROVENANCE_MISMATCH',
      'promotion provenance is inconsistent with the approved canary release',
      409,
    )
  }
  const baselineContent = currentWorkspaceInstructions(env)
  if (sha256(baselineContent) !== release.baseline_sha256) {
    throw serviceError(
      'EVOLUTION_PROMOTION_BASELINE_MISMATCH',
      'active workspace instructions differ from the approved rollback baseline',
      409,
    )
  }
  return {
    release,
    policy,
    guard,
    approval,
    candidate,
    replay,
    evaluation,
    metrics,
    onlineEvidence,
  }
}

function confirmationView(evidence) {
  return {
    canaryReleaseFingerprint: evidence.release.release_fingerprint,
    candidateContentSha256: evidence.candidate.contentSha256,
    rollbackBaselineSha256: evidence.release.baseline_sha256,
    rollbackPolicyFingerprint: evidence.policy.policy_fingerprint,
    onlineGraderPolicyFingerprint: evidence.onlineEvidence.policy.policyFingerprint,
    onlineGuardEvaluationFingerprint: evidence.onlineEvidence.guard.evaluationFingerprint,
  }
}

function promotionFingerprint(input) {
  const fingerprint = {
    canaryReleaseFingerprint: input.canaryReleaseFingerprint,
    rollbackPolicyFingerprint: input.rollbackPolicyFingerprint,
    approvalFingerprint: input.approvalFingerprint,
    replayFingerprint: input.replayFingerprint,
    evaluationFingerprint: input.evaluationFingerprint,
    onlineGraderPolicyFingerprint: input.onlineGraderPolicyFingerprint,
    onlineGuardEvaluationFingerprint: input.onlineGuardEvaluationFingerprint,
    target: input.target,
    baselineSha256: input.baselineSha256,
    candidateSha256: input.candidateSha256,
  }
  if (input.decisionOrigin === 'automatic_policy') {
    fingerprint.decisionOrigin = input.decisionOrigin
    fingerprint.automationRunId = input.automationRunId
  }
  return sha256(fingerprint)
}

function hasValidPromotionSnapshot(promotion) {
  return Boolean(promotion)
    && sha256(promotion.candidate_content) === promotion.candidate_sha256
    && promotionFingerprint({
      canaryReleaseFingerprint: promotion.canary_release_fingerprint,
      rollbackPolicyFingerprint: promotion.rollback_policy_fingerprint,
      approvalFingerprint: promotion.approval_fingerprint,
      replayFingerprint: promotion.replay_fingerprint,
      evaluationFingerprint: promotion.evaluation_fingerprint,
      onlineGraderPolicyFingerprint: promotion.online_grader_policy_fingerprint,
      onlineGuardEvaluationFingerprint: promotion.online_guard_evaluation_fingerprint,
      target: promotion.target,
      baselineSha256: promotion.baseline_sha256,
      candidateSha256: promotion.candidate_sha256,
      decisionOrigin: promotion.decision_origin,
      automationRunId: promotion.automation_run_id,
    }) === promotion.promotion_fingerprint
}

function promotionStats(id) {
  const assignments = Number(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_promotion_assignments WHERE promotion_id = ?
  `).get(id)?.count) || 0
  const rows = getDb().prepare(`
    SELECT terminal_state, COUNT(*) AS count FROM evolution_promotion_outcomes
    WHERE promotion_id = ? GROUP BY terminal_state
  `).all(id)
  const outcomes = { completed: 0, failed: 0, cancelled: 0 }
  for (const row of rows) outcomes[row.terminal_state] = Number(row.count) || 0
  return { assignments, outcomes }
}

function promotionView(row) {
  const event = getDb().prepare(`
    SELECT event_type, reason, created_at FROM evolution_promotion_events
    WHERE promotion_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(row.id) || null
  const active = Boolean(getDb().prepare(`
    SELECT 1 FROM evolution_active_promotions WHERE promotion_id = ?
  `).get(row.id))
  return {
    id: row.id,
    canaryReleaseId: row.canary_release_id,
    approvalId: row.approval_id,
    evaluationId: row.evaluation_id,
    replayId: row.replay_id,
    candidateId: row.candidate_id,
    target: row.target,
    promotionReason: row.promotion_reason,
    baselineSha256: row.baseline_sha256,
    candidateSha256: row.candidate_sha256,
    canaryReleaseFingerprint: row.canary_release_fingerprint,
    rollbackPolicyFingerprint: row.rollback_policy_fingerprint,
    onlineGraderPolicyFingerprint: row.online_grader_policy_fingerprint || null,
    onlineGuardEvaluationFingerprint: row.online_guard_evaluation_fingerprint || null,
    approvalFingerprint: row.approval_fingerprint,
    replayFingerprint: row.replay_fingerprint,
    evaluationFingerprint: row.evaluation_fingerprint,
    promotionFingerprint: row.promotion_fingerprint,
    decisionOrigin: row.decision_origin || 'human_review',
    automationRunId: row.automation_run_id || null,
    state: active ? 'active' : 'revoked',
    stateReason: event?.reason || row.promotion_reason,
    stateChangedAt: event?.created_at || row.created_at,
    stats: promotionStats(row.id),
    createdAt: row.created_at,
  }
}

function automaticPromotionPolicyCurrent(promotion) {
  if (promotion?.decision_origin !== 'automatic_policy' || !promotion.automation_run_id) return true
  const row = getDb().prepare(`
    SELECT run.state, run.promotion_id, run.config_revision,
      config.enabled, config.config_revision AS current_config_revision
    FROM evolution_auto_runs AS run
    JOIN evolution_auto_configs AS config ON config.user_id = run.user_id
    WHERE run.id = ? AND run.user_id = ?
  `).get(promotion.automation_run_id, promotion.user_id)
  return Boolean(row)
    && row.state === 'promoted'
    && row.promotion_id === promotion.id
    && row.enabled === 1
    && row.current_config_revision === row.config_revision
}

function rollbackAutomaticPromotionSnapshot({ promotion, reason, code, now }) {
  if (promotion?.decision_origin !== 'automatic_policy' || !promotion.automation_run_id) return false
  const rolledBackAt = timestamp(now)
  const message = boundedReason(reason, 'EVOLUTION_PROMOTION_REVOKE_REASON_INVALID')
  const db = getDb()
  return db.transaction(() => {
    const removed = db.prepare(`
      DELETE FROM evolution_active_promotions
      WHERE user_id = ? AND target = ? AND promotion_id = ?
    `).run(promotion.user_id, promotion.target, promotion.id)
    if (removed.changes !== 1) return false
    db.prepare(`
      INSERT INTO evolution_promotion_events (
        id, user_id, promotion_id, event_type, reason, created_at
      ) VALUES (?, ?, ?, 'revoked', ?, ?)
    `).run(randomUUID(), promotion.user_id, promotion.id, message, rolledBackAt)
    db.prepare(`
      UPDATE evolution_auto_runs
      SET state = 'rolled_back', stage = 'production_snapshot_rollback',
        error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND user_id = ? AND promotion_id = ? AND state = 'promoted'
    `).run(
      String(code || 'EVOLUTION_AUTOMATIC_PROMOTION_SNAPSHOT_DRIFT').slice(0, 160),
      message,
      rolledBackAt,
      rolledBackAt,
      promotion.automation_run_id,
      promotion.user_id,
      promotion.id,
    )
    return true
  }).immediate()
}

export function buildEvolutionPromotionReview({ userId, canaryReleaseId, env = process.env } = {}) {
  const owner = ownerId(userId)
  const evidence = assertPromotionEvidence(owner, canaryReleaseId, env)
  return {
    schemaVersion: 1,
    canaryReleaseId: evidence.release.id,
    candidate: {
      id: evidence.candidate.id,
      title: evidence.candidate.title,
      summary: evidence.candidate.summary,
      target: evidence.candidate.target,
      contentSha256: evidence.candidate.contentSha256,
    },
    guard: {
      decision: evidence.guard.decision,
      metrics: evidence.metrics,
      evaluationFingerprint: evidence.guard.evaluation_fingerprint,
    },
    onlineGuard: evidence.onlineEvidence.guard,
    confirmations: confirmationView(evidence),
  }
}

function createEvolutionPromotionWithOrigin({
  userId,
  canaryReleaseId,
  reason: reasonValue,
  confirmations,
  decisionOrigin = 'human_review',
  automationRunId = null,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const reason = boundedReason(reasonValue)
  const origin = decisionOrigin === 'automatic_policy' ? 'automatic_policy' : 'human_review'
  const automaticRunId = origin === 'automatic_policy'
    ? String(automationRunId || '').trim()
    : null
  const createdAt = timestamp(now)
  const id = randomUUID()
  const db = getDb()
  try {
    db.transaction(() => {
      const evidence = assertPromotionEvidence(owner, canaryReleaseId, env)
      const expectedConfirmations = confirmationView(evidence)
      assertConfirmations(confirmations, expectedConfirmations)
      const automationRun = origin === 'automatic_policy'
        ? automaticPromotionRun(owner, automaticRunId, evidence)
        : null
      if (origin === 'human_review' && evidence.approval.decisionOrigin !== 'human_review') {
        throw serviceError(
          'EVOLUTION_PROMOTION_APPROVAL_ORIGIN_MISMATCH',
          'an automatic approval can only be promoted by its automatic policy run',
          409,
        )
      }
      const activeCanary = db.prepare(`
        SELECT canary.id FROM evolution_canary_releases AS canary
        WHERE canary.user_id = ? AND canary.target = ?
          AND (SELECT event_type FROM evolution_canary_events
            WHERE release_id = canary.id ORDER BY rowid DESC LIMIT 1) = 'started'
          AND NOT EXISTS (
            SELECT 1 FROM evolution_canary_rollbacks AS rollback WHERE rollback.release_id = canary.id
          )
        LIMIT 1
      `).get(owner, evidence.release.target)
      if (activeCanary) {
        throw serviceError(
          'EVOLUTION_PROMOTION_CANARY_ACTIVE_CONFLICT',
          'an active canary owns this target',
          409,
        )
      }
      if (db.prepare(`
        SELECT 1 FROM evolution_active_promotions WHERE user_id = ? AND target = ?
      `).get(owner, evidence.release.target)) {
        throw serviceError(
          'EVOLUTION_PROMOTION_ACTIVE_CONFLICT',
          'an active production promotion already owns this target',
          409,
        )
      }
      const fingerprintInput = {
        canaryReleaseFingerprint: evidence.release.release_fingerprint,
        rollbackPolicyFingerprint: evidence.policy.policy_fingerprint,
        approvalFingerprint: evidence.approval.decisionFingerprint,
        replayFingerprint: evidence.replay.runFingerprint,
        evaluationFingerprint: evidence.evaluation.evaluationFingerprint,
        onlineGraderPolicyFingerprint: evidence.onlineEvidence.policy.policyFingerprint,
        onlineGuardEvaluationFingerprint: evidence.onlineEvidence.guard.evaluationFingerprint,
        target: evidence.release.target,
        baselineSha256: evidence.release.baseline_sha256,
        candidateSha256: evidence.release.candidate_sha256,
        decisionOrigin: origin,
        automationRunId: automaticRunId,
      }
      const fingerprint = promotionFingerprint(fingerprintInput)
      db.prepare(`
        INSERT INTO evolution_promotions (
          id, user_id, canary_release_id, approval_id, evaluation_id, replay_id,
          candidate_id, target, promotion_reason, baseline_sha256, candidate_sha256,
          candidate_content, canary_release_fingerprint, rollback_policy_fingerprint,
          approval_fingerprint, replay_fingerprint, evaluation_fingerprint,
          promotion_fingerprint, created_at, online_grader_policy_fingerprint,
          online_guard_evaluation_fingerprint, decision_origin, automation_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        owner,
        evidence.release.id,
        evidence.approval.id,
        evidence.evaluation.id,
        evidence.replay.id,
        evidence.candidate.id,
        evidence.release.target,
        reason,
        evidence.release.baseline_sha256,
        evidence.release.candidate_sha256,
        evidence.candidate.content,
        fingerprintInput.canaryReleaseFingerprint,
        fingerprintInput.rollbackPolicyFingerprint,
        fingerprintInput.approvalFingerprint,
        fingerprintInput.replayFingerprint,
        fingerprintInput.evaluationFingerprint,
        fingerprint,
        createdAt,
        fingerprintInput.onlineGraderPolicyFingerprint,
        fingerprintInput.onlineGuardEvaluationFingerprint,
        origin,
        automaticRunId,
      )
      db.prepare(`
        INSERT INTO evolution_promotion_events (
          id, user_id, promotion_id, event_type, reason, created_at
        ) VALUES (?, ?, ?, 'activated', ?, ?)
      `).run(randomUUID(), owner, id, reason, createdAt)
      db.prepare(`
        INSERT INTO evolution_active_promotions (user_id, target, promotion_id, activated_at)
        VALUES (?, ?, ?, ?)
      `).run(owner, evidence.release.target, id, createdAt)
      if (automationRun) {
        const promoted = db.prepare(`
          UPDATE evolution_auto_runs
          SET state = 'promoted', stage = 'production_promoted', promotion_id = ?,
            updated_at = ?, finished_at = ?
          WHERE id = ? AND user_id = ? AND promotion_id IS NULL
            AND state IN ('canary_active', 'validated')
        `).run(id, createdAt, createdAt, automationRun.id, owner)
        if (promoted.changes !== 1) {
          throw serviceError(
            'EVOLUTION_AUTOMATIC_PROMOTION_FENCE_LOST',
            'automatic promotion run changed before activation',
            409,
          )
        }
      }
    }).immediate()
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      throw serviceError(
        'EVOLUTION_PROMOTION_ALREADY_EXISTS',
        'canary release has already been promoted or the target is active',
        409,
      )
    }
    throw error
  }
  return getEvolutionPromotion({ userId: owner, id })
}

export function createEvolutionPromotion(input = {}) {
  return createEvolutionPromotionWithOrigin({
    ...input,
    decisionOrigin: 'human_review',
    automationRunId: null,
  })
}

export function createEvolutionAutomaticPromotion({
  userId,
  automationRunId,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const runId = String(automationRunId || '').trim()
  const existing = runId && getDb().prepare(`
    SELECT id FROM evolution_promotions
    WHERE user_id = ? AND automation_run_id = ?
  `).get(owner, runId)
  if (existing) return getEvolutionPromotion({ userId: owner, id: existing.id })
  const run = runId && getDb().prepare(`
    SELECT canary_id FROM evolution_auto_runs WHERE id = ? AND user_id = ?
  `).get(runId, owner)
  if (!run?.canary_id) {
    throw serviceError(
      'EVOLUTION_AUTOMATIC_PROMOTION_INVALID',
      'automatic promotion requires a canary-linked automation run',
      409,
    )
  }
  const review = buildEvolutionPromotionReview({
    userId: owner,
    canaryReleaseId: run.canary_id,
    env,
  })
  try {
    return createEvolutionPromotionWithOrigin({
      userId: owner,
      canaryReleaseId: run.canary_id,
      reason: 'Automatically promoted by the explicitly enabled workspace-prompt policy after both canary guards passed.',
      confirmations: review.confirmations,
      decisionOrigin: 'automatic_policy',
      automationRunId: runId,
      env,
      now,
    })
  } catch (error) {
    if (error?.code === 'EVOLUTION_PROMOTION_ALREADY_EXISTS') {
      const concurrent = getDb().prepare(`
        SELECT id FROM evolution_promotions
        WHERE user_id = ? AND automation_run_id = ?
      `).get(owner, runId)
      if (concurrent) return getEvolutionPromotion({ userId: owner, id: concurrent.id })
    }
    throw error
  }
}

export function revokeEvolutionPromotion({ userId, id, reason: reasonValue, now = Date.now() } = {}) {
  const owner = ownerId(userId)
  const row = promotionRow(owner, id)
  const reason = boundedReason(reasonValue, 'EVOLUTION_PROMOTION_REVOKE_REASON_INVALID')
  const revokedAt = timestamp(now)
  const db = getDb()
  db.transaction(() => {
    const removed = db.prepare(`
      DELETE FROM evolution_active_promotions
      WHERE user_id = ? AND target = ? AND promotion_id = ?
    `).run(owner, row.target, row.id)
    if (removed.changes !== 1) {
      throw serviceError('EVOLUTION_PROMOTION_NOT_ACTIVE', 'promotion is not active', 409)
    }
    db.prepare(`
      INSERT INTO evolution_promotion_events (
        id, user_id, promotion_id, event_type, reason, created_at
      ) VALUES (?, ?, ?, 'revoked', ?, ?)
    `).run(randomUUID(), owner, row.id, reason, revokedAt)
    if (row.decision_origin === 'automatic_policy' && row.automation_run_id) {
      db.prepare(`
        UPDATE evolution_auto_runs
        SET state = 'stopped', stage = 'production_revoked',
          error_code = NULL, error_message = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND user_id = ? AND promotion_id = ? AND state = 'promoted'
      `).run(reason, revokedAt, revokedAt, row.automation_run_id, owner, row.id)
    }
  }).immediate()
  return getEvolutionPromotion({ userId: owner, id: row.id })
}

export function getEvolutionPromotion({ userId, id } = {}) {
  const owner = ownerId(userId)
  return promotionView(promotionRow(owner, id))
}

export function listEvolutionPromotions({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_promotions WHERE user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(owner, limitValue(limit)).map(promotionView)
}

export function hasActiveEvolutionPromotion(userId, target = SUPPORTED_TARGET) {
  const owner = String(userId || '').trim()
  if (!owner) return false
  return Boolean(getDb().prepare(`
    SELECT 1 FROM evolution_active_promotions WHERE user_id = ? AND target = ?
  `).get(owner, target))
}

export function resolveEvolutionPromotionAssignment({
  userId,
  sessionId,
  turnId,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = String(userId || '').trim()
  const session = String(sessionId || '').trim()
  const turn = String(turnId || '').trim()
  if (!owner || !session || !turn) return null
  const db = getDb()
  let assignment = db.prepare(`
    SELECT * FROM evolution_promotion_assignments
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner, session, turn)
  if (!assignment) {
    const observedPromotion = db.prepare(`
      SELECT promotion.* FROM evolution_active_promotions AS active
      JOIN evolution_promotions AS promotion ON promotion.id = active.promotion_id
      WHERE active.user_id = ? AND active.target = ?
    `).get(owner, SUPPORTED_TARGET)
    if (!hasValidPromotionSnapshot(observedPromotion)) {
      rollbackAutomaticPromotionSnapshot({
        promotion: observedPromotion,
        reason: 'Automatic production rollback: immutable promotion fingerprint drift was detected.',
        code: 'EVOLUTION_AUTOMATIC_PROMOTION_FINGERPRINT_DRIFT',
        now,
      })
      return null
    }
    if (!automaticPromotionPolicyCurrent(observedPromotion)) {
      rollbackAutomaticPromotionSnapshot({
        promotion: observedPromotion,
        reason: 'Automatic production rollback: the enabled automation policy changed or was disabled.',
        code: 'EVOLUTION_AUTOMATIC_PROMOTION_POLICY_DRIFT',
        now,
      })
      return null
    }
    let observedBaselineSha256 = null
    try { observedBaselineSha256 = sha256(currentWorkspaceInstructions(env)) } catch { /* diagnostic only */ }
    if (observedPromotion.decision_origin === 'automatic_policy'
      && observedBaselineSha256 !== observedPromotion.baseline_sha256) {
      rollbackAutomaticPromotionSnapshot({
        promotion: observedPromotion,
        reason: 'Automatic production rollback: workspace instruction baseline drift was detected.',
        code: 'EVOLUTION_AUTOMATIC_PROMOTION_BASELINE_DRIFT',
        now,
      })
      return null
    }
    const assignedAt = timestamp(now)
    assignment = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM evolution_promotion_assignments
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get(owner, session, turn)
      if (existing) return existing

      const promotion = db.prepare(`
        SELECT promotion.* FROM evolution_active_promotions AS active
        JOIN evolution_promotions AS promotion ON promotion.id = active.promotion_id
        WHERE active.user_id = ? AND active.target = ? AND active.promotion_id = ?
      `).get(owner, SUPPORTED_TARGET, observedPromotion.id)
      if (!hasValidPromotionSnapshot(promotion)) return null

      db.prepare(`
        INSERT OR IGNORE INTO evolution_promotion_assignments (
          id, user_id, promotion_id, session_id, turn_id, target, decision_reason,
          baseline_sha256, observed_baseline_sha256, candidate_sha256, prompt_content,
          promotion_fingerprint, assigned_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'production_candidate', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), owner, promotion.id, session, turn, promotion.target,
        promotion.baseline_sha256, observedBaselineSha256, promotion.candidate_sha256,
        promotion.candidate_content, promotion.promotion_fingerprint, assignedAt,
      )
      return db.prepare(`
        SELECT * FROM evolution_promotion_assignments
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get(owner, session, turn) || null
    }).immediate()
  }
  if (!assignment || sha256(assignment.prompt_content) !== assignment.candidate_sha256) return null
  return {
    id: assignment.id,
    releaseId: assignment.promotion_id,
    promotionId: assignment.promotion_id,
    assignmentKind: 'production_promotion',
    sessionId: assignment.session_id,
    turnId: assignment.turn_id,
    variant: 'candidate',
    decisionReason: assignment.decision_reason,
    eligible: true,
    bucket: 0,
    target: assignment.target,
    baselineSha256: assignment.baseline_sha256,
    observedBaselineSha256: assignment.observed_baseline_sha256,
    candidateSha256: assignment.candidate_sha256,
    releaseFingerprint: assignment.promotion_fingerprint,
    promptContent: assignment.prompt_content,
  }
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const result = {}
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens', 'costUsd']) {
    const number = normalizeOptionalUsageNumber(value[key])
    if (number !== null) result[key] = number
  }
  return Object.keys(result).length ? result : null
}

export function recordEvolutionPromotionOutcome({
  userId,
  sessionId,
  turnId,
  terminalState: stateValue,
  durationMs,
  usage,
  errorCode = null,
  modelProviderId = null,
  modelName = null,
  modelRevision = null,
  modelConfigRevision = null,
  evaluationInput = '',
  evaluationOutput = '',
  now = Date.now(),
} = {}) {
  const owner = String(userId || '').trim()
  const assignment = getDb().prepare(`
    SELECT * FROM evolution_promotion_assignments
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner, String(sessionId || '').trim(), String(turnId || '').trim())
  if (!assignment) return null
  const terminalState = String(stateValue || '').trim().toLowerCase()
  if (!TERMINAL_STATES.has(terminalState)) {
    throw serviceError('EVOLUTION_PROMOTION_OUTCOME_INVALID', 'terminalState is invalid')
  }
  const rawDuration = Number(durationMs)
  const duration = Number.isFinite(rawDuration)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(rawDuration)))
    : 0
  const normalizedUsage = normalizeUsage(usage)
  const normalizedErrorCode = errorCode
    ? String(errorCode).trim().replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 160) || null
    : null
  const db = getDb()
  const candidateOutcomeId = randomUUID()
  const createdAt = timestamp(now)
  let outcomeId = candidateOutcomeId
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO evolution_promotion_outcomes (
        id, user_id, promotion_id, assignment_id, terminal_state,
        duration_ms, usage_json, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidateOutcomeId, owner, assignment.promotion_id, assignment.id, terminalState,
      duration, normalizedUsage ? JSON.stringify(normalizedUsage) : null,
      normalizedErrorCode, createdAt,
    )
    outcomeId = db.prepare(`
      SELECT id FROM evolution_promotion_outcomes WHERE assignment_id = ?
    `).get(assignment.id).id
    recordEvolutionPromotionOutcomeSnapshot({
      outcomeId,
      assignmentId: assignment.id,
      modelProviderId,
      modelName,
      modelRevision,
      modelConfigRevision,
      inputContent: evaluationInput,
      outputContent: evaluationOutput,
      now: createdAt,
    })
  }).immediate()
  enqueueEvolutionPromotionOutcomeGrade({
    userId: owner,
    promotionId: assignment.promotion_id,
    outcomeId,
  })
  return getEvolutionPromotion({ userId: owner, id: assignment.promotion_id })
}
