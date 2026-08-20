import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

const POLICY_VERSION = 'canary-rollback-v1'
const MAX_EVALUATIONS = 200

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

function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_INVALID',
      `${name} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return number
}

function boundedNumber(value, name, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_INVALID',
      `${name} must be between ${minimum} and ${maximum}`,
    )
  }
  return number
}

function boundedReason(value) {
  const reason = String(value || '').trim()
  if (!reason || reason.length > 2_000) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_INVALID',
      'reason must contain between 1 and 2000 characters',
    )
  }
  return sanitizeEvolutionText(reason)
}

function normalizePolicy(value = {}) {
  const policy = {
    windowSize: boundedInteger(value.windowSize, 'windowSize', 3, 200),
    minimumCandidateOutcomes: boundedInteger(
      value.minimumCandidateOutcomes,
      'minimumCandidateOutcomes',
      3,
      100,
    ),
    minimumBaselineOutcomes: boundedInteger(
      value.minimumBaselineOutcomes,
      'minimumBaselineOutcomes',
      3,
      100,
    ),
    maximumCandidateFailureRate: boundedNumber(
      value.maximumCandidateFailureRate,
      'maximumCandidateFailureRate',
      0,
      1,
    ),
    maximumCandidateCancellationRate: boundedNumber(
      value.maximumCandidateCancellationRate,
      'maximumCandidateCancellationRate',
      0,
      1,
    ),
    maximumLatencyRatio: boundedNumber(value.maximumLatencyRatio, 'maximumLatencyRatio', 1, 10),
    maximumCostRatio: boundedNumber(value.maximumCostRatio, 'maximumCostRatio', 1, 10),
  }
  if (policy.minimumCandidateOutcomes > policy.windowSize
    || policy.minimumBaselineOutcomes > policy.windowSize) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_INVALID',
      'minimum outcome counts cannot exceed windowSize',
    )
  }
  return policy
}

function policyView(row) {
  if (!row) return null
  return {
    id: row.id,
    version: row.policy_version,
    windowSize: row.window_size,
    minimumCandidateOutcomes: row.minimum_candidate_outcomes,
    minimumBaselineOutcomes: row.minimum_baseline_outcomes,
    maximumCandidateFailureRate: row.maximum_candidate_failure_rate,
    maximumCandidateCancellationRate: row.maximum_candidate_cancellation_rate,
    maximumLatencyRatio: row.maximum_latency_ratio,
    maximumCostRatio: row.maximum_cost_ratio,
    reason: row.reason,
    baselineSha256: row.baseline_sha256,
    releaseFingerprint: row.release_fingerprint,
    policyFingerprint: row.policy_fingerprint,
    createdAt: row.created_at,
  }
}

function rollbackView(row) {
  if (!row) return null
  return {
    id: row.id,
    policyId: row.policy_id,
    evaluationId: row.evaluation_id,
    rollbackBaselineSha256: row.rollback_baseline_sha256,
    releaseFingerprint: row.release_fingerprint,
    baselineStatus: row.baseline_status,
    observedBaselineSha256: row.observed_baseline_sha256,
    triggerFingerprint: row.trigger_fingerprint,
    reason: row.reason,
    createdAt: row.created_at,
  }
}

function evaluationView(row) {
  return {
    id: row.id,
    policyId: row.policy_id,
    outcomeId: row.outcome_id,
    decision: row.decision,
    metrics: parseJson(row.metrics_json, {}),
    breaches: parseJson(row.breaches_json, []),
    evaluationFingerprint: row.evaluation_fingerprint,
    createdAt: row.created_at,
  }
}

function releaseRow(userId, releaseId) {
  const row = getDb().prepare(`
    SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?
  `).get(String(releaseId || '').trim(), userId)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  return row
}

function latestLifecycleEvent(releaseId) {
  return getDb().prepare(`
    SELECT event_type FROM evolution_canary_events
    WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
}

function policyRow(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_policies WHERE release_id = ?
  `).get(releaseId) || null
}

function rollbackRow(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_rollbacks WHERE release_id = ?
  `).get(releaseId) || null
}

