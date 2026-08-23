import { createHash, randomUUID } from 'node:crypto'

import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { getDb } from '../db.js'
import { getEvolutionApprovalDecision } from './evolutionApprovalService.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import { getEvolutionEvaluation } from './evolutionEvaluationService.js'
import { getEvolutionReplayRun } from './evolutionReplayService.js'
import { recordEvolutionCanaryOutcomeSnapshot } from './evolutionOnlineGraderService.js'
import {
  hasActiveEvolutionPromotion,
  recordEvolutionPromotionOutcome,
  resolveEvolutionPromotionAssignment,
} from './evolutionPromotionService.js'
import {
  assertEvolutionCanaryRollbackPolicyReady,
  evaluateEvolutionCanaryRollback,
  getEvolutionCanaryRollbackState,
  hasEvolutionCanaryRollback,
  hasEvolutionCanaryRollbackPolicy,
} from './evolutionRollbackService.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

const SUPPORTED_TARGET = 'prompt:workspace-instructions'
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const MAX_SESSIONS = 10
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

function boundedReason(value, code) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2_000) {
    throw serviceError(code, 'reason must contain between 1 and 2000 characters')
  }
  return sanitizeEvolutionText(raw)
}

function trafficPercent(value) {
  const percent = Number(value)
  if (!Number.isInteger(percent) || percent < 1 || percent > 10) {
    throw serviceError('EVOLUTION_CANARY_TRAFFIC_INVALID', 'trafficPercent must be between 1 and 10')
  }
  return percent
}

function resolveSessionReader(explicitReader) {
  if (typeof explicitReader !== 'function') {
    throw serviceError(
      'EVOLUTION_CANARY_SESSION_STORE_UNAVAILABLE',
      'readSession must be provided by the active Turn persistence host',
      503,
    )
  }
  return explicitReader
}

