import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import { getEvolutionEvaluation } from './evolutionEvaluationService.js'
import { getEvolutionReplayRun } from './evolutionReplayService.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const DECISIONS = new Set(['approved', 'rejected'])
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

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_APPROVAL_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function normalizedDecision(value) {
  const decision = String(value || '').trim().toLowerCase()
  if (!DECISIONS.has(decision)) {
    throw serviceError('EVOLUTION_APPROVAL_DECISION_INVALID', 'decision must be approved or rejected')
  }
  return decision
}

function requiredReason(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.length > 2_000) {
    throw serviceError('EVOLUTION_APPROVAL_REASON_INVALID', 'reason must contain between 1 and 2000 characters')
  }
  return sanitizeEvolutionText(raw)
}

function exactDigest(value, expected, field) {
  const digest = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(digest) || digest !== expected) {
    throw serviceError('EVOLUTION_APPROVAL_CONFIRMATION_MISMATCH', `${field} does not match the immutable review`, 409)
  }
  return digest
}

function approvalEligibility(candidate, evaluation) {
  const issues = []
  if (candidate.kind !== 'prompt') issues.push('candidate_kind_unsupported')
  if (evaluation.verdict !== 'pass') issues.push('evaluation_not_pass')
  if (candidate.permissionsRequested.length > 0) issues.push('permission_change_unsupported')
  return { canApprove: issues.length === 0, issues }
}

function linkedReview({ userId, evaluationId }) {
  const evaluation = getEvolutionEvaluation({ userId, id: evaluationId })
  const replay = getEvolutionReplayRun({ userId, id: evaluation.replayId })
  const candidate = getEvolutionCandidate({ userId, id: evaluation.candidateId })
  if (replay.candidateId !== candidate.id
    || evaluation.candidateId !== candidate.id
    || replay.candidateSha256 !== candidate.contentSha256) {
    throw serviceError('EVOLUTION_APPROVAL_PROVENANCE_MISMATCH', 'approval provenance is inconsistent', 409)
  }
  const rollbackTarget = {
    kind: 'prompt_baseline',
    target: candidate.target,
    sourceReplayId: replay.id,
    contentSha256: replay.baselineSha256,
  }
  const confirmations = {
    candidateContentSha256: candidate.contentSha256,
    replayRunFingerprint: replay.runFingerprint,
    evaluationFingerprint: evaluation.evaluationFingerprint,
    rollbackBaselineSha256: replay.baselineSha256,
  }
  return {
    evaluation,
    replay,
    candidate,
    rollbackTarget,
    confirmations,
    eligibility: approvalEligibility(candidate, evaluation),
  }
}

function decisionView(row, { includeSnapshot = false } = {}) {
  return {
    id: row.id,
    evaluationId: row.evaluation_id,
    replayId: row.replay_id,
    candidateId: row.candidate_id,
    decision: row.decision,
    reason: row.reason,
    confirmations: {
      candidateContentSha256: row.candidate_sha256,
      replayRunFingerprint: row.replay_fingerprint,
      evaluationFingerprint: row.evaluation_fingerprint,
      rollbackBaselineSha256: row.rollback_baseline_sha256,
    },
    rollbackTarget: parseJson(row.rollback_target_json, {}),
    approverMode: row.approver_mode,
    decisionFingerprint: row.decision_fingerprint,
    createdAt: row.created_at,
    ...(includeSnapshot ? { reviewSnapshot: parseJson(row.review_snapshot_json, {}) } : {}),
  }
}

function existingDecision(userId, evaluationId) {
  const row = getDb().prepare(`
    SELECT * FROM evolution_approval_decisions
    WHERE user_id = ? AND evaluation_id = ?
  `).get(userId, evaluationId)
  return row ? decisionView(row) : null
}

export function buildEvolutionApprovalReview({ userId, evaluationId } = {}) {
  const owner = ownerId(userId)
  const linked = linkedReview({ userId: owner, evaluationId })
  return {
    schemaVersion: 1,
    evaluationId: linked.evaluation.id,
    candidate: {
      id: linked.candidate.id,
      kind: linked.candidate.kind,
      target: linked.candidate.target,
      title: linked.candidate.title,
      summary: linked.candidate.summary,
      provenance: linked.candidate.provenance,
      contentSha256: linked.candidate.contentSha256,
    },
    diff: {
      format: 'full_text_replace',
      before: linked.replay.baselineContent,
      after: linked.candidate.content,
      beforeSha256: linked.replay.baselineSha256,
      afterSha256: linked.candidate.contentSha256,
    },
    replay: {
      id: linked.replay.id,
      suiteId: linked.replay.suiteId,
      modelName: linked.replay.modelName,
      parameters: linked.replay.parameters,
      isolationMode: linked.replay.isolationMode,
      runFingerprint: linked.replay.runFingerprint,
    },
    evaluation: linked.evaluation,
    permissionChanges: {
      requested: linked.candidate.permissionsRequested,
      supportedForApproval: linked.candidate.permissionsRequested.length === 0,
    },
    rollbackTarget: linked.rollbackTarget,
    confirmations: linked.confirmations,
    eligibility: linked.eligibility,
    existingDecision: existingDecision(owner, linked.evaluation.id),
  }
}

