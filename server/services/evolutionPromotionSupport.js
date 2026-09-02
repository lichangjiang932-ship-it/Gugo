import { createHash } from 'node:crypto'

import { getDb } from '../db.js'
import { getEvolutionApprovalDecision } from './evolutionApprovalService.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import { getEvolutionEvaluation } from './evolutionEvaluationService.js'
import { assertEvolutionOnlineGuardPassed } from './evolutionOnlineGraderService.js'
import { getEvolutionReplayRun } from './evolutionReplayService.js'
import { evolutionRollbackDecisionMetrics } from './evolutionRollbackService.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

export const SUPPORTED_TARGET = 'prompt:workspace-instructions'

const AUTOMATIC_PROMOTION_RUN_STATES = new Set(['canary_active', 'validated'])
const MAX_LIMIT = 100

export function serviceError(code, message, statusCode = 400) {
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

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function ownerId(value) {
  const owner = String(value || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return owner
}

export function timestamp(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw serviceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return number
}

export function boundedReason(value, code = 'EVOLUTION_PROMOTION_REASON_INVALID') {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2_000) {
    throw serviceError(code, 'reason must contain between 1 and 2000 characters')
  }
  return sanitizeEvolutionText(raw)
}

export function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_PROMOTION_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

export function currentWorkspaceInstructions(env) {
  const text = String(readWorkspaceInstructions({ env })?.text || '').trim()
  if (!text) {
    throw serviceError('EVOLUTION_PROMOTION_BASELINE_UNAVAILABLE', 'workspace instructions are not available', 409)
  }
  return text
}

export function promotionRow(userId, id) {
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

export function automaticPromotionRun(owner, automationRunId, evidence) {
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

export function assertConfirmations(value, expected) {
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

export function assertPromotionEvidence(owner, releaseId, env) {
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

export function confirmationView(evidence) {
  return {
    canaryReleaseFingerprint: evidence.release.release_fingerprint,
    candidateContentSha256: evidence.candidate.contentSha256,
    rollbackBaselineSha256: evidence.release.baseline_sha256,
    rollbackPolicyFingerprint: evidence.policy.policy_fingerprint,
    onlineGraderPolicyFingerprint: evidence.onlineEvidence.policy.policyFingerprint,
    onlineGuardEvaluationFingerprint: evidence.onlineEvidence.guard.evaluationFingerprint,
  }
}

export function promotionFingerprint(input) {
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

export function hasValidPromotionSnapshot(promotion) {
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

export function promotionStats(id) {
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
