import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import {
  assertEvolutionModelIdentityCurrent,
  callEvolutionBackgroundModel,
  resolveEvolutionModelIdentity,
} from './evolutionModelRuntime.js'
import { buildOnlineGuard } from './evolutionOnlineGraderMetrics.js'
import {
  EVOLUTION_ONLINE_GRADER_POLICY_VERSION,
  EVOLUTION_ONLINE_RUBRIC_VERSION,
  boundedText,
  buildEvolutionOnlineGraderMessages,
  gradeView,
  normalizePolicy,
  onlineGuardView,
  ownerId,
  parseEvolutionOnlineGraderResponse,
  parseJson,
  policyView,
  serviceError,
  sha256,
  timestamp,
} from './evolutionOnlineGraderValidation.js'
import { applyEvolutionCanaryOnlineRollback } from './evolutionRollbackService.js'

export {
  EVOLUTION_ONLINE_GRADER_POLICY_VERSION,
  EVOLUTION_ONLINE_RUBRIC_VERSION,
  buildEvolutionOnlineGraderMessages,
  parseEvolutionOnlineGraderResponse,
}

const MAX_LIMIT = 200

function releaseRow(userId, releaseId) {
  const row = getDb().prepare(`
    SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?
  `).get(String(releaseId || '').trim(), userId)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  return row
}

function latestLifecycleEvent(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_events WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
}

function policyRow(releaseId) {
  return getDb().prepare(`
    SELECT * FROM evolution_canary_grader_policies WHERE release_id = ?
  `).get(releaseId) || null
}

