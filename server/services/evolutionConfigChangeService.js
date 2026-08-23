import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'
import {
  configSha256,
  normalizeEvolutionConfigPatch,
  normalizeRuntimeConfigDocument,
} from './evolutionConfigPolicy.js'
import {
  createEvolutionConfigJournal,
  executeEvolutionConfigJournalChange,
  reconcileEvolutionConfigJournal,
} from './evolutionConfigJournalService.js'
import {
  activateEvolutionRuntimeEnv,
  readEvolutionRuntimeState,
} from './evolutionConfigRuntime.js'

const SHA256_RE = /^[a-f0-9]{64}$/u
const DECISIONS = new Set(['approved', 'rejected'])
const REVERSAL_OPERATIONS = new Set(['rollback', 'revoke'])
const MAX_LIMIT = 100

function serviceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
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

function requiredReason(value) {
  const reason = String(value || '').trim()
  if (!reason || reason.length > 2_000) {
    throw serviceError('EVOLUTION_CONFIG_REASON_INVALID', 'reason must contain between 1 and 2000 characters')
  }
  return sanitizeEvolutionText(reason)
}

function exactHash(value, expected, field) {
  const hash = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(hash) || hash !== expected) {
    throw serviceError(
      'EVOLUTION_CONFIG_CONFIRMATION_MISMATCH',
      `${field} does not match the immutable config review`,
      409,
    )
  }
  return hash
}

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_CONFIG_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function linkedEvaluation(owner, evaluationId) {
  const evaluation = getDb().prepare(`
    SELECT * FROM evolution_config_evaluations WHERE id = ? AND user_id = ?
  `).get(String(evaluationId || '').trim(), owner)
  if (!evaluation) {
    throw serviceError('EVOLUTION_CONFIG_EVALUATION_NOT_FOUND', 'config evaluation was not found', 404)
  }
  const replay = getDb().prepare(`
    SELECT * FROM evolution_config_replays WHERE id = ? AND user_id = ?
  `).get(evaluation.replay_id, owner)
  const candidate = getEvolutionCandidate({ userId: owner, id: evaluation.candidate_id })
  if (!replay
    || replay.candidate_id !== candidate.id
    || evaluation.candidate_id !== candidate.id
    || candidate.kind !== 'config'
    || candidate.target !== 'config:runtime') {
    throw serviceError('EVOLUTION_CONFIG_PROVENANCE_MISMATCH', 'config review provenance is inconsistent', 409)
  }
  const report = parseJson(replay.report_json, {})
  if (report.candidateContentSha256 !== candidate.contentSha256) {
    throw serviceError('EVOLUTION_CONFIG_PROVENANCE_MISMATCH', 'config candidate hash changed after replay', 409)
  }
  const issues = [
    ...(evaluation.verdict === 'pass' ? [] : ['evaluation_not_pass']),
    ...(candidate.permissionsRequested.length === 0 ? [] : ['permission_change_unsupported']),
    ...(Array.isArray(report.issues) && report.issues.length === 0 ? [] : ['replay_policy_issues']),
  ]
  return { evaluation, replay, candidate, report, issues }
}

function approvalView(row, { includeSnapshot = false } = {}) {
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
      baselineDocumentSha256: row.baseline_document_sha256,
      proposedDocumentSha256: row.proposed_document_sha256,
    },
    approverMode: row.approver_mode,
    decisionFingerprint: row.decision_fingerprint,
    createdAt: row.created_at,
    ...(includeSnapshot ? { reviewSnapshot: parseJson(row.review_snapshot_json, {}) } : {}),
  }
}

