import { createHash } from 'node:crypto'

import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { getDb } from '../db.js'
import { getEvolutionCanaryRollbackState } from './evolutionRollbackService.js'

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

export function parseJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function latestEventRow(releaseId) {
  return getDb().prepare(`
    SELECT event_type, reason, created_at FROM evolution_canary_events
    WHERE release_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(releaseId) || null
}

export function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null
  const result = {}
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheHitTokens', 'cacheMissTokens', 'costUsd']) {
    const number = normalizeOptionalUsageNumber(value[key])
    if (number !== null) result[key] = number
  }
  return Object.keys(result).length ? result : null
}

export function outcomeSnapshotInput({
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

export function releaseView(row, { includeDetails = false } = {}) {
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
