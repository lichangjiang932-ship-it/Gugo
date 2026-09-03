import { createHash } from 'node:crypto'

import { getDb } from '../db.js'

const SAFETY_VERDICTS = new Set(['pass', 'fail', 'unknown'])

export function evolutionPromotionOnlineGraderServiceError(code, message, statusCode = 400) {
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

export function evolutionPromotionOnlineGraderSha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

export function parseEvolutionPromotionOnlineGraderJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function requireEvolutionPromotionOnlineGraderOwner(value) {
  const owner = String(value || '').trim()
  if (!owner) {
    throw evolutionPromotionOnlineGraderServiceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  }
  return owner
}

export function normalizeEvolutionPromotionOnlineGraderTimestamp(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw evolutionPromotionOnlineGraderServiceError(
      'EVOLUTION_TIMESTAMP_INVALID',
      'now must be a non-negative safe integer',
    )
  }
  return number
}

export function evolutionPromotionOnlineGradeView(row) {
  if (!row) return null
  return {
    id: row.id,
    promotionId: row.promotion_id,
    outcomeId: row.outcome_id,
    policyId: row.policy_id,
    status: row.execution_status,
    qualityScore: row.quality_score,
    safetyVerdict: row.safety_verdict,
    summary: row.summary,
    evidence: parseEvolutionPromotionOnlineGraderJson(row.evidence_json, []),
    issues: parseEvolutionPromotionOnlineGraderJson(row.issues_json, []),
    errorCode: row.error_code,
    grader: {
      providerId: row.grader_provider_id,
      modelName: row.grader_model,
      modelRevision: row.grader_model_revision,
      ...(row.grader_config_revision != null ? { configRevision: row.grader_config_revision } : {}),
    },
    evaluatedModel: row.evaluated_provider_id ? {
      providerId: row.evaluated_provider_id,
      modelName: row.evaluated_model,
      modelRevision: row.evaluated_model_revision,
    } : null,
    policyFingerprint: row.policy_fingerprint,
    gradeFingerprint: row.grade_fingerprint,
    createdAt: row.created_at,
  }
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function frozenBaselineRows(promotion, baselineGuard) {
  const gradeIds = parseEvolutionPromotionOnlineGraderJson(baselineGuard?.grade_ids_json, [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 500)
  if (!gradeIds.length) return []
  const placeholders = gradeIds.map(() => '?').join(', ')
  const rows = getDb().prepare(`
    SELECT * FROM evolution_canary_online_grades
    WHERE release_id = ? AND effective_variant = 'baseline' AND id IN (${placeholders})
  `).all(promotion.canary_release_id, ...gradeIds)
  const byId = new Map(rows.map((row) => [row.id, row]))
  return gradeIds.map((id) => byId.get(id)).filter(Boolean)
}

function promotionSampleRows(promotionId, windowSize) {
  return getDb().prepare(`
    SELECT outcome.id AS outcome_id, outcome.rowid AS outcome_rowid,
      grade.id AS grade_id, grade.execution_status, grade.quality_score,
      grade.safety_verdict, grade.grade_fingerprint
    FROM evolution_promotion_outcomes AS outcome
    LEFT JOIN evolution_promotion_online_grades AS grade ON grade.outcome_id = outcome.id
    WHERE outcome.promotion_id = ?
    ORDER BY outcome.rowid DESC LIMIT ?
  `).all(promotionId, windowSize)
}

export function buildEvolutionPromotionOnlineGuard({ promotion, policy, rollbackPolicy, baselineGuard }) {
  const candidate = promotionSampleRows(promotion.id, rollbackPolicy?.window_size || 1)
  const baseline = frozenBaselineRows(promotion, baselineGuard)
  const completeGrade = (row) => row.execution_status === 'completed'
    && Number.isFinite(Number(row.quality_score))
    && SAFETY_VERDICTS.has(String(row.safety_verdict || ''))
  const candidateReady = Boolean(rollbackPolicy)
    && candidate.length >= rollbackPolicy.minimum_candidate_outcomes
  const baselineReady = Boolean(rollbackPolicy)
    && baseline.length >= rollbackPolicy.minimum_baseline_outcomes
  const candidateGradesComplete = candidateReady && candidate.every(completeGrade)
  const baselineGradesComplete = baselineReady && baseline.every(completeGrade)
  const candidateScores = candidate.filter(completeGrade).map((row) => Number(row.quality_score))
  const baselineScores = baseline.filter(completeGrade).map((row) => Number(row.quality_score))
  const candidateAverage = average(candidateScores)
  const baselineAverage = average(baselineScores)
  const qualityRegression = candidateGradesComplete && baselineGradesComplete
    ? Math.max(0, baselineAverage - candidateAverage)
    : null
  const candidateSafetyFailures = candidate.filter(
    (row) => completeGrade(row) && row.safety_verdict === 'fail',
  ).length
  const candidateSafetyUnknown = candidate.filter(
    (row) => completeGrade(row) && row.safety_verdict === 'unknown',
  ).length
  const baselineSafetyFailures = baseline.filter(
    (row) => completeGrade(row) && row.safety_verdict === 'fail',
  ).length
  const baselineSafetyUnknown = baseline.filter(
    (row) => completeGrade(row) && row.safety_verdict === 'unknown',
  ).length
  const safetyFailureRate = candidateGradesComplete
    ? candidateSafetyFailures / candidate.length
    : null
  const blockers = []
  if (!rollbackPolicy) blockers.push('rollback_policy_missing')
  if (!baselineGuard || baselineGuard.decision !== 'continue') blockers.push('frozen_baseline_guard_invalid')
  if (!candidateReady) blockers.push('promotion_outcomes_insufficient')
  if (!baselineReady) blockers.push('frozen_baseline_grades_insufficient')
  if (candidate.some((row) => row.execution_status === 'failed')) blockers.push('grader_execution_failed')
  if (candidateReady && !candidateGradesComplete) blockers.push('promotion_grades_incomplete')
  if (baselineReady && !baselineGradesComplete) blockers.push('frozen_baseline_grades_incomplete')
  if (candidateSafetyUnknown > 0) blockers.push('promotion_safety_unknown')
  if (baselineSafetyUnknown > 0) blockers.push('frozen_baseline_safety_unknown')
  const completeEvidence = Boolean(baselineGuard?.decision === 'continue')
    && candidateGradesComplete && baselineGradesComplete
    && candidateSafetyUnknown === 0 && baselineSafetyUnknown === 0
  const metrics = {
    windowSize: rollbackPolicy?.window_size ?? null,
    promotion: {
      outcomes: candidate.length,
      gradesCompleted: candidate.filter(completeGrade).length,
      averageQualityScore: candidateAverage,
      safetyFailures: candidateSafetyFailures,
      safetyUnknown: candidateSafetyUnknown,
      safetyFailureRate,
    },
    frozenBaseline: {
      guardEvaluationFingerprint: baselineGuard?.evaluation_fingerprint || null,
      outcomes: baseline.length,
      gradesCompleted: baseline.filter(completeGrade).length,
      averageQualityScore: baselineAverage,
      safetyFailures: baselineSafetyFailures,
      safetyUnknown: baselineSafetyUnknown,
    },
    qualityRegression,
    evidence: {
      promotionReady: candidateReady,
      baselineReady,
      promotionGradesComplete: candidateGradesComplete,
      baselineGradesComplete,
      complete: completeEvidence,
    },
    thresholds: {
      minimumQualityScore: policy.minimum_quality_score,
      maximumQualityRegression: policy.maximum_quality_regression,
      maximumSafetyFailureRate: policy.maximum_safety_failure_rate,
    },
  }
  const breaches = []
  if (promotion.decision_origin === 'automatic_policy'
    && candidate.some((row) => row.execution_status === 'failed')) {
    breaches.push('grader_execution_failed')
  }
  if (completeEvidence && candidateAverage < policy.minimum_quality_score) {
    breaches.push('minimum_quality_score')
  }
  if (completeEvidence && qualityRegression > policy.maximum_quality_regression) {
    breaches.push('maximum_quality_regression')
  }
  if (completeEvidence && safetyFailureRate > policy.maximum_safety_failure_rate) {
    breaches.push('maximum_safety_failure_rate')
  }
  const decision = breaches.length
    ? 'rollback'
    : completeEvidence ? 'continue' : 'insufficient_evidence'
  const sample = {
    baselineGuardFingerprint: baselineGuard?.evaluation_fingerprint || null,
    baseline: baseline.map((row) => ({ id: row.id, gradeFingerprint: row.grade_fingerprint })),
    promotion: candidate.map((row) => ({
      outcomeId: row.outcome_id,
      gradeFingerprint: row.grade_fingerprint || null,
    })),
  }
  return {
    decision,
    metrics,
    breaches,
    blockers: [...new Set(blockers)],
    baselineGradeIds: baseline.map((row) => row.id),
    promotionGradeIds: candidate.map((row) => row.grade_id).filter(Boolean),
    sampleFingerprint: evolutionPromotionOnlineGraderSha256(sample),
  }
}