export function buildEvolutionConfigApprovalReview({ userId, evaluationId } = {}) {
  const owner = ownerId(userId)
  const linked = linkedEvaluation(owner, evaluationId)
  const existing = getDb().prepare(`
    SELECT * FROM evolution_config_approval_decisions
    WHERE user_id = ? AND evaluation_id = ?
  `).get(owner, linked.evaluation.id)
  return {
    schemaVersion: 1,
    evaluationId: linked.evaluation.id,
    candidate: {
      id: linked.candidate.id,
      kind: linked.candidate.kind,
      target: linked.candidate.target,
      title: linked.candidate.title,
      summary: linked.candidate.summary,
      patch: normalizeEvolutionConfigPatch(linked.candidate.content),
      contentSha256: linked.candidate.contentSha256,
    },
    replay: {
      id: linked.replay.id,
      isolationMode: linked.replay.isolation_mode,
      report: linked.report,
      runFingerprint: linked.replay.run_fingerprint,
    },
    evaluation: {
      id: linked.evaluation.id,
      verdict: linked.evaluation.verdict,
      policyVersion: linked.evaluation.policy_version,
      issues: parseJson(linked.evaluation.issues_json, []),
      metrics: parseJson(linked.evaluation.metrics_json, {}),
      evaluationFingerprint: linked.evaluation.evaluation_fingerprint,
    },
    permissionChanges: {
      requested: linked.candidate.permissionsRequested,
      supportedForApproval: linked.candidate.permissionsRequested.length === 0,
    },
    confirmations: {
      candidateContentSha256: linked.candidate.contentSha256,
      replayRunFingerprint: linked.replay.run_fingerprint,
      evaluationFingerprint: linked.evaluation.evaluation_fingerprint,
      baselineDocumentSha256: linked.replay.baseline_document_sha256,
      proposedDocumentSha256: linked.replay.proposed_document_sha256,
    },
    eligibility: { canApprove: linked.issues.length === 0, issues: linked.issues },
    existingDecision: existing ? approvalView(existing) : null,
  }
}

export function decideEvolutionConfigApproval({
  userId,
  evaluationId,
  decision: decisionValue,
  reason: reasonValue,
  confirmations: suppliedValue,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const decision = String(decisionValue || '').trim().toLowerCase()
  if (!DECISIONS.has(decision)) {
    throw serviceError('EVOLUTION_CONFIG_DECISION_INVALID', 'decision must be approved or rejected')
  }
  const reason = requiredReason(reasonValue)
  const review = buildEvolutionConfigApprovalReview({ userId: owner, evaluationId })
  if (review.existingDecision) {
    throw serviceError('EVOLUTION_CONFIG_ALREADY_DECIDED', 'config evaluation already has a decision', 409)
  }
  if (decision === 'approved' && !review.eligibility.canApprove) {
    const code = review.permissionChanges.requested.length > 0
      ? 'EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED'
      : 'EVOLUTION_CONFIG_NOT_ELIGIBLE'
    throw serviceError(code, 'config evaluation is not eligible for approval', 409)
  }
  const supplied = suppliedValue && typeof suppliedValue === 'object' ? suppliedValue : {}
  const confirmations = Object.fromEntries(Object.entries(review.confirmations).map(([field, expected]) => (
    [field, exactHash(supplied[field], expected, field)]
  )))
  const reviewSnapshot = {
    candidate: review.candidate,
    replay: review.replay,
    evaluation: review.evaluation,
    permissionChanges: review.permissionChanges,
    confirmations,
  }
  const createdAt = timestamp(now)
  const decisionFingerprint = configSha256({
    evaluationId: review.evaluationId,
    decision,
    reason,
    confirmations,
    reviewSnapshot,
    approverMode: 'local_owner_loopback',
    createdAt,
  })
  const id = randomUUID()
  try {
    getDb().prepare(`
      INSERT INTO evolution_config_approval_decisions (
        id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
        candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        baseline_document_sha256, proposed_document_sha256,
        review_snapshot_json, approver_mode, decision_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local_owner_loopback', ?, ?)
    `).run(
      id,
      owner,
      review.evaluationId,
      review.replay.id,
      review.candidate.id,
      decision,
      reason,
      confirmations.candidateContentSha256,
      confirmations.replayRunFingerprint,
      confirmations.evaluationFingerprint,
      confirmations.baselineDocumentSha256,
      confirmations.proposedDocumentSha256,
      JSON.stringify(reviewSnapshot),
      decisionFingerprint,
      createdAt,
    )
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) {
      throw serviceError('EVOLUTION_CONFIG_ALREADY_DECIDED', 'config evaluation already has a decision', 409)
    }
    throw error
  }
  return getEvolutionConfigApproval({ userId: owner, id })
}

