import { randomUUID } from 'node:crypto'

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
import {
  buildEvolutionPromotionOnlineGuard as buildPromotionOnlineGuard,
  evolutionPromotionOnlineGraderServiceError as serviceError,
  evolutionPromotionOnlineGraderSha256 as sha256,
  evolutionPromotionOnlineGradeView as gradeView,
  normalizeEvolutionPromotionOnlineGraderTimestamp as timestamp,
  parseEvolutionPromotionOnlineGraderJson as parseJson,
  requireEvolutionPromotionOnlineGraderOwner as ownerId,
} from './evolutionPromotionOnlineGraderSupport.js'

const MAX_BACKLOG_LIMIT = 1_000

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
    INSERT INTO evolution_promotion_outcome_snapshots (
      outcome_id, assignment_id, evaluated_provider_id, evaluated_model,
      evaluated_model_revision, evaluated_config_revision, input_content, output_content,
      input_sha256, output_sha256, snapshot_fingerprint, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(outcome_id) DO NOTHING
  `).run(
    snapshot.outcomeId, snapshot.assignmentId, providerId, selectedModel, revision,
    configRevision, request, response, snapshot.inputSha256, snapshot.outputSha256,
    fingerprint, timestamp(now),
  )
  return { ...snapshot, snapshotFingerprint: fingerprint }
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
    INSERT INTO evolution_promotion_online_grades (
      id, user_id, promotion_id, outcome_id, policy_id, execution_status,
      quality_score, safety_verdict, summary, evidence_json, issues_json, error_code,
      grader_provider_id, grader_model, grader_model_revision, grader_config_revision,
      evaluated_provider_id, evaluated_model, evaluated_model_revision, snapshot_fingerprint,
      policy_fingerprint, grade_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(outcome_id) DO NOTHING
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
    INSERT INTO evolution_promotion_online_guard_evaluations (
      id, user_id, promotion_id, policy_id, trigger_grade_id,
      baseline_guard_evaluation_id, sample_fingerprint, baseline_grade_ids_json,
      promotion_grade_ids_json, decision, metrics_json, breaches_json, blockers_json,
      evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trigger_grade_id) DO NOTHING
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
    INSERT INTO evolution_promotion_rollbacks (
      id, user_id, promotion_id, guard_evaluation_id, trigger_fingerprint,
      breaches_json, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(promotion_id) DO NOTHING
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

function validateOnlineGradeIdentity({ owner, promotion, outcome, policy, baselineGuard, fail }) {
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
  return identity
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
  const identity = validateOnlineGradeIdentity({
    owner,
    promotion,
    outcome,
    policy,
    baselineGuard,
    fail,
  })
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
