import { getDb } from '../db.js'
import {
  policyThresholds,
  sha256,
} from './evolutionOnlineGraderValidation.js'

const SAFETY_VERDICTS = new Set(['pass', 'fail', 'unknown'])

function sampleRows(releaseId) {
  const rollbackPolicy = getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_policies WHERE release_id = ?
  `).get(releaseId)
  if (!rollbackPolicy) return { rollbackPolicy: null, rows: [] }
  const rows = getDb().prepare(`
    WITH eligible AS (
      SELECT outcome.id AS outcome_id, outcome.rowid AS outcome_rowid,
        COALESCE(context.effective_variant, assignment.variant) AS effective_variant,
        COALESCE(context.decision_reason, assignment.decision_reason) AS effective_reason,
        grade.id AS grade_id, grade.execution_status, grade.quality_score,
        grade.safety_verdict, grade.grade_fingerprint
      FROM evolution_canary_outcomes AS outcome
      JOIN evolution_canary_assignments AS assignment ON assignment.id = outcome.assignment_id
      LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
      LEFT JOIN evolution_canary_online_grades AS grade ON grade.outcome_id = outcome.id
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
    SELECT * FROM ranked WHERE sample_rank <= ? ORDER BY outcome_rowid DESC
  `).all(releaseId, rollbackPolicy.window_size)
  return { rollbackPolicy, rows }
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export function buildOnlineGuard(releaseId, policy) {
  const { rollbackPolicy, rows } = sampleRows(releaseId)
  const candidate = rows.filter((row) => row.effective_variant === 'candidate')
  const baseline = rows.filter((row) => row.effective_variant === 'baseline')
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
  if (!candidateReady) blockers.push('candidate_outcomes_insufficient')
  if (!baselineReady) blockers.push('baseline_outcomes_insufficient')
  if (candidate.some((row) => row.execution_status === 'failed')
    || baseline.some((row) => row.execution_status === 'failed')) blockers.push('grader_execution_failed')
  if (candidateReady && !candidateGradesComplete) blockers.push('candidate_grades_incomplete')
  if (baselineReady && !baselineGradesComplete) blockers.push('baseline_grades_incomplete')
  if (candidateSafetyUnknown > 0) blockers.push('candidate_safety_unknown')
  if (baselineSafetyUnknown > 0) blockers.push('baseline_safety_unknown')
  const completeEvidence = candidateGradesComplete && baselineGradesComplete
    && candidateSafetyUnknown === 0 && baselineSafetyUnknown === 0
  const metrics = {
    windowSize: rollbackPolicy?.window_size ?? null,
    candidate: {
      outcomes: candidate.length,
      gradesCompleted: candidate.filter(completeGrade).length,
      averageQualityScore: candidateAverage,
      safetyFailures: candidateSafetyFailures,
      safetyUnknown: candidateSafetyUnknown,
      safetyFailureRate,
    },
    baseline: {
      outcomes: baseline.length,
      gradesCompleted: baseline.filter(completeGrade).length,
      averageQualityScore: baselineAverage,
      safetyFailures: baselineSafetyFailures,
      safetyUnknown: baselineSafetyUnknown,
    },
    qualityRegression,
    evidence: {
      candidateReady,
      baselineReady,
      candidateGradesComplete,
      baselineGradesComplete,
      complete: completeEvidence,
    },
    thresholds: policyThresholds(policy),
  }
  const breaches = []
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
  const sample = rows.map((row) => ({
    outcomeId: row.outcome_id,
    variant: row.effective_variant,
    gradeFingerprint: row.grade_fingerprint || null,
  }))
  return {
    decision,
    metrics,
    breaches,
    blockers: [...new Set(blockers)],
    gradeIds: rows.map((row) => row.grade_id).filter(Boolean),
    sampleFingerprint: sha256(sample),
  }
}