export function getEvolutionConfigApproval({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(`
    SELECT * FROM evolution_config_approval_decisions WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CONFIG_APPROVAL_NOT_FOUND', 'config approval was not found', 404)
  return approvalView(row, { includeSnapshot: true })
}

export function listEvolutionConfigApprovals({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_config_approval_decisions WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => approvalView(row))
}

function linkedApproval(owner, approvalId) {
  const approval = getDb().prepare(`
    SELECT * FROM evolution_config_approval_decisions WHERE id = ? AND user_id = ?
  `).get(String(approvalId || '').trim(), owner)
  if (!approval) throw serviceError('EVOLUTION_CONFIG_APPROVAL_NOT_FOUND', 'config approval was not found', 404)
  const replay = getDb().prepare(`
    SELECT * FROM evolution_config_replays WHERE id = ? AND user_id = ?
  `).get(approval.replay_id, owner)
  const candidate = getEvolutionCandidate({ userId: owner, id: approval.candidate_id })
  if (!replay
    || replay.candidate_id !== candidate.id
    || approval.candidate_sha256 !== candidate.contentSha256
    || approval.replay_fingerprint !== replay.run_fingerprint
    || approval.baseline_document_sha256 !== replay.baseline_document_sha256
    || approval.proposed_document_sha256 !== replay.proposed_document_sha256) {
    throw serviceError('EVOLUTION_CONFIG_PROVENANCE_MISMATCH', 'config apply provenance is inconsistent', 409)
  }
  return { approval, replay, candidate }
}

function existingApply(owner, approvalId) {
  return getDb().prepare(`
    SELECT * FROM evolution_config_change_events
    WHERE user_id = ? AND approval_id = ? AND operation = 'apply'
  `).get(owner, approvalId)
}

export function buildEvolutionConfigApplyReview({
  userId,
  approvalId,
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
} = {}) {
  const owner = ownerId(userId)
  const linked = linkedApproval(owner, approvalId)
  const current = readEvolutionRuntimeState({ cwd, env, hostEnv })
  const currentEffectiveSha256 = configSha256(current.effective)
  const priorApply = existingApply(owner, linked.approval.id)
  const issues = [
    ...(linked.approval.decision === 'approved' ? [] : ['approval_not_approved']),
    ...(linked.candidate.permissionsRequested.length === 0 ? [] : ['permission_change_unsupported']),
    ...(current.documentSha256 === linked.replay.baseline_document_sha256 ? [] : ['baseline_cas_mismatch']),
    ...(currentEffectiveSha256 === linked.replay.baseline_effective_sha256
      ? []
      : ['effective_baseline_cas_mismatch']),
    ...(priorApply ? ['already_applied'] : []),
  ]
  const confirmations = {
    candidateContentSha256: linked.candidate.contentSha256,
    replayRunFingerprint: linked.replay.run_fingerprint,
    evaluationFingerprint: linked.approval.evaluation_fingerprint,
    approvalDecisionFingerprint: linked.approval.decision_fingerprint,
    baselineDocumentSha256: linked.replay.baseline_document_sha256,
    proposedDocumentSha256: linked.replay.proposed_document_sha256,
    baselineEffectiveSha256: linked.replay.baseline_effective_sha256,
  }
  const applyConfirmationSha256 = configSha256({
    operation: 'apply',
    approvalId: linked.approval.id,
    confirmations,
  })
  return {
    schemaVersion: 1,
    approvalId: linked.approval.id,
    candidate: {
      id: linked.candidate.id,
      target: linked.candidate.target,
      title: linked.candidate.title,
      patch: normalizeEvolutionConfigPatch(linked.candidate.content),
    },
    confirmations: { ...confirmations, applyConfirmationSha256 },
    eligibility: { canApply: issues.length === 0, issues },
  }
}

function eventView(row) {
  const reversal = row.operation === 'apply'
    ? getDb().prepare(`
      SELECT id, operation, created_at FROM evolution_config_change_events
      WHERE user_id = ? AND root_apply_id = ? AND operation IN ('rollback', 'revoke')
    `).get(row.user_id, row.id)
    : null
  return {
    id: row.id,
    approvalId: row.approval_id,
    candidateId: row.candidate_id,
    rootApplyId: row.root_apply_id || null,
    operation: row.operation,
    beforeDocumentSha256: row.before_document_sha256,
    afterDocumentSha256: row.after_document_sha256,
    expectedCurrentSha256: row.expected_current_sha256,
    reason: row.reason,
    confirmationSha256: row.confirmation_sha256,
    eventFingerprint: row.event_fingerprint,
    createdAt: row.created_at,
    ...(row.operation === 'apply' ? {
      state: reversal ? 'reversed' : 'active',
      reversal: reversal ? {
        id: reversal.id,
        operation: reversal.operation,
        createdAt: reversal.created_at,
      } : null,
      rollbackConfirmationSha256: reversal ? null : configSha256({
        operation: 'rollback',
        applyId: row.id,
        applyEventFingerprint: row.event_fingerprint,
        expectedCurrentSha256: row.after_document_sha256,
      }),
      revokeConfirmationSha256: reversal ? null : configSha256({
        operation: 'revoke',
        applyId: row.id,
        applyEventFingerprint: row.event_fingerprint,
        expectedCurrentSha256: row.after_document_sha256,
      }),
    } : {}),
  }
}

export function applyEvolutionConfigCandidate({
  userId,
  approvalId,
  reason: reasonValue,
  confirmationSha256,
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
  now = Date.now(),
  activate,
  crashInjector,
} = {}) {
  const owner = ownerId(userId)
  reconcileEvolutionConfigJournal({ userId: owner, cwd, env, activate })
  const reason = requiredReason(reasonValue)
  const review = buildEvolutionConfigApplyReview({ userId: owner, approvalId, cwd, env, hostEnv })
  if (!review.eligibility.canApply) {
    const code = review.eligibility.issues.includes('baseline_cas_mismatch')
      ? 'EVOLUTION_CONFIG_CAS_MISMATCH'
      : 'EVOLUTION_CONFIG_APPLY_NOT_ELIGIBLE'
    throw serviceError(code, 'config candidate is not eligible to apply', 409)
  }
  const confirmation = exactHash(
    confirmationSha256,
    review.confirmations.applyConfirmationSha256,
    'applyConfirmationSha256',
  )
  const linked = linkedApproval(owner, approvalId)
  const patch = normalizeEvolutionConfigPatch(linked.candidate.content)
  const keys = Object.keys(patch.env)
  const current = readEvolutionRuntimeState({ cwd, env, hostEnv })
  const beforeEnv = current.document.env
  const activateConfig = (nextEnv) => {
    try {
      if (typeof activate === 'function') activate(nextEnv, keys)
      else activateEvolutionRuntimeEnv(nextEnv, keys)
    } catch (error) {
      try {
        if (typeof activate === 'function') activate(beforeEnv, keys)
        else activateEvolutionRuntimeEnv(beforeEnv, keys)
      } catch { /* the file rollback still proceeds */ }
      throw error
    }
  }
  const createdAt = timestamp(now)
  const id = randomUUID()
  const afterContent = normalizeRuntimeConfigDocument(linked.replay.proposed_document_json).content
  const afterSha256 = configSha256(afterContent)
  const eventFingerprint = configSha256({
    operation: 'apply',
    approvalId: linked.approval.id,
    candidateId: linked.candidate.id,
    beforeDocumentSha256: current.documentSha256,
    afterDocumentSha256: afterSha256,
    reason,
    confirmationSha256: confirmation,
    createdAt,
  })
  const event = Object.freeze({
    id,
    userId: owner,
    approvalId: linked.approval.id,
    candidateId: linked.candidate.id,
    rootApplyId: null,
    operation: 'apply',
    beforeDocumentJson: current.rawContent,
    afterDocumentJson: afterContent,
    beforeDocumentSha256: current.documentSha256,
    afterDocumentSha256: afterSha256,
    expectedCurrentSha256: linked.replay.baseline_document_sha256,
    reason,
    confirmationSha256: confirmation,
    eventFingerprint,
    createdAt,
  })
  const journal = createEvolutionConfigJournal({
    targetPath: current.path,
    reviewFingerprint: linked.approval.decision_fingerprint,
    event,
  })
  executeEvolutionConfigJournalChange({ journal, activate: activateConfig, crashInjector })
  return getEvolutionConfigChange({ userId: owner, id })
}

export function reverseEvolutionConfigChange({
  userId,
  applyId,
  operation: operationValue,
  reason: reasonValue,
  confirmationSha256,
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
  now = Date.now(),
  activate,
  crashInjector,
} = {}) {
  const owner = ownerId(userId)
  reconcileEvolutionConfigJournal({ userId: owner, cwd, env, activate })
  const operation = String(operationValue || '').trim().toLowerCase()
  if (!REVERSAL_OPERATIONS.has(operation)) {
    throw serviceError('EVOLUTION_CONFIG_REVERSAL_INVALID', 'operation must be rollback or revoke')
  }
  const reason = requiredReason(reasonValue)
  const applyRow = getDb().prepare(`
    SELECT * FROM evolution_config_change_events
    WHERE id = ? AND user_id = ? AND operation = 'apply'
  `).get(String(applyId || '').trim(), owner)
  if (!applyRow) throw serviceError('EVOLUTION_CONFIG_APPLY_NOT_FOUND', 'config apply event was not found', 404)
  const existing = getDb().prepare(`
    SELECT id FROM evolution_config_change_events
    WHERE user_id = ? AND root_apply_id = ? AND operation IN ('rollback', 'revoke')
  `).get(owner, applyRow.id)
  if (existing) throw serviceError('EVOLUTION_CONFIG_ALREADY_REVERSED', 'config apply was already reversed', 409)
  const expectedConfirmation = configSha256({
    operation,
    applyId: applyRow.id,
    applyEventFingerprint: applyRow.event_fingerprint,
    expectedCurrentSha256: applyRow.after_document_sha256,
  })
  const confirmation = exactHash(confirmationSha256, expectedConfirmation, `${operation}ConfirmationSha256`)
  const current = readEvolutionRuntimeState({ cwd, env, hostEnv })
  if (current.documentSha256 !== applyRow.after_document_sha256) {
    throw serviceError('EVOLUTION_CONFIG_CAS_MISMATCH', 'runtime config changed after apply', 409)
  }
  const candidate = getEvolutionCandidate({ userId: owner, id: applyRow.candidate_id })
  const keys = Object.keys(normalizeEvolutionConfigPatch(candidate.content).env)
  const beforeEnv = current.document.env
  const activateConfig = (nextEnv) => {
    try {
      if (typeof activate === 'function') activate(nextEnv, keys)
      else activateEvolutionRuntimeEnv(nextEnv, keys)
    } catch (error) {
      try {
        if (typeof activate === 'function') activate(beforeEnv, keys)
        else activateEvolutionRuntimeEnv(beforeEnv, keys)
      } catch { /* the file rollback still proceeds */ }
      throw error
    }
  }
  const createdAt = timestamp(now)
  const id = randomUUID()
  // The apply audit stores the exact baseline bytes. A reversal must restore
  // those bytes rather than a canonical reserialization of the same JSON.
  normalizeRuntimeConfigDocument(applyRow.before_document_json)
  const afterContent = applyRow.before_document_json
  const afterSha256 = configSha256(afterContent)
  const eventFingerprint = configSha256({
    operation,
    applyId: applyRow.id,
    beforeDocumentSha256: current.documentSha256,
    afterDocumentSha256: afterSha256,
    reason,
    confirmationSha256: confirmation,
    createdAt,
  })
  const event = Object.freeze({
    id,
    userId: owner,
    approvalId: applyRow.approval_id,
    candidateId: applyRow.candidate_id,
    rootApplyId: applyRow.id,
    operation,
    beforeDocumentJson: current.rawContent,
    afterDocumentJson: afterContent,
    beforeDocumentSha256: current.documentSha256,
    afterDocumentSha256: afterSha256,
    expectedCurrentSha256: applyRow.after_document_sha256,
    reason,
    confirmationSha256: confirmation,
    eventFingerprint,
    createdAt,
  })
  const journal = createEvolutionConfigJournal({
    targetPath: current.path,
    reviewFingerprint: applyRow.event_fingerprint,
    event,
  })
  executeEvolutionConfigJournalChange({ journal, activate: activateConfig, crashInjector })
  return getEvolutionConfigChange({ userId: owner, id })
}

export function getEvolutionConfigChange({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(`
    SELECT * FROM evolution_config_change_events WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CONFIG_CHANGE_NOT_FOUND', 'config change was not found', 404)
  return eventView(row)
}

export function listEvolutionConfigChanges({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_config_change_events WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => eventView(row))
}