export function createEvolutionCanaryGraderPolicy({
  userId,
  releaseId,
  graderProviderId,
  graderModelName,
  graderModelRevision,
  policy: policyValue,
  reason,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  if (latestLifecycleEvent(release.id)) {
    throw serviceError(
      'EVOLUTION_ONLINE_GRADER_POLICY_LOCKED',
      'online grader policy must be frozen before the canary starts',
      409,
    )
  }
  if (!getDb().prepare(`
    SELECT 1 FROM evolution_canary_rollback_policies WHERE release_id = ?
  `).get(release.id)) {
    throw serviceError(
      'EVOLUTION_CANARY_ROLLBACK_POLICY_REQUIRED',
      'declare the rollback policy before the online grader policy',
      409,
    )
  }
  const providerId = boundedText(graderProviderId, {
    code: 'EVOLUTION_ONLINE_GRADER_PROVIDER_REQUIRED',
    label: 'graderProviderId',
  })
  const modelName = boundedText(graderModelName, {
    code: 'EVOLUTION_ONLINE_GRADER_MODEL_REQUIRED',
    label: 'graderModelName',
  })
  const modelRevision = boundedText(graderModelRevision, {
    code: 'EVOLUTION_ONLINE_GRADER_REVISION_REQUIRED',
    label: 'graderModelRevision',
  })
  const normalizedReason = boundedText(reason, {
    code: 'EVOLUTION_ONLINE_GRADER_REASON_INVALID',
    label: 'reason',
    maximum: 2_000,
  })
  const identity = resolveEvolutionModelIdentity({
    userId: owner,
    providerId,
    modelName,
  })
  const thresholds = normalizePolicy(policyValue)
  const fingerprint = sha256({
    version: EVOLUTION_ONLINE_GRADER_POLICY_VERSION,
    rubricVersion: EVOLUTION_ONLINE_RUBRIC_VERSION,
    releaseFingerprint: release.release_fingerprint,
    graderProviderId: identity.providerId,
    graderModelName: identity.modelName,
    graderModelRevision: modelRevision,
    graderConfigRevision: identity.configRevision,
    thresholds,
  })
  try {
    getDb().prepare(`
      INSERT INTO evolution_canary_grader_policies (
        id, user_id, release_id, policy_version, rubric_version,
        grader_provider_id, grader_model, grader_model_revision, grader_config_revision,
        minimum_quality_score, maximum_quality_regression, maximum_safety_failure_rate,
        production_monitoring_enabled, reason, policy_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), owner, release.id, EVOLUTION_ONLINE_GRADER_POLICY_VERSION,
      EVOLUTION_ONLINE_RUBRIC_VERSION, identity.providerId, identity.modelName,
      modelRevision, identity.configRevision, thresholds.minimumQualityScore,
      thresholds.maximumQualityRegression, thresholds.maximumSafetyFailureRate,
      thresholds.productionMonitoringEnabled ? 1 : 0,
      normalizedReason, fingerprint, timestamp(now),
    )
  } catch (error) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw serviceError(
        'EVOLUTION_ONLINE_GRADER_POLICY_EXISTS',
        'canary release already has an immutable online grader policy',
        409,
      )
    }
    throw error
  }
  return policyView(policyRow(release.id))
}

export function recordEvolutionCanaryOutcomeSnapshot({
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
    INSERT INTO evolution_canary_outcome_snapshots (
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

function outcomeRow(userId, releaseId, outcomeId) {
  const row = getDb().prepare(`
    SELECT outcome.*, assignment.variant AS assigned_variant,
      COALESCE(context.effective_variant, assignment.variant) AS effective_variant,
      COALESCE(context.decision_reason, assignment.decision_reason) AS effective_reason,
      snapshot.evaluated_provider_id, snapshot.evaluated_model,
      snapshot.evaluated_model_revision, snapshot.evaluated_config_revision,
      snapshot.input_content, snapshot.output_content, snapshot.snapshot_fingerprint
    FROM evolution_canary_outcomes AS outcome
    JOIN evolution_canary_assignments AS assignment ON assignment.id = outcome.assignment_id
    LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
    LEFT JOIN evolution_canary_outcome_snapshots AS snapshot ON snapshot.outcome_id = outcome.id
    WHERE outcome.id = ? AND outcome.release_id = ? AND outcome.user_id = ?
  `).get(String(outcomeId || '').trim(), releaseId, userId)
  if (!row) throw serviceError('EVOLUTION_CANARY_OUTCOME_NOT_FOUND', 'canary outcome was not found', 404)
  return row
}

function insertGrade({ policy, outcome, normalized = null, errorCode = null, now }) {
  const status = normalized ? 'completed' : 'failed'
  const fingerprintInput = {
    policyFingerprint: policy.policy_fingerprint,
    outcomeId: outcome.id,
    variant: outcome.effective_variant,
    status,
    qualityScore: normalized?.qualityScore ?? null,
    safetyVerdict: normalized?.safetyVerdict ?? null,
    summary: normalized?.summary ?? null,
    evidence: normalized?.evidence || [],
    issues: normalized?.issues || [],
    errorCode,
    snapshotFingerprint: outcome.snapshot_fingerprint || null,
  }
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO evolution_canary_online_grades (
      id, user_id, release_id, outcome_id, policy_id, effective_variant,
      execution_status, quality_score, safety_verdict, summary, evidence_json,
      issues_json, error_code, grader_provider_id, grader_model,
      grader_model_revision, grader_config_revision, evaluated_provider_id,
      evaluated_model, evaluated_model_revision, snapshot_fingerprint,
      policy_fingerprint, grade_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(outcome_id) DO NOTHING
  `).run(
    id, outcome.user_id, outcome.release_id, outcome.id, policy.id, outcome.effective_variant,
    status, normalized?.qualityScore ?? null, normalized?.safetyVerdict ?? null,
    normalized?.summary ?? null, JSON.stringify(normalized?.evidence || []),
    JSON.stringify(normalized?.issues || []), errorCode, policy.grader_provider_id,
    policy.grader_model, policy.grader_model_revision, policy.grader_config_revision,
    outcome.evaluated_provider_id || null, outcome.evaluated_model || null,
    outcome.evaluated_model_revision || null, outcome.snapshot_fingerprint || null,
    policy.policy_fingerprint, sha256(fingerprintInput), timestamp(now),
  )
  return getDb().prepare(`
    SELECT * FROM evolution_canary_online_grades WHERE outcome_id = ?
  `).get(outcome.id)
}

function evaluateOnlineGuard({ userId, releaseId, policy, triggerGrade, now }) {
  const guard = buildOnlineGuard(releaseId, policy)
  const fingerprint = sha256({
    policyFingerprint: policy.policy_fingerprint,
    triggerGradeFingerprint: triggerGrade.grade_fingerprint,
    ...guard,
  })
  getDb().prepare(`
    INSERT INTO evolution_canary_online_guard_evaluations (
      id, user_id, release_id, policy_id, trigger_grade_id, sample_fingerprint,
      grade_ids_json, decision, metrics_json, breaches_json, blockers_json,
      evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trigger_grade_id) DO NOTHING
  `).run(
    randomUUID(), userId, releaseId, policy.id, triggerGrade.id, guard.sampleFingerprint,
    JSON.stringify(guard.gradeIds), guard.decision, JSON.stringify(guard.metrics),
    JSON.stringify(guard.breaches), JSON.stringify(guard.blockers), fingerprint, timestamp(now),
  )
  const evaluation = getDb().prepare(`
    SELECT * FROM evolution_canary_online_guard_evaluations WHERE trigger_grade_id = ?
  `).get(triggerGrade.id)
  if (evaluation?.decision === 'rollback') {
    applyEvolutionCanaryOnlineRollback({
      userId,
      releaseId,
      onlineGuardEvaluationId: evaluation.id,
      triggerFingerprint: evaluation.evaluation_fingerprint,
      breaches: parseJson(evaluation.breaches_json, []),
      now,
    })
  }
  return evaluation
}

function persistGradeAndEvaluateGuard({
  userId,
  releaseId,
  policy,
  outcome,
  normalized = null,
  errorCode = null,
  now,
}) {
  const db = getDb()
  return db.transaction(() => {
    const stillActive = db.prepare(`
      SELECT 1 FROM evolution_canary_releases AS release
      WHERE release.id = ? AND release.user_id = ?
        AND (SELECT event_type FROM evolution_canary_events
          WHERE release_id = release.id ORDER BY rowid DESC LIMIT 1) = 'started'
        AND NOT EXISTS (
          SELECT 1 FROM evolution_canary_rollbacks AS rollback
          WHERE rollback.release_id = release.id
        )
    `).get(releaseId, userId)
    if (!stillActive) return null
    const grade = insertGrade({ policy, outcome, normalized, errorCode, now })
    evaluateOnlineGuard({ userId, releaseId, policy, triggerGrade: grade, now })
    return grade
  }).immediate()
}

export async function runEvolutionCanaryOnlineGrade({
  userId,
  releaseId,
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
  const release = releaseRow(owner, releaseId)
  const policy = policyRow(release.id)
  if (!policy) {
    throw serviceError(
      'EVOLUTION_ONLINE_GRADER_POLICY_REQUIRED',
      'an immutable online grader policy is required',
      409,
    )
  }
  const outcome = outcomeRow(owner, release.id, outcomeId)
  const existing = getDb().prepare(`
    SELECT * FROM evolution_canary_online_grades WHERE outcome_id = ?
  `).get(outcome.id)
  if (existing) return gradeView(existing)
  const createdAt = timestamp(now)
  const fail = (code, message, statusCode = 502) => {
    persistGradeAndEvaluateGuard({
      userId: owner,
      releaseId: release.id,
      policy,
      outcome,
      errorCode: code,
      now: createdAt,
    })
    throw serviceError(code, message, statusCode)
  }
  if (!outcome.snapshot_fingerprint || !outcome.evaluated_provider_id
    || !outcome.evaluated_model || !outcome.evaluated_model_revision) {
    return fail(
      'EVOLUTION_ONLINE_GRADE_SNAPSHOT_MISSING',
      'outcome has no immutable model and response snapshot',
      409,
    )
  }
  if (policy.grader_provider_id === outcome.evaluated_provider_id
    && policy.grader_model === outcome.evaluated_model) {
    return fail(
      'EVOLUTION_ONLINE_GRADER_NOT_INDEPENDENT',
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
      'EVOLUTION_ONLINE_GRADER_CONFIG_CHANGED',
      'the frozen online grader Provider is no longer available',
      409,
    )
  }
  if (identity.providerId !== policy.grader_provider_id
    || identity.modelName !== policy.grader_model
    || identity.configRevision !== policy.grader_config_revision) {
    return fail(
      'EVOLUTION_ONLINE_GRADER_CONFIG_CHANGED',
      'the frozen online grader Provider configuration changed',
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
      'EVOLUTION_ONLINE_GRADER_MODEL_FAILED',
      'independent online grader model failed',
      502,
    )
  }
  const actualProvider = String(response?.providerId || '').trim()
  const actualModel = String(response?.modelName || '').trim()
  if (actualProvider !== policy.grader_provider_id || actualModel !== policy.grader_model) {
    return fail(
      'EVOLUTION_ONLINE_GRADER_MODEL_MISMATCH',
      'online grading did not use the frozen Provider and model',
      502,
    )
  }
  let normalized
  try {
    normalized = parseEvolutionOnlineGraderResponse(response)
    assertEvolutionModelIdentityCurrent({ userId: owner, identity })
  } catch (error) {
    return fail(
      error?.code || 'EVOLUTION_ONLINE_GRADER_OUTPUT_INVALID',
      error?.statusCode && error.statusCode < 500 ? error.message : 'online grader evidence was invalid',
      error?.statusCode || 502,
    )
  }
  const grade = persistGradeAndEvaluateGuard({
    userId: owner,
    releaseId: release.id,
    policy,
    outcome,
    normalized,
    now: createdAt,
  })
  return gradeView(grade)
}

export function getEvolutionCanaryOnlineGradeState({ userId, releaseId, limit = 100 } = {}) {
  const owner = ownerId(userId)
  const release = releaseRow(owner, releaseId)
  const numericLimit = Number(limit)
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_ONLINE_GRADE_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  const policy = policyRow(release.id)
  const grades = getDb().prepare(`
    SELECT * FROM evolution_canary_online_grades
    WHERE release_id = ? ORDER BY rowid DESC LIMIT ?
  `).all(release.id, numericLimit).map(gradeView)
  const outcomes = getDb().prepare(`
    SELECT outcome.id,
      COALESCE(context.effective_variant, assignment.variant) AS effective_variant,
      outcome.terminal_state, outcome.created_at,
      grade.id AS grade_id, grade.execution_status AS grade_status
    FROM evolution_canary_outcomes AS outcome
    JOIN evolution_canary_assignments AS assignment ON assignment.id = outcome.assignment_id
    LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
    LEFT JOIN evolution_canary_online_grades AS grade ON grade.outcome_id = outcome.id
    WHERE outcome.release_id = ? AND outcome.user_id = ?
    ORDER BY outcome.rowid DESC LIMIT ?
  `).all(release.id, owner, numericLimit).map((row) => ({
    id: row.id,
    variant: row.effective_variant,
    terminalState: row.terminal_state,
    createdAt: row.created_at,
    graded: Boolean(row.grade_id),
    gradeStatus: row.grade_status || null,
  }))
  const latest = getDb().prepare(`
    SELECT * FROM evolution_canary_online_guard_evaluations
    WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(release.id)
  const current = policy ? buildOnlineGuard(release.id, policy) : null
  const latestView = onlineGuardView(latest)
  const currentMatchesLatest = Boolean(
    current && latestView && current.sampleFingerprint === latestView.sampleFingerprint,
  )
  return {
    policy: policyView(policy),
    outcomes,
    grades,
    guard: latestView,
    currentEvidence: current ? {
      decision: current.decision,
      metrics: current.metrics,
      breaches: current.breaches,
      blockers: current.blockers,
      sampleFingerprint: current.sampleFingerprint,
      latestEvaluationCurrent: currentMatchesLatest,
    } : {
      decision: 'insufficient_evidence',
      blockers: ['online_grader_policy_missing'],
      latestEvaluationCurrent: false,
    },
  }
}

export function assertEvolutionOnlineGuardPassed({ userId, releaseId } = {}) {
  const state = getEvolutionCanaryOnlineGradeState({ userId, releaseId, limit: MAX_LIMIT })
  if (!state.policy) {
    throw serviceError(
      'EVOLUTION_PROMOTION_ONLINE_GRADER_POLICY_REQUIRED',
      'an immutable independent online grader policy is required for promotion',
      409,
    )
  }
  if (!state.guard || !state.currentEvidence.latestEvaluationCurrent
    || state.guard.decision !== 'continue'
    || state.currentEvidence.decision !== 'continue'
    || state.guard.breaches.length > 0
    || state.currentEvidence.blockers.length > 0) {
    throw serviceError(
      'EVOLUTION_PROMOTION_ONLINE_EVIDENCE_INSUFFICIENT',
      'current candidate and baseline quality/safety evidence has not passed the online guard',
      409,
    )
  }
  return state
}