async function normalizeSessionIds(userId, value, { readSession } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SESSIONS) {
    throw serviceError('EVOLUTION_CANARY_SESSIONS_INVALID', `sessionIds must contain between 1 and ${MAX_SESSIONS} sessions`)
  }
  const ids = value.map((item) => String(item || '').trim())
  if (ids.some((id) => !id || id.length > 160) || new Set(ids).size !== ids.length) {
    throw serviceError('EVOLUTION_CANARY_SESSIONS_INVALID', 'sessionIds must be unique valid chat sessions')
  }
  const sessionReader = resolveSessionReader(readSession)
  for (const sessionId of ids) {
    if (!await sessionReader({ userId, sessionId })) {
      throw serviceError('EVOLUTION_CANARY_SESSION_NOT_FOUND', 'a scoped chat session was not found', 404)
    }
  }
  return ids.sort()
}

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_CANARY_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function latestEventRow(releaseId) {
  return getDb().prepare(`
    SELECT event_type, reason, created_at FROM evolution_canary_events
    WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
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

function outcomeSnapshotInput({
  modelProviderId,
  modelName,
  modelRevision,
  modelConfigRevision,
  evaluationInput,
  evaluationOutput,
}) {
  const configRevision = modelConfigRevision ?? null
  return {
    modelProviderId: modelProviderId || null,
    modelName: modelName || null,
    modelRevision: modelRevision || (configRevision ? `config:${configRevision}` : null),
    modelConfigRevision: configRevision,
    inputContent: evaluationInput || '',
    outputContent: evaluationOutput || '',
  }
}

function releaseStats(releaseId) {
  const assignmentRows = getDb().prepare(`
    SELECT variant, decision_reason, COUNT(*) AS count FROM evolution_canary_assignments
    WHERE release_id = ? GROUP BY variant, decision_reason
  `).all(releaseId)
  const outcomeRows = getDb().prepare(`
    SELECT COALESCE(context.effective_variant, assignment.variant) AS variant,
      outcome.terminal_state, outcome.duration_ms, outcome.usage_json
    FROM evolution_canary_outcomes AS outcome
    JOIN evolution_canary_assignments AS assignment ON assignment.id = outcome.assignment_id
    LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
    WHERE outcome.release_id = ?
  `).all(releaseId)
  const assignments = { baseline: 0, candidate: 0 }
  const assignmentReasons = {}
  for (const row of assignmentRows) {
    const count = Number(row.count) || 0
    assignments[row.variant] += count
    assignmentReasons[row.decision_reason] = count
  }
  const outcomes = {
    baseline: { completed: 0, failed: 0, cancelled: 0, totalDurationMs: 0, costUsd: 0, costMeasured: 0 },
    candidate: { completed: 0, failed: 0, cancelled: 0, totalDurationMs: 0, costUsd: 0, costMeasured: 0 },
  }
  for (const row of outcomeRows) {
    const target = outcomes[row.variant]
    target[row.terminal_state] += 1
    target.totalDurationMs += Math.max(0, Number(row.duration_ms) || 0)
    const usage = parseJson(row.usage_json, null)
    const costUsd = normalizeOptionalUsageNumber(usage?.costUsd)
    if (costUsd !== null) {
      target.costUsd += costUsd
      target.costMeasured += 1
    }
  }
  return { assignments, assignmentReasons, outcomes }
}

function releaseObservations(releaseId) {
  return getDb().prepare(`
    SELECT assignment.id, assignment.session_id, assignment.turn_id,
      assignment.variant AS assigned_variant,
      COALESCE(context.effective_variant, assignment.variant) AS effective_variant,
      COALESCE(context.decision_reason, assignment.decision_reason) AS effective_reason,
      assignment.bucket,
      assignment.baseline_sha256, assignment.observed_baseline_sha256,
      assignment.candidate_sha256, assignment.assigned_at,
      outcome.terminal_state, outcome.duration_ms, outcome.usage_json,
      outcome.error_code, outcome.created_at AS outcome_created_at
    FROM evolution_canary_assignments AS assignment
    LEFT JOIN evolution_canary_outcomes AS outcome ON outcome.assignment_id = assignment.id
    LEFT JOIN evolution_canary_outcome_context AS context ON context.outcome_id = outcome.id
    WHERE assignment.release_id = ?
    ORDER BY assignment.assigned_at DESC, assignment.rowid DESC
    LIMIT 200
  `).all(releaseId).map((entry) => ({
    assignmentId: entry.id,
    sessionId: entry.session_id,
    turnId: entry.turn_id,
    assignedVariant: entry.assigned_variant,
    variant: entry.effective_variant,
    decisionReason: entry.effective_reason,
    bucket: entry.bucket,
    baselineSha256: entry.baseline_sha256,
    observedBaselineSha256: entry.observed_baseline_sha256,
    candidateSha256: entry.candidate_sha256,
    assignedAt: entry.assigned_at,
    outcome: entry.terminal_state ? {
      terminalState: entry.terminal_state,
      durationMs: entry.duration_ms,
      usage: parseJson(entry.usage_json, null),
      errorCode: entry.error_code,
      createdAt: entry.outcome_created_at,
    } : null,
  }))
}

function releaseView(row, { includeDetails = false } = {}) {
  const latest = latestEventRow(row.id)
  const automaticRollback = getEvolutionCanaryRollbackState({
    userId: row.user_id,
    releaseId: row.id,
    includeEvaluations: includeDetails,
  })
  const rollback = automaticRollback.rollback
  return {
    id: row.id,
    approvalId: row.approval_id,
    evaluationId: row.evaluation_id,
    replayId: row.replay_id,
    candidateId: row.candidate_id,
    target: row.target,
    trafficPercent: row.traffic_percent,
    creationReason: row.creation_reason,
    ...(includeDetails ? {
      sessionIds: parseJson(row.session_ids_json, []),
      observations: releaseObservations(row.id),
      automaticRollback,
    } : {
      rollbackPolicyConfigured: Boolean(automaticRollback.policy),
      onlineGraderPolicyConfigured: Boolean(getDb().prepare(`
        SELECT 1 FROM evolution_canary_grader_policies WHERE release_id = ?
      `).get(row.id)),
      rollback: automaticRollback.rollback,
    }),
    baselineSha256: row.baseline_sha256,
    candidateSha256: row.candidate_sha256,
    releaseFingerprint: row.release_fingerprint,
    state: rollback ? 'rolled_back' : latest?.event_type === 'started' ? 'active' : latest ? 'stopped' : 'created',
    stateReason: rollback?.reason || latest?.reason || null,
    stateChangedAt: rollback?.createdAt ?? latest?.created_at ?? row.created_at,
    stats: releaseStats(row.id),
    createdAt: row.created_at,
  }
}

function currentWorkspaceInstructions(env) {
  const instructions = readWorkspaceInstructions({ env })
  const text = String(instructions?.text || '').trim()
  if (!text) {
    throw serviceError('EVOLUTION_CANARY_BASELINE_UNAVAILABLE', 'workspace instructions are not available', 409)
  }
  return text
}

function activeReleaseRows(userId) {
  return getDb().prepare(`
    SELECT canary.* FROM evolution_canary_releases AS canary
    WHERE canary.user_id = ?
      AND (SELECT event_type FROM evolution_canary_events
        WHERE release_id = canary.id ORDER BY rowid DESC LIMIT 1) = 'started'
      AND EXISTS (
        SELECT 1 FROM evolution_canary_rollback_policies AS policy WHERE policy.release_id = canary.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM evolution_canary_rollbacks AS rollback WHERE rollback.release_id = canary.id
      )
    ORDER BY canary.created_at DESC, canary.rowid DESC
  `).all(userId)
}

function approvedCanaryEvidence(owner, approvalId) {
  const approval = getEvolutionApprovalDecision({ userId: owner, id: approvalId })
  if (approval.decision !== 'approved') {
    throw serviceError('EVOLUTION_CANARY_APPROVAL_REQUIRED', 'an approved human decision is required', 409)
  }
  const candidate = getEvolutionCandidate({ userId: owner, id: approval.candidateId })
  const replay = getEvolutionReplayRun({ userId: owner, id: approval.replayId })
  const evaluation = getEvolutionEvaluation({ userId: owner, id: approval.evaluationId })
  if (candidate.kind !== 'prompt' || candidate.target !== SUPPORTED_TARGET) {
    throw serviceError('EVOLUTION_CANARY_TARGET_UNSUPPORTED', `only ${SUPPORTED_TARGET} can be canaried`, 409)
  }
  if (candidate.permissionsRequested.length > 0 || evaluation.verdict !== 'pass'
    || evaluation.replayId !== replay.id
    || evaluation.candidateId !== candidate.id
    || replay.candidateId !== candidate.id
    || sha256(replay.baselineContent) !== replay.baselineSha256
    || sha256(candidate.content) !== candidate.contentSha256
    || replay.candidateSha256 !== candidate.contentSha256
    || approval.confirmations.candidateContentSha256 !== candidate.contentSha256
    || approval.confirmations.replayRunFingerprint !== replay.runFingerprint
    || approval.confirmations.evaluationFingerprint !== evaluation.evaluationFingerprint
    || approval.confirmations.rollbackBaselineSha256 !== replay.baselineSha256) {
    throw serviceError('EVOLUTION_CANARY_PROVENANCE_MISMATCH', 'approved canary provenance is inconsistent', 409)
  }
  return { approval, candidate, replay, evaluation }
}

function assertCurrentBaseline(replay, env) {
  const baselineContent = currentWorkspaceInstructions(env)
  if (sha256(baselineContent) !== replay.baselineSha256) {
    throw serviceError('EVOLUTION_CANARY_BASELINE_MISMATCH', 'active workspace instructions differ from the approved rollback baseline', 409)
  }
}

export async function createEvolutionCanary({
  userId,
  approvalId,
  sessionIds: sessionIdsValue,
  trafficPercent: trafficValue,
  reason: reasonValue,
  readSession = null,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const { approval, candidate, replay, evaluation } = approvedCanaryEvidence(owner, approvalId)
  assertCurrentBaseline(replay, env)
  const sessionIds = await normalizeSessionIds(owner, sessionIdsValue, { readSession })
  const percent = trafficPercent(trafficValue)
  const reason = boundedReason(reasonValue, 'EVOLUTION_CANARY_REASON_INVALID')
  const createdAt = timestamp(now)
  const id = randomUUID()
  const releaseFingerprint = sha256({
    approvalFingerprint: approval.decisionFingerprint,
    target: candidate.target,
    trafficPercent: percent,
    sessionIds,
    baselineSha256: replay.baselineSha256,
    candidateSha256: candidate.contentSha256,
  })
  const db = getDb()
  try {
    db.prepare(`
      INSERT INTO evolution_canary_releases (
        id, user_id, approval_id, evaluation_id, replay_id, candidate_id,
        target, traffic_percent, creation_reason, session_ids_json, baseline_sha256,
        candidate_sha256, release_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, owner, approval.id, evaluation.id, replay.id, candidate.id,
      candidate.target, percent, reason, JSON.stringify(sessionIds), replay.baselineSha256,
      candidate.contentSha256, releaseFingerprint, createdAt,
    )
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      throw serviceError('EVOLUTION_CANARY_ALREADY_EXISTS', 'approval already has a canary release', 409)
    }
    throw error
  }
  return getEvolutionCanary({ userId: owner, id })
}

