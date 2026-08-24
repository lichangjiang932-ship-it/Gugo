import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import {
  assertEvolutionModelIdentityCurrent,
  callEvolutionBackgroundModel,
  resolveEvolutionModelIdentity,
} from './evolutionModelRuntime.js'
import {
  buildEvolutionOnlineGraderMessages,
  parseEvolutionOnlineGraderResponse,
} from './evolutionOnlineGraderService.js'

const SAFETY_VERDICTS = new Set(['pass', 'fail', 'unknown'])
const MAX_BACKLOG_LIMIT = 1_000

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

function promotionRow(userId, promotionId) {
  const row = getDb().prepare(`
    SELECT promotion.*,
      CASE WHEN active.promotion_id IS NULL THEN 0 ELSE 1 END AS is_active
    FROM evolution_promotions AS promotion
    LEFT JOIN evolution_active_promotions AS active ON active.promotion_id = promotion.id
    WHERE promotion.id = ? AND promotion.user_id = ?
  `).get(String(promotionId || '').trim(), userId)
  if (!row) throw serviceError('EVOLUTION_PROMOTION_NOT_FOUND', 'promotion was not found', 404)
  return row
}

function policyRow(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_grader_policies WHERE release_id = ?
  `).get(releaseId) || null
}

function rollbackPolicyRow(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_rollback_policies WHERE release_id = ?
  `).get(releaseId) || null
}

function baselineGuardRow(promotion) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_online_guard_evaluations
    WHERE release_id = ? AND evaluation_fingerprint = ?
  `).get(
    promotion.canary_release_id,
    promotion.online_guard_evaluation_fingerprint || '',
  ) || null
}

function outcomeRow(userId, promotionId, outcomeId) {
  const row = getDb().prepare(`
    SELECT outcome.*, snapshot.evaluated_provider_id, snapshot.evaluated_model,
      snapshot.evaluated_model_revision, snapshot.evaluated_config_revision,
      snapshot.input_content, snapshot.output_content, snapshot.snapshot_fingerprint
    FROM evolution_promotion_outcomes AS outcome
    LEFT JOIN evolution_promotion_outcome_snapshots AS snapshot ON snapshot.outcome_id = outcome.id
    WHERE outcome.id = ? AND outcome.promotion_id = ? AND outcome.user_id = ?
  `).get(String(outcomeId || '').trim(), promotionId, userId)
  if (!row) throw serviceError('EVOLUTION_PROMOTION_OUTCOME_NOT_FOUND', 'promotion outcome was not found', 404)
  return row
}

export function recordEvolutionPromotionOutcomeSnapshot({
  outcomeId,
  assignmentId,
  modelProviderId,
  modelName,
  modelRevision,
  modelConfigRevision,
  inputContent,
  outputContent,
  now = Date.now(),
} = {}) {
  const providerId = String(modelProviderId || '').trim().slice(0, 512)
  const selectedModel = String(modelName || '').trim().slice(0, 512)
  if (!providerId || !selectedModel) return null
  const configRevision = Number.isInteger(Number(modelConfigRevision)) && Number(modelConfigRevision) >= 1
    ? Number(modelConfigRevision)
    : null
  const revision = String(modelRevision || (configRevision ? `config:${configRevision}` : 'unversioned'))
    .trim().slice(0, 512) || 'unversioned'
  const request = sanitizeEvolutionText(String(inputContent || '')).slice(0, 16_000)
  const response = sanitizeEvolutionText(String(outputContent || '')).slice(0, 16_000)
  const snapshot = {
    outcomeId: String(outcomeId || '').trim(),
    assignmentId: String(assignmentId || '').trim(),
    providerId,
    modelName: selectedModel,
    modelRevision: revision,
    configRevision,
    inputSha256: sha256(request),
    outputSha256: sha256(response),
  }
  const fingerprint = sha256(snapshot)
  getDb().prepare(`
    INSERT OR IGNORE INTO evolution_promotion_outcome_snapshots (
      outcome_id, assignment_id, evaluated_provider_id, evaluated_model,
      evaluated_model_revision, evaluated_config_revision, input_content, output_content,
      input_sha256, output_sha256, snapshot_fingerprint, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.outcomeId, snapshot.assignmentId, providerId, selectedModel, revision,
    configRevision, request, response, snapshot.inputSha256, snapshot.outputSha256,
    fingerprint, timestamp(now),
  )
  return { ...snapshot, snapshotFingerprint: fingerprint }
}