export function createEvolutionCanaryRollbackPolicy({
  userId,
  releaseId,
  policy: policyValue,
  reason: reasonValue,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  if (latestLifecycleEvent(release.id)) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_LOCKED',
      'rollback policy must be declared before the canary starts',
      409,
    )
  }
  const policy = normalizePolicy(policyValue)
  const reason = boundedReason(reasonValue)
  const fingerprint = sha256({
    version: POLICY_VERSION,
    releaseFingerprint: release.release_fingerprint,
    baselineSha256: release.baseline_sha256,
    policy,
  })
  const id = randomUUID()
  try {
    getDb().prepare(`
      INSERT INTO evolution_canary_rollback_policies (
        id, user_id, release_id, policy_version, window_size,
        minimum_candidate_outcomes, minimum_baseline_outcomes,
        maximum_candidate_failure_rate, maximum_candidate_cancellation_rate,
        maximum_latency_ratio, maximum_cost_ratio, reason, baseline_sha256,
        release_fingerprint, policy_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      owner,
      release.id,
      POLICY_VERSION,
      policy.windowSize,
      policy.minimumCandidateOutcomes,
      policy.minimumBaselineOutcomes,
      policy.maximumCandidateFailureRate,
      policy.maximumCandidateCancellationRate,
      policy.maximumLatencyRatio,
      policy.maximumCostRatio,
      reason,
      release.baseline_sha256,
      release.release_fingerprint,
      fingerprint,
      timestamp(now),
    )
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      throw serviceError(
        'EVOLUTION_CANARY_ROLLBACK_POLICY_EXISTS',
        'canary release already has an immutable rollback policy',
        409,
      )
    }
    throw error
  }
  return getEvolutionCanaryRollbackState({ userId: owner, releaseId: release.id }).policy
}

export function assertEvolutionCanaryRollbackPolicyReady({
  userId,
  releaseId,
  baselineSha256,
  releaseFingerprint,
} = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  const policy = policyRow(release.id)
  if (!policy) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_REQUIRED',
      'an immutable automatic rollback policy is required before start',
      409,
    )
  }
  if (policy.baseline_sha256 !== baselineSha256
    || policy.release_fingerprint !== releaseFingerprint
    || policy.baseline_sha256 !== release.baseline_sha256
    || policy.release_fingerprint !== release.release_fingerprint) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_MISMATCH',
      'rollback policy does not match the immutable canary release',
      409,
    )
  }
  return policyView(policy)
}

export function hasEvolutionCanaryRollbackPolicy(releaseId) {
  if (!releaseId) return false
  return Boolean(policyRow(String(releaseId)))
}

export function hasEvolutionCanaryRollback(releaseId) {
  if (!releaseId) return false
  return Boolean(rollbackRow(String(releaseId)))
}

function ratio(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 1 : null
  return candidate / baseline
}

function average(rows, readValue) {
  if (!rows.length) return null
  return rows.reduce((sum, row) => sum + readValue(row), 0) / rows.length
}

function measuredCost(row) {
  const usage = parseJson(row.usage_json, null)
  const value = Number(usage?.costUsd)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function sampleRows(releaseId, windowSize) {
  return getDb().prepare(`
    WITH eligible AS (
      SELECT outcome.*, outcome.rowid AS outcome_rowid,
        assignment.variant AS assigned_variant,
        COALESCE(context.effective_variant, assignment.variant) AS effective_variant,
        COALESCE(context.decision_reason, assignment.decision_reason) AS effective_reason
      FROM evolution_canary_outcomes AS outcome
      JOIN evolution_canary_assignments AS assignment ON assignment.id = outcome.assignment_id
      LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
      WHERE outcome.release_id = ?
        AND COALESCE(context.decision_reason, assignment.decision_reason)
          IN ('traffic_baseline', 'traffic_candidate')
    ), ranked AS (
      SELECT eligible.*,
        ROW_NUMBER() OVER (
          PARTITION BY effective_variant ORDER BY outcome_rowid DESC
        ) AS sample_rank
      FROM eligible
    )
    SELECT * FROM ranked WHERE sample_rank <= ?
    ORDER BY outcome_rowid DESC
  `).all(releaseId, windowSize)
}

function buildMetrics(rows, policy) {
  const candidate = rows.filter((row) => row.effective_variant === 'candidate')
  const baseline = rows.filter((row) => row.effective_variant === 'baseline')
  const candidateCosts = candidate.map(measuredCost).filter((value) => value !== null)
  const baselineCosts = baseline.map(measuredCost).filter((value) => value !== null)
  const candidateAverageDurationMs = average(candidate, (row) => Math.max(0, Number(row.duration_ms) || 0))
  const baselineAverageDurationMs = average(baseline, (row) => Math.max(0, Number(row.duration_ms) || 0))
  const candidateAverageCostUsd = candidateCosts.length
    ? candidateCosts.reduce((sum, value) => sum + value, 0) / candidateCosts.length
    : null
  const baselineAverageCostUsd = baselineCosts.length
    ? baselineCosts.reduce((sum, value) => sum + value, 0) / baselineCosts.length
    : null
  const candidateReady = candidate.length >= policy.minimum_candidate_outcomes
  const baselineReady = baseline.length >= policy.minimum_baseline_outcomes
  const costReady = candidateReady && baselineReady
    && candidateCosts.length === candidate.length
    && baselineCosts.length === baseline.length
  return {
    windowSize: policy.window_size,
    candidate: {
      outcomes: candidate.length,
      completed: candidate.filter((row) => row.terminal_state === 'completed').length,
      failed: candidate.filter((row) => row.terminal_state === 'failed').length,
      cancelled: candidate.filter((row) => row.terminal_state === 'cancelled').length,
      failureRate: candidate.length
        ? candidate.filter((row) => row.terminal_state === 'failed').length / candidate.length
        : null,
      cancellationRate: candidate.length
        ? candidate.filter((row) => row.terminal_state === 'cancelled').length / candidate.length
        : null,
      averageDurationMs: candidateAverageDurationMs,
      costMeasured: candidateCosts.length,
      averageCostUsd: candidateAverageCostUsd,
    },
    baseline: {
      outcomes: baseline.length,
      completed: baseline.filter((row) => row.terminal_state === 'completed').length,
      failed: baseline.filter((row) => row.terminal_state === 'failed').length,
      cancelled: baseline.filter((row) => row.terminal_state === 'cancelled').length,
      averageDurationMs: baselineAverageDurationMs,
      costMeasured: baselineCosts.length,
      averageCostUsd: baselineAverageCostUsd,
    },
    evidence: { candidateReady, baselineReady, costReady },
    latencyRatio: candidateReady && baselineReady
      ? ratio(candidateAverageDurationMs, baselineAverageDurationMs)
      : null,
    costRatio: costReady ? ratio(candidateAverageCostUsd, baselineAverageCostUsd) : null,
  }
}

function policyBreaches(metrics, policy) {
  const breaches = []
  if (metrics.evidence.candidateReady
    && metrics.candidate.failureRate > policy.maximum_candidate_failure_rate) {
    breaches.push('maximum_candidate_failure_rate')
  }
  if (metrics.evidence.candidateReady
    && metrics.candidate.cancellationRate > policy.maximum_candidate_cancellation_rate) {
    breaches.push('maximum_candidate_cancellation_rate')
  }
  if (metrics.evidence.candidateReady && metrics.evidence.baselineReady) {
    const latencyBreach = metrics.latencyRatio === null
      ? metrics.candidate.averageDurationMs > 0 && metrics.baseline.averageDurationMs === 0
      : metrics.latencyRatio > policy.maximum_latency_ratio
    if (latencyBreach) breaches.push('maximum_latency_ratio')
  }
  if (metrics.evidence.costReady) {
    const costBreach = metrics.costRatio === null
      ? metrics.candidate.averageCostUsd > 0 && metrics.baseline.averageCostUsd === 0
      : metrics.costRatio > policy.maximum_cost_ratio
    if (costBreach) breaches.push('maximum_cost_ratio')
  }
  return breaches
}

function baselineObservation(env, expectedSha256) {
  try {
    const text = String(readWorkspaceInstructions({ env })?.text || '').trim()
    if (!text) return { status: 'unavailable', sha256: null }
    const observed = sha256(text)
    return { status: observed === expectedSha256 ? 'verified' : 'drifted', sha256: observed }
  } catch {
    return { status: 'unavailable', sha256: null }
  }
}

export function evaluateEvolutionCanaryRollback({
  userId,
  releaseId,
  outcomeId,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  const policy = policyRow(release.id)
  if (!policy || rollbackRow(release.id) || latestLifecycleEvent(release.id)?.event_type !== 'started') {
    return getEvolutionCanaryRollbackState({ userId: owner, releaseId: release.id })
  }
  const outcome = getDb().prepare(`
    SELECT id FROM evolution_canary_outcomes WHERE id = ? AND release_id = ? AND user_id = ?
  `).get(String(outcomeId || '').trim(), release.id, owner)
  if (!outcome) throw serviceError('EVOLUTION_CANARY_OUTCOME_NOT_FOUND', 'canary outcome was not found', 404)
  const rows = sampleRows(release.id, policy.window_size)
  const metrics = buildMetrics(rows, policy)
  const breaches = policyBreaches(metrics, policy)
  const completeEvidence = metrics.evidence.candidateReady
    && metrics.evidence.baselineReady
    && metrics.evidence.costReady
  const decision = breaches.length
    ? 'rollback'
    : completeEvidence ? 'continue' : 'insufficient_evidence'
  const evaluationFingerprint = sha256({
    policyFingerprint: policy.policy_fingerprint,
    outcomeId: outcome.id,
    metrics,
    breaches,
    decision,
  })
  const evaluationId = randomUUID()
  const createdAt = timestamp(now)
  getDb().prepare(`
    INSERT OR IGNORE INTO evolution_canary_rollback_evaluations (
      id, user_id, release_id, policy_id, outcome_id, decision,
      metrics_json, breaches_json, evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evaluationId,
    owner,
    release.id,
    policy.id,
    outcome.id,
    decision,
    JSON.stringify(metrics),
    JSON.stringify(breaches),
    evaluationFingerprint,
    createdAt,
  )
  const evaluation = getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_evaluations WHERE outcome_id = ?
  `).get(outcome.id)
  if (evaluation.decision === 'rollback' && !rollbackRow(release.id)) {
    const baseline = baselineObservation(env, release.baseline_sha256)
    const reason = `Automatic rollback: ${parseJson(evaluation.breaches_json, []).join(', ')}`.slice(0, 2_000)
    getDb().prepare(`
      INSERT OR IGNORE INTO evolution_canary_rollbacks (
        id, user_id, release_id, policy_id, evaluation_id,
        rollback_baseline_sha256, release_fingerprint, baseline_status,
        observed_baseline_sha256, trigger_fingerprint, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      owner,
      release.id,
      policy.id,
      evaluation.id,
      release.baseline_sha256,
      release.release_fingerprint,
      baseline.status,
      baseline.sha256,
      evaluation.evaluation_fingerprint,
      reason,
      createdAt,
    )
  }
  return getEvolutionCanaryRollbackState({ userId: owner, releaseId: release.id })
}

export function getEvolutionCanaryRollbackState({ userId, releaseId, includeEvaluations = false } = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  const policy = policyRow(release.id)
  const rollback = rollbackRow(release.id)
  const evaluations = includeEvaluations
    ? getDb().prepare(`
        SELECT * FROM evolution_canary_rollback_evaluations
        WHERE release_id = ? ORDER BY rowid DESC LIMIT ?
      `).all(release.id, MAX_EVALUATIONS).map(evaluationView)
    : undefined
  return {
    policy: policyView(policy),
    rollback: rollbackView(rollback),
    ...(includeEvaluations ? { evaluations } : {}),
  }
}