export function startEvolutionCanary({
  userId,
  id,
  reason: reasonValue,
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare('SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?')
    .get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  if (latestEventRow(row.id)) {
    throw serviceError('EVOLUTION_CANARY_NOT_STARTABLE', 'canary release has already entered its lifecycle', 409)
  }
  const { approval, candidate, replay, evaluation } = approvedCanaryEvidence(owner, row.approval_id)
  const sessionIds = parseJson(row.session_ids_json, [])
  const expectedFingerprint = sha256({
    approvalFingerprint: approval.decisionFingerprint,
    target: candidate.target,
    trafficPercent: row.traffic_percent,
    sessionIds,
    baselineSha256: replay.baselineSha256,
    candidateSha256: candidate.contentSha256,
  })
  if (row.evaluation_id !== evaluation.id || row.replay_id !== replay.id
    || row.candidate_id !== candidate.id || row.target !== candidate.target
    || row.baseline_sha256 !== replay.baselineSha256
    || row.candidate_sha256 !== candidate.contentSha256
    || row.release_fingerprint !== expectedFingerprint) {
    throw serviceError('EVOLUTION_CANARY_PROVENANCE_MISMATCH', 'canary release provenance is inconsistent', 409)
  }
  assertEvolutionCanaryRollbackPolicyReady({
    userId: owner,
    releaseId: row.id,
    baselineSha256: row.baseline_sha256,
    releaseFingerprint: row.release_fingerprint,
  })
  assertCurrentBaseline(replay, env)
  if (hasActiveEvolutionPromotion(owner, row.target)) {
    throw serviceError(
      'EVOLUTION_CANARY_PROMOTION_ACTIVE_CONFLICT',
      'an active production promotion already owns this target',
      409,
    )
  }
  const reason = boundedReason(reasonValue, 'EVOLUTION_CANARY_REASON_INVALID')
  const startedAt = timestamp(now)
  const db = getDb()
  db.transaction(() => {
    if (latestEventRow(row.id)) {
      throw serviceError('EVOLUTION_CANARY_NOT_STARTABLE', 'canary release has already entered its lifecycle', 409)
    }
    if (activeReleaseRows(owner).some((active) => active.target === row.target)) {
      throw serviceError('EVOLUTION_CANARY_ACTIVE_CONFLICT', 'an active canary already owns this target', 409)
    }
    if (hasActiveEvolutionPromotion(owner, row.target)) {
      throw serviceError(
        'EVOLUTION_CANARY_PROMOTION_ACTIVE_CONFLICT',
        'an active production promotion already owns this target',
        409,
      )
    }
    db.prepare(`
      INSERT INTO evolution_canary_events (id, user_id, release_id, event_type, reason, created_at)
      VALUES (?, ?, ?, 'started', ?, ?)
    `).run(randomUUID(), owner, row.id, reason, startedAt)
  }).immediate()
  return getEvolutionCanary({ userId: owner, id: row.id })
}

export function stopEvolutionCanary({ userId, id, reason: reasonValue, now = Date.now() } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare('SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?')
    .get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  if (hasEvolutionCanaryRollback(row.id) || latestEventRow(row.id)?.event_type !== 'started') {
    throw serviceError('EVOLUTION_CANARY_NOT_ACTIVE', 'canary release is not active', 409)
  }
  const reason = boundedReason(reasonValue, 'EVOLUTION_CANARY_STOP_REASON_INVALID')
  const stoppedAt = timestamp(now)
  const db = getDb()
  db.transaction(() => {
    if (hasEvolutionCanaryRollback(row.id) || latestEventRow(row.id)?.event_type !== 'started') {
      throw serviceError('EVOLUTION_CANARY_NOT_ACTIVE', 'canary release is not active', 409)
    }
    db.prepare(`
      INSERT INTO evolution_canary_events (id, user_id, release_id, event_type, reason, created_at)
      VALUES (?, ?, ?, 'stopped', ?, ?)
    `).run(randomUUID(), owner, row.id, reason, stoppedAt)
  }).immediate()
  return getEvolutionCanary({ userId: owner, id: row.id })
}

export function getEvolutionCanary({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare('SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?')
    .get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CANARY_NOT_FOUND', 'canary release was not found', 404)
  return releaseView(row, { includeDetails: true })
}

export function listEvolutionCanaries({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_canary_releases WHERE user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => releaseView(row))
}

export function resolveEvolutionCanaryAssignment({
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
    SELECT * FROM evolution_canary_assignments
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner, session, turn)
  const release = assignment
    ? db.prepare('SELECT * FROM evolution_canary_releases WHERE id = ? AND user_id = ?')
        .get(assignment.release_id, owner)
    : activeReleaseRows(owner).find((row) => parseJson(row.session_ids_json, []).includes(session))
  if (!release) {
    return resolveEvolutionPromotionAssignment({ userId: owner, sessionId: session, turnId: turn, env, now })
  }

  let baselineContent = null
  let observedBaselineSha256 = null
  const rollbackPolicyConfigured = hasEvolutionCanaryRollbackPolicy(release.id)
  let runtimeBlocker = 'baseline_unavailable'
  try {
    baselineContent = currentWorkspaceInstructions(env)
    observedBaselineSha256 = sha256(baselineContent)
    runtimeBlocker = observedBaselineSha256 === release.baseline_sha256
      ? rollbackPolicyConfigured ? null : 'rollback_policy_missing'
      : 'baseline_mismatch'
  } catch {
    // A new assignment records the fail-closed decision; an existing turn is downgraded in memory.
  }

  let candidate = null
  const assignmentNeedsCandidate = assignment?.decision_reason === 'traffic_candidate'
  if (!runtimeBlocker && (!assignment || assignmentNeedsCandidate)) {
    try {
      candidate = getEvolutionCandidate({ userId: owner, id: release.candidate_id })
      if (candidate.contentSha256 !== release.candidate_sha256 || candidate.target !== SUPPORTED_TARGET) {
        candidate = null
        runtimeBlocker = 'candidate_provenance_mismatch'
      }
    } catch {
      runtimeBlocker = 'candidate_provenance_mismatch'
    }
  }

  if (!assignment) {
    const bucket = Number.parseInt(sha256(`${release.release_fingerprint}:${session}:${turn}`).slice(0, 8), 16) % 100
    const candidateSelected = !runtimeBlocker && bucket < release.traffic_percent
    const variant = candidateSelected ? 'candidate' : 'baseline'
    const decisionReason = runtimeBlocker || (candidateSelected ? 'traffic_candidate' : 'traffic_baseline')
    const assignedAt = timestamp(now)
    assignment = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM evolution_canary_assignments
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get(owner, session, turn)
      if (existing) return existing

      const currentRelease = activeReleaseRows(owner).find((row) => (
        row.id === release.id
        && row.release_fingerprint === release.release_fingerprint
        && parseJson(row.session_ids_json, []).includes(session)
      ))
      if (!currentRelease) return null

      db.prepare(`
        INSERT OR IGNORE INTO evolution_canary_assignments (
          id, user_id, release_id, session_id, turn_id, variant, decision_reason, bucket,
          baseline_sha256, observed_baseline_sha256, candidate_sha256, assigned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), owner, currentRelease.id, session, turn, variant, decisionReason, bucket,
        currentRelease.baseline_sha256, observedBaselineSha256,
        currentRelease.candidate_sha256, assignedAt,
      )
      return db.prepare(`
        SELECT * FROM evolution_canary_assignments
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get(owner, session, turn) || null
    }).immediate()
  }
  if (!assignment || assignment.release_id !== release.id) return null
  const decisionReason = runtimeBlocker || assignment.decision_reason
  const variant = runtimeBlocker ? 'baseline' : assignment.variant
  const eligible = !runtimeBlocker && (
    assignment.decision_reason === 'traffic_candidate'
    || assignment.decision_reason === 'traffic_baseline'
  )
  return {
    id: assignment.id,
    releaseId: release.id,
    sessionId: assignment.session_id,
    turnId: assignment.turn_id,
    variant,
    decisionReason,
    eligible,
    bucket: assignment.bucket,
    target: release.target,
    baselineSha256: release.baseline_sha256,
    observedBaselineSha256: assignment.observed_baseline_sha256,
    candidateSha256: release.candidate_sha256,
    releaseFingerprint: release.release_fingerprint,
    promptContent: variant === 'candidate' && candidate ? candidate.content : baselineContent,
  }
}

export function recordEvolutionCanaryOutcome({
  userId,
  sessionId,
  turnId,
  terminalState: stateValue,
  durationMs,
  usage,
  errorCode = null,
  effectiveVariant: effectiveVariantValue = null,
  decisionReason: decisionReasonValue = null,
  modelProviderId = null,
  modelName = null,
  modelRevision = null,
  modelConfigRevision = null,
  evaluationInput = '',
  evaluationOutput = '',
  env = process.env,
  now = Date.now(),
} = {}) {
  const owner = String(userId || '').trim()
  const assignment = getDb().prepare(`
    SELECT * FROM evolution_canary_assignments
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(owner, String(sessionId || '').trim(), String(turnId || '').trim())
  if (!assignment) {
    return recordEvolutionPromotionOutcome({
      userId: owner,
      sessionId,
      turnId,
      terminalState: stateValue,
      durationMs,
      usage,
      errorCode,
      modelProviderId,
      modelName,
      modelRevision,
      modelConfigRevision,
      evaluationInput,
      evaluationOutput,
      now,
    })
  }
  const terminalState = String(stateValue || '').trim().toLowerCase()
  if (!TERMINAL_STATES.has(terminalState)) {
    throw serviceError('EVOLUTION_CANARY_OUTCOME_INVALID', 'terminalState is invalid')
  }
  const rawDuration = Number(durationMs)
  const duration = Number.isFinite(rawDuration)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(rawDuration)))
    : 0
  const normalizedUsage = normalizeUsage(usage)
  const effectiveVariant = ['baseline', 'candidate'].includes(effectiveVariantValue)
    ? effectiveVariantValue
    : assignment.variant
  const allowedDecisionReasons = new Set([
    'traffic_baseline', 'traffic_candidate', 'baseline_mismatch',
    'baseline_unavailable', 'candidate_provenance_mismatch',
    'rollback_policy_missing',
  ])
  const decisionReason = allowedDecisionReasons.has(decisionReasonValue)
    ? decisionReasonValue
    : assignment.decision_reason
  const normalizedErrorCode = errorCode
    ? String(errorCode).trim().replace(/[^a-zA-Z0-9_.:-]/gu, '_').slice(0, 160) || null
    : null
  const db = getDb()
  const outcomeId = randomUUID()
  const createdAt = timestamp(now)
  db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO evolution_canary_outcomes (
        id, user_id, release_id, assignment_id, terminal_state,
        duration_ms, usage_json, error_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      outcomeId, owner, assignment.release_id, assignment.id, terminalState,
      duration, normalizedUsage ? JSON.stringify(normalizedUsage) : null,
      normalizedErrorCode, createdAt,
    )
    if (inserted.changes !== 1) return
    db.prepare(`
      INSERT INTO evolution_canary_outcome_context (
        outcome_id, assignment_id, effective_variant, decision_reason, recorded_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(outcomeId, assignment.id, effectiveVariant, decisionReason, createdAt)
    const snapshot = outcomeSnapshotInput({
      modelProviderId,
      modelName,
      modelRevision,
      modelConfigRevision,
      evaluationInput,
      evaluationOutput,
    })
    recordEvolutionCanaryOutcomeSnapshot({
      outcomeId,
      assignmentId: assignment.id,
      ...snapshot,
      now: createdAt,
    })
    evaluateEvolutionCanaryRollback({
      userId: owner,
      releaseId: assignment.release_id,
      outcomeId,
      env,
      now: createdAt,
    })
  })()
  return getEvolutionCanary({ userId: owner, id: assignment.release_id })
}