export function decideEvolutionApproval({
  userId,
  evaluationId,
  decision: decisionValue,
  reason: reasonValue,
  confirmations: confirmationValue,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const decision = normalizedDecision(decisionValue)
  const reason = requiredReason(reasonValue)
  const linked = linkedReview({ userId: owner, evaluationId })
  if (existingDecision(owner, linked.evaluation.id)) {
    throw serviceError('EVOLUTION_APPROVAL_ALREADY_DECIDED', 'evaluation already has an immutable human decision', 409)
  }
  if (decision === 'approved' && !linked.eligibility.canApprove) {
    const code = linked.eligibility.issues.includes('permission_change_unsupported')
      ? 'EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED'
      : 'EVOLUTION_APPROVAL_NOT_ELIGIBLE'
    throw serviceError(code, 'evaluation is not eligible for approval', 409)
  }
  const supplied = confirmationValue && typeof confirmationValue === 'object' ? confirmationValue : {}
  const confirmations = {
    candidateContentSha256: exactDigest(
      supplied.candidateContentSha256,
      linked.confirmations.candidateContentSha256,
      'candidateContentSha256',
    ),
    replayRunFingerprint: exactDigest(
      supplied.replayRunFingerprint,
      linked.confirmations.replayRunFingerprint,
      'replayRunFingerprint',
    ),
    evaluationFingerprint: exactDigest(
      supplied.evaluationFingerprint,
      linked.confirmations.evaluationFingerprint,
      'evaluationFingerprint',
    ),
    rollbackBaselineSha256: exactDigest(
      supplied.rollbackBaselineSha256,
      linked.confirmations.rollbackBaselineSha256,
      'rollbackBaselineSha256',
    ),
  }
  const reviewSnapshot = {
    candidate: {
      id: linked.candidate.id,
      kind: linked.candidate.kind,
      target: linked.candidate.target,
      contentSha256: linked.candidate.contentSha256,
      provenance: linked.candidate.provenance,
    },
    replay: {
      id: linked.replay.id,
      suiteId: linked.replay.suiteId,
      runFingerprint: linked.replay.runFingerprint,
      modelName: linked.replay.modelName,
      parameters: linked.replay.parameters,
      isolationMode: linked.replay.isolationMode,
    },
    evaluation: {
      id: linked.evaluation.id,
      verdict: linked.evaluation.verdict,
      rubricVersion: linked.evaluation.rubricVersion,
      evaluator: linked.evaluation.evaluator,
      evaluationFingerprint: linked.evaluation.evaluationFingerprint,
      metrics: linked.evaluation.metrics,
      issues: linked.evaluation.issues,
    },
    permissionChanges: linked.candidate.permissionsRequested,
    rollbackTarget: linked.rollbackTarget,
  }
  const createdAt = timestamp(now)
  const id = randomUUID()
  const decisionFingerprint = sha256({
    evaluationId: linked.evaluation.id,
    decision,
    reason,
    confirmations,
    rollbackTarget: linked.rollbackTarget,
    reviewSnapshot,
    approverMode: 'local_owner_loopback',
    createdAt,
  })
  try {
    getDb().prepare(`
      INSERT INTO evolution_approval_decisions (
        id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
        candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        rollback_baseline_sha256, rollback_target_json, review_snapshot_json,
        approver_mode, decision_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local_owner_loopback', ?, ?)
    `).run(
      id,
      owner,
      linked.evaluation.id,
      linked.replay.id,
      linked.candidate.id,
      decision,
      reason,
      confirmations.candidateContentSha256,
      confirmations.replayRunFingerprint,
      confirmations.evaluationFingerprint,
      confirmations.rollbackBaselineSha256,
      JSON.stringify(linked.rollbackTarget),
      JSON.stringify(reviewSnapshot),
      decisionFingerprint,
      createdAt,
    )
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      throw serviceError('EVOLUTION_APPROVAL_ALREADY_DECIDED', 'evaluation already has an immutable human decision', 409)
    }
    throw error
  }
  return getEvolutionApprovalDecision({ userId: owner, id })
}

export function getEvolutionApprovalDecision({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(`
    SELECT * FROM evolution_approval_decisions WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_APPROVAL_NOT_FOUND', 'approval decision was not found', 404)
  return decisionView(row, { includeSnapshot: true })
}

export function listEvolutionApprovalDecisions({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_approval_decisions WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => decisionView(row))
}
