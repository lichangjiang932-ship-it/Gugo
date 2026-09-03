import { createHash } from 'node:crypto'

import { getDb } from '../db.js'
import { sanitizeEvolutionText } from './evolutionDatasetService.js'

export const SUPPORTED_AUTO_EVOLUTION_TARGET = 'prompt:workspace-instructions'
const MAX_LIMIT = 100
export const DEFAULT_AUTO_EVOLUTION_OBJECTIVE = 'Improve workspace instructions from verified failures and explicit user feedback without adding permissions.'
export const DEFAULT_AUTO_ROLLBACK_POLICY = Object.freeze({
  windowSize: 10,
  minimumCandidateOutcomes: 3,
  minimumBaselineOutcomes: 3,
  maximumCandidateFailureRate: 0,
  maximumCandidateCancellationRate: 0.1,
  maximumLatencyRatio: 1.5,
})

export function evolutionAutoServiceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function stableEvolutionAutoJson(value) {
  return JSON.stringify(stableValue(value))
}

export function evolutionAutoSha256(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableEvolutionAutoJson(value))
    .digest('hex')
}

export function parseEvolutionAutoJson(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

export function requireEvolutionAutoOwner(value) {
  const owner = String(value || '').trim()
  if (!owner) throw evolutionAutoServiceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return owner
}

export function normalizeEvolutionAutoTimestamp(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw evolutionAutoServiceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return number
}

export function boundedEvolutionAutoText(value, label, maximum = 2_000, fallback = '') {
  const text = String(value ?? fallback).trim()
  if (!text || text.length > maximum) {
    throw evolutionAutoServiceError(
      'EVOLUTION_AUTO_CONFIG_INVALID',
      `${label} must contain between 1 and ${maximum} characters`,
    )
  }
  return sanitizeEvolutionText(text)
}

export function boundedEvolutionAutoInteger(value, label, minimum, maximum, fallback) {
  const number = value == null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw evolutionAutoServiceError(
      'EVOLUTION_AUTO_CONFIG_INVALID',
      `${label} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return number
}

export function boundedEvolutionAutoNumber(value, label, minimum, maximum, fallback) {
  const number = value == null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw evolutionAutoServiceError(
      'EVOLUTION_AUTO_CONFIG_INVALID',
      `${label} must be between ${minimum} and ${maximum}`,
    )
  }
  return number
}

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw evolutionAutoServiceError(
      'EVOLUTION_AUTO_LIMIT_INVALID',
      `limit must be between 1 and ${MAX_LIMIT}`,
    )
  }
  return limit
}

export function getEvolutionAutoConfigRow(userId) {
  return getDb().prepare('SELECT * FROM evolution_auto_configs WHERE user_id = ?').get(userId) || null
}

function configView(row) {
  if (!row) return null
  return {
    enabled: row.enabled === 1,
    target: row.target,
    objective: row.objective,
    generator: { providerId: row.generator_provider_id, modelName: row.generator_model },
    replay: { providerId: row.replay_provider_id, modelName: row.replay_model },
    evaluator: { providerId: row.evaluator_provider_id, modelName: row.evaluator_model },
    resolvedSessionIds: parseEvolutionAutoJson(row.session_ids_json, []),
    sessionScopeSource: 'automatic',
    minimumSignalCount: row.minimum_signal_count,
    maximumSourceRecords: row.maximum_source_records,
    cooldownMs: row.cooldown_ms,
    trafficPercent: row.traffic_percent,
    canaryMaxOutcomes: row.canary_max_outcomes,
    canaryMaxAgeMs: row.canary_max_age_ms,
    rollbackPolicy: parseEvolutionAutoJson(row.rollback_policy_json, {}),
    configRevision: row.config_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function evolutionAutoRunView(row) {
  return {
    id: row.id,
    configRevision: row.config_revision,
    evidenceFingerprint: row.evidence_fingerprint,
    datasetFingerprint: row.dataset_fingerprint,
    sourceRecordIds: parseEvolutionAutoJson(row.source_record_ids_json, []),
    sourceEvidenceIds: parseEvolutionAutoJson(row.source_evidence_ids_json, []),
    sessionIds: parseEvolutionAutoJson(row.session_ids_json, []),
    signalCount: row.signal_count,
    signalCutoffAt: row.signal_cutoff_at,
    state: row.state,
    stage: row.stage,
    candidateId: row.candidate_id || null,
    replaySuiteId: row.replay_suite_id || null,
    replayId: row.replay_id || null,
    evaluationId: row.evaluation_id || null,
    approvalId: row.approval_id || null,
    canaryId: row.canary_id || null,
    promotionId: row.promotion_id || null,
    verdict: row.verdict || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null,
  }
}

export function evolutionAutoModelInput(input, key, existing) {
  const nested = input?.[key] && typeof input[key] === 'object' ? input[key] : {}
  const prefix = key === 'generator' ? 'generator' : key
  return {
    providerId: String(
      nested.providerId ?? input?.[`${prefix}ProviderId`] ?? existing?.[`${prefix}_provider_id`] ?? '',
    ).trim(),
    modelName: String(
      nested.modelName ?? input?.[`${prefix}Model`] ?? existing?.[`${prefix}_model`] ?? '',
    ).trim(),
  }
}

export async function resolveEvolutionAutoSessionIds({
  userId,
  sourceEvidenceIds = [],
  readSession = null,
}) {
  const db = getDb()
  const relatedFeedbackIds = sourceEvidenceIds
    .filter((id) => String(id).startsWith('feedback:'))
    .map((id) => String(id).slice('feedback:'.length))
  const related = relatedFeedbackIds.length
    ? db.prepare(`
      SELECT DISTINCT session_id FROM evolution_feedback
      WHERE user_id = ? AND id IN (${relatedFeedbackIds.map(() => '?').join(', ')})
        AND session_id IS NOT NULL
      ORDER BY created_at DESC
    `).all(userId, ...relatedFeedbackIds).map((row) => row.session_id)
    : []
  const recent = db.prepare(`
    SELECT session.token AS session_id, MAX(message.created_at) AS last_message_at
    FROM sessions AS session
    JOIN messages AS message
      ON message.session_id = session.token AND message.user_id = session.user_id
    WHERE session.user_id = ?
      AND (session.id IS NOT NULL OR session.title IS NOT NULL)
      AND session.archived_at IS NULL
    GROUP BY session.token
    HAVING SUM(CASE WHEN message.role = 'user' THEN 1 ELSE 0 END) > 0
    ORDER BY last_message_at DESC, session.token ASC
    LIMIT 20
  `).all(userId).map((row) => row.session_id)
  const candidates = [...new Set([...related, ...recent])].slice(0, 20)
  const resolved = []
  for (const sessionId of candidates) {
    if (typeof readSession === 'function') {
      let session
      try { session = await readSession({ userId, sessionId }) } catch (error) {
        throw evolutionAutoServiceError(
          'EVOLUTION_AUTO_SESSION_STORE_UNAVAILABLE',
          sanitizeEvolutionText(error?.message || 'the active Turn session store is unavailable'),
          503,
        )
      }
      if (!session) continue
    }
    resolved.push(sessionId)
    if (resolved.length === 10) break
  }
  return resolved.sort()
}

export function getEvolutionAutoConfig({ userId } = {}) {
  return configView(getEvolutionAutoConfigRow(requireEvolutionAutoOwner(userId)))
}

export function getEvolutionAutoRun({ userId, id } = {}) {
  const owner = requireEvolutionAutoOwner(userId)
  const row = getDb().prepare(`
    SELECT * FROM evolution_auto_runs WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), owner)
  if (!row) {
    throw evolutionAutoServiceError(
      'EVOLUTION_AUTO_RUN_NOT_FOUND',
      'automatic evolution run was not found',
      404,
    )
  }
  return evolutionAutoRunView(row)
}

export function listEvolutionAutoRuns({ userId, limit } = {}) {
  const owner = requireEvolutionAutoOwner(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_auto_runs WHERE user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(owner, limitValue(limit)).map(evolutionAutoRunView)
}