function gradeView(row) {
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
    evidence: parseJson(row.evidence_json, []),
    issues: parseJson(row.issues_json, []),
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

function insertGrade({ policy, promotion, outcome, normalized = null, errorCode = null, now }) {
  const status = normalized ? 'completed' : 'failed'
  const fingerprintInput = {
    policyFingerprint: policy.policy_fingerprint,
    promotionFingerprint: promotion.promotion_fingerprint,
    outcomeId: outcome.id,
    status,
    qualityScore: normalized?.qualityScore ?? null,
    safetyVerdict: normalized?.safetyVerdict ?? null,
    summary: normalized?.summary ?? null,
    evidence: normalized?.evidence || [],
    issues: normalized?.issues || [],
    errorCode,
    snapshotFingerprint: outcome.snapshot_fingerprint || null,
  }
  getDb().prepare(`
    INSERT OR IGNORE INTO evolution_promotion_online_grades (
      id, user_id, promotion_id, outcome_id, policy_id, execution_status,
      quality_score, safety_verdict, summary, evidence_json, issues_json, error_code,
      grader_provider_id, grader_model, grader_model_revision, grader_config_revision,
      evaluated_provider_id, evaluated_model, evaluated_model_revision, snapshot_fingerprint,
      policy_fingerprint, grade_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), outcome.user_id, promotion.id, outcome.id, policy.id, status,
    normalized?.qualityScore ?? null, normalized?.safetyVerdict ?? null,
    normalized?.summary ?? null, JSON.stringify(normalized?.evidence || []),
    JSON.stringify(normalized?.issues || []), errorCode, policy.grader_provider_id,
    policy.grader_model, policy.grader_model_revision, policy.grader_config_revision,
    outcome.evaluated_provider_id || null, outcome.evaluated_model || null,
    outcome.evaluated_model_revision || null, outcome.snapshot_fingerprint || null,
    policy.policy_fingerprint, sha256(fingerprintInput), timestamp(now),
  )
  return getDb().prepare(`
    SELECT * FROM evolution_promotion_online_grades WHERE outcome_id = ?
  `).get(outcome.id)
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function frozenBaselineRows(promotion, baselineGuard) {
  const gradeIds = parseJson(baselineGuard?.grade_ids_json, [])
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

function buildPromotionOnlineGuard({ promotion, policy, rollbackPolicy, baselineGuard }) {
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
    sampleFingerprint: sha256(sample),
  }
}

function evaluateGuard({ userId, promotion, policy, rollbackPolicy, baselineGuard, triggerGrade, now }) {
  if (!baselineGuard) return null
  const guard = buildPromotionOnlineGuard({ promotion, policy, rollbackPolicy, baselineGuard })
  const fingerprint = sha256({
    promotionFingerprint: promotion.promotion_fingerprint,
    policyFingerprint: policy.policy_fingerprint,
    baselineGuardFingerprint: baselineGuard.evaluation_fingerprint,
    triggerGradeFingerprint: triggerGrade.grade_fingerprint,
    ...guard,
  })
  getDb().prepare(`
    INSERT OR IGNORE INTO evolution_promotion_online_guard_evaluations (
      id, user_id, promotion_id, policy_id, trigger_grade_id,
      baseline_guard_evaluation_id, sample_fingerprint, baseline_grade_ids_json,
      promotion_grade_ids_json, decision, metrics_json, breaches_json, blockers_json,
      evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), userId, promotion.id, policy.id, triggerGrade.id, baselineGuard.id,
    guard.sampleFingerprint, JSON.stringify(guard.baselineGradeIds),
    JSON.stringify(guard.promotionGradeIds), guard.decision, JSON.stringify(guard.metrics),
    JSON.stringify(guard.breaches), JSON.stringify(guard.blockers), fingerprint, timestamp(now),
  )
  return getDb().prepare(`
    SELECT * FROM evolution_promotion_online_guard_evaluations WHERE trigger_grade_id = ?
  `).get(triggerGrade.id)
}

function applyAutomaticRollback({ userId, promotion, evaluation, now }) {
  if (!evaluation || evaluation.decision !== 'rollback') return null
  const breaches = parseJson(evaluation.breaches_json, [])
  const reason = sanitizeEvolutionText(
    `Automatic production rollback: ${breaches.join(', ') || 'online quality or safety breach'}`,
  ).slice(0, 2_000)
  const removed = getDb().prepare(`
    DELETE FROM evolution_active_promotions
    WHERE user_id = ? AND target = ? AND promotion_id = ?
  `).run(userId, promotion.target, promotion.id)
  if (removed.changes !== 1) {
    throw serviceError(
      'EVOLUTION_PROMOTION_ACTIVE_FENCE_LOST',
      'the production promotion active fence was lost before rollback',
      409,
    )
  }
  getDb().prepare(`
    INSERT OR IGNORE INTO evolution_promotion_rollbacks (
      id, user_id, promotion_id, guard_evaluation_id, trigger_fingerprint,
      breaches_json, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), userId, promotion.id, evaluation.id, evaluation.evaluation_fingerprint,
    JSON.stringify(breaches), reason, timestamp(now),
  )
  getDb().prepare(`
    INSERT INTO evolution_promotion_events (
      id, user_id, promotion_id, event_type, reason, created_at
    ) VALUES (?, ?, ?, 'revoked', ?, ?)
  `).run(randomUUID(), userId, promotion.id, reason, timestamp(now))
  if (promotion.decision_origin === 'automatic_policy' && promotion.automation_run_id) {
    getDb().prepare(`
      UPDATE evolution_auto_runs
      SET state = 'rolled_back', stage = 'production_guard_rollback',
        error_code = 'EVOLUTION_AUTOMATIC_PROMOTION_GUARD_ROLLBACK',
        error_message = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND user_id = ? AND promotion_id = ? AND state = 'promoted'
    `).run(
      reason,
      timestamp(now),
      timestamp(now),
      promotion.automation_run_id,
      userId,
      promotion.id,
    )
  }
  return getDb().prepare(`
    SELECT * FROM evolution_promotion_rollbacks WHERE promotion_id = ?
  `).get(promotion.id)
}

function persistGradeAndEvaluateGuard({
  userId,
  promotion,
  policy,
  rollbackPolicy,
  baselineGuard,
  outcome,
  normalized = null,
  errorCode = null,
  now,
}) {
  const db = getDb()
  return db.transaction(() => {
    const stillActive = db.prepare(`
      SELECT 1 FROM evolution_active_promotions
      WHERE user_id = ? AND target = ? AND promotion_id = ?
    `).get(userId, promotion.target, promotion.id)
    if (!stillActive) return null
    const grade = insertGrade({ policy, promotion, outcome, normalized, errorCode, now })
    const evaluation = evaluateGuard({
      userId,
      promotion,
      policy,
      rollbackPolicy,
      baselineGuard,
      triggerGrade: grade,
      now,
    })
    if (evaluation?.decision === 'rollback') {
      applyAutomaticRollback({ userId, promotion, evaluation, now })
    }
    return grade
  }).immediate()
}

export function listEvolutionPromotionOnlineGradeBacklog({ limit = 100 } = {}) {
  const numericLimit = Math.min(
    MAX_BACKLOG_LIMIT,
    Math.max(1, Number.parseInt(String(limit || 100), 10) || 100),
  )
  return getDb().prepare(`
    SELECT outcome.user_id AS userId, outcome.promotion_id AS promotionId,
      outcome.id AS outcomeId
    FROM evolution_promotion_outcomes AS outcome
    JOIN evolution_promotions AS promotion ON promotion.id = outcome.promotion_id
    JOIN evolution_active_promotions AS active ON active.promotion_id = promotion.id
    JOIN evolution_canary_grader_policies AS policy
      ON policy.release_id = promotion.canary_release_id
      AND policy.policy_fingerprint = promotion.online_grader_policy_fingerprint
      AND policy.production_monitoring_enabled = 1
    LEFT JOIN evolution_promotion_online_grades AS grade ON grade.outcome_id = outcome.id
    WHERE grade.id IS NULL
    ORDER BY outcome.rowid ASC LIMIT ?
  `).all(numericLimit)
}

export async function runEvolutionPromotionOnlineGrade({
  userId,
  promotionId,
  outcomeId,
  now = Date.now(),
  signal,
  runModel = ({ messages, userId: owner, providerId, runtimeProviderId, runtimeEnv, modelName, signal: abortSignal }) => (
    callEvolutionBackgroundModel({
      messages,
      userId: owner,
      providerId,
      runtimeProviderId,
      runtimeEnv,
      modelName,
      signal: abortSignal,
      envOverrides: {
        MODEL_STRICT_SELECTION: '1',
        MODEL_FAILOVER_CROSS_MODEL: '0',
        MODEL_TEMPERATURE: '0',
        MODEL_MAX_TOKENS: '1024',
      },
    })
  ),
} = {}) {
  const owner = ownerId(userId)
  const promotion = promotionRow(owner, promotionId)
  const outcome = outcomeRow(owner, promotion.id, outcomeId)
  const existing = getDb().prepare(`
    SELECT * FROM evolution_promotion_online_grades WHERE outcome_id = ?
  `).get(outcome.id)
  if (existing) return gradeView(existing)
  const policy = policyRow(promotion.canary_release_id)
  if (!promotion.is_active || !policy || policy.production_monitoring_enabled !== 1) return null
  const rollbackPolicy = rollbackPolicyRow(promotion.canary_release_id)
  const baselineGuard = baselineGuardRow(promotion)
  const createdAt = timestamp(now)
  const fail = (code, message, statusCode = 502) => {
    persistGradeAndEvaluateGuard({
      userId: owner,
      promotion,
      policy,
      rollbackPolicy,
      baselineGuard,
      outcome,
      errorCode: code,
      now: createdAt,
    })
    throw serviceError(code, message, statusCode)
  }
  if (promotion.online_grader_policy_fingerprint !== policy.policy_fingerprint) {
    return fail(
      'EVOLUTION_PROMOTION_GRADER_POLICY_CHANGED',
      'the frozen production online grader policy changed',
      409,
    )
  }
  if (!baselineGuard || baselineGuard.decision !== 'continue') {
    return fail(
      'EVOLUTION_PROMOTION_BASELINE_EVIDENCE_MISSING',
      'the frozen canary baseline evidence is unavailable',
      409,
    )
  }
  if (!outcome.snapshot_fingerprint || !outcome.evaluated_provider_id
    || !outcome.evaluated_model || !outcome.evaluated_model_revision) {
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADE_SNAPSHOT_MISSING',
      'promotion outcome has no immutable model and response snapshot',
      409,
    )
  }
  if (policy.grader_provider_id === outcome.evaluated_provider_id
    && policy.grader_model === outcome.evaluated_model) {
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_NOT_INDEPENDENT',
      'the evaluated Provider and model cannot grade their own outcome',
      409,
    )
  }
  let identity
  try {
    identity = resolveEvolutionModelIdentity({
      userId: owner,
      providerId: policy.grader_provider_id,
      modelName: policy.grader_model,
    })
  } catch {
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_CONFIG_CHANGED',
      'the frozen production online grader Provider is no longer available',
      409,
    )
  }
  if (identity.providerId !== policy.grader_provider_id
    || identity.modelName !== policy.grader_model
    || identity.configRevision !== policy.grader_config_revision) {
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_CONFIG_CHANGED',
      'the frozen production online grader Provider configuration changed',
      409,
    )
  }
  let response
  try {
    response = await runModel({
      messages: buildEvolutionOnlineGraderMessages({ policy, outcome }),
      userId: owner,
      providerId: policy.grader_provider_id,
      runtimeProviderId: identity.runtimeProviderId,
      runtimeEnv: identity.runtimeEnv,
      configRevision: identity.configRevision,
      modelName: policy.grader_model,
      modelRevision: policy.grader_model_revision,
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_MODEL_FAILED',
      'independent production online grader model failed',
      502,
    )
  }
  const actualProvider = String(response?.providerId || '').trim()
  const actualModel = String(response?.modelName || '').trim()
  if (actualProvider !== policy.grader_provider_id || actualModel !== policy.grader_model) {
    return fail(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_MODEL_MISMATCH',
      'production online grading did not use the frozen Provider and model',
      502,
    )
  }
  let normalized
  try {
    normalized = parseEvolutionOnlineGraderResponse(response)
    assertEvolutionModelIdentityCurrent({ userId: owner, identity })
  } catch (error) {
    return fail(
      error?.code || 'EVOLUTION_PROMOTION_ONLINE_GRADER_OUTPUT_INVALID',
      error?.statusCode && error.statusCode < 500
        ? error.message
        : 'production online grader evidence was invalid',
      error?.statusCode || 502,
    )
  }
  const grade = persistGradeAndEvaluateGuard({
    userId: owner,
    promotion,
    policy,
    rollbackPolicy,
    baselineGuard,
    outcome,
    normalized,
    now: createdAt,
  })
  return gradeView(grade)
}

export function getEvolutionPromotionOnlineGradeState({ userId, promotionId, limit = 100 } = {}) {
  const owner = ownerId(userId)
  const promotion = promotionRow(owner, promotionId)
  const numericLimit = Math.min(200, Math.max(1, Number.parseInt(String(limit || 100), 10) || 100))
  const grades = getDb().prepare(`
    SELECT * FROM evolution_promotion_online_grades
    WHERE promotion_id = ? ORDER BY rowid DESC LIMIT ?
  `).all(promotion.id, numericLimit).map(gradeView)
  const guard = getDb().prepare(`
    SELECT * FROM evolution_promotion_online_guard_evaluations
    WHERE promotion_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(promotion.id) || null
  const rollback = getDb().prepare(`
    SELECT * FROM evolution_promotion_rollbacks WHERE promotion_id = ?
  `).get(promotion.id) || null
  return {
    monitoringEnabled: policyRow(promotion.canary_release_id)?.production_monitoring_enabled === 1,
    grades,
    guard: guard ? {
      id: guard.id,
      decision: guard.decision,
      metrics: parseJson(guard.metrics_json, {}),
      breaches: parseJson(guard.breaches_json, []),
      blockers: parseJson(guard.blockers_json, []),
      evaluationFingerprint: guard.evaluation_fingerprint,
      createdAt: guard.created_at,
    } : null,
    rollback: rollback ? {
      id: rollback.id,
      guardEvaluationId: rollback.guard_evaluation_id,
      breaches: parseJson(rollback.breaches_json, []),
      reason: rollback.reason,
      createdAt: rollback.created_at,
    } : null,
  }
}
