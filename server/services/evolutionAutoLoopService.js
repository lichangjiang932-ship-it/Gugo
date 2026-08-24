import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { decideEvolutionAutomaticApproval } from './evolutionApprovalService.js'
import { generateEvolutionCandidate } from './evolutionCandidateService.js'
import {
  createEvolutionCanary,
  getEvolutionCanary,
  startEvolutionCanary,
  stopEvolutionCanary,
} from './evolutionCanaryService.js'
import { buildEvolutionDataset, sanitizeEvolutionText } from './evolutionDatasetService.js'
import { evaluateEvolutionReplay } from './evolutionEvaluationService.js'
import { resolveEvolutionModelIdentity } from './evolutionModelRuntime.js'
import {
  createEvolutionCanaryGraderPolicy,
  getEvolutionCanaryOnlineGradeState,
} from './evolutionOnlineGraderService.js'
import { createEvolutionAutomaticPromotion } from './evolutionPromotionService.js'
import {
  createEvolutionReplaySuite,
  runEvolutionReplay,
} from './evolutionReplayService.js'
import { createEvolutionCanaryRollbackPolicy } from './evolutionRollbackService.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

const SUPPORTED_TARGET = 'prompt:workspace-instructions'
const MAX_LIMIT = 100
const DEFAULT_OBJECTIVE = 'Improve workspace instructions from verified failures and explicit user feedback without adding permissions.'
const DEFAULT_ROLLBACK_POLICY = Object.freeze({
  windowSize: 10,
  minimumCandidateOutcomes: 3,
  minimumBaselineOutcomes: 3,
  maximumCandidateFailureRate: 0,
  maximumCandidateCancellationRate: 0.1,
  maximumLatencyRatio: 1.5,
})

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

function boundedText(value, label, maximum = 2_000, fallback = '') {
  const text = String(value ?? fallback).trim()
  if (!text || text.length > maximum) {
    throw serviceError('EVOLUTION_AUTO_CONFIG_INVALID', `${label} must contain between 1 and ${maximum} characters`)
  }
  return sanitizeEvolutionText(text)
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  const number = value == null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw serviceError('EVOLUTION_AUTO_CONFIG_INVALID', `${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return number
}

function boundedNumber(value, label, minimum, maximum, fallback) {
  const number = value == null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw serviceError('EVOLUTION_AUTO_CONFIG_INVALID', `${label} must be between ${minimum} and ${maximum}`)
  }
  return number
}

function limitValue(value) {
  if (value == null || value === '') return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_AUTO_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function configRow(userId) {
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
    resolvedSessionIds: parseJson(row.session_ids_json, []),
    sessionScopeSource: 'automatic',
    minimumSignalCount: row.minimum_signal_count,
    maximumSourceRecords: row.maximum_source_records,
    cooldownMs: row.cooldown_ms,
    trafficPercent: row.traffic_percent,
    canaryMaxOutcomes: row.canary_max_outcomes,
    canaryMaxAgeMs: row.canary_max_age_ms,
    rollbackPolicy: parseJson(row.rollback_policy_json, {}),
    configRevision: row.config_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function runView(row) {
  return {
    id: row.id,
    configRevision: row.config_revision,
    evidenceFingerprint: row.evidence_fingerprint,
    datasetFingerprint: row.dataset_fingerprint,
    sourceRecordIds: parseJson(row.source_record_ids_json, []),
    sourceEvidenceIds: parseJson(row.source_evidence_ids_json, []),
    sessionIds: parseJson(row.session_ids_json, []),
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

function modelInput(input, key, existing) {
  const nested = input?.[key] && typeof input[key] === 'object' ? input[key] : {}
  const prefix = key === 'generator' ? 'generator' : key
  return {
    providerId: String(nested.providerId ?? input?.[`${prefix}ProviderId`] ?? existing?.[`${prefix}_provider_id`] ?? '').trim(),
    modelName: String(nested.modelName ?? input?.[`${prefix}Model`] ?? existing?.[`${prefix}_model`] ?? '').trim(),
  }
}

function normalizeRollbackPolicy(value, existing) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : parseJson(existing?.rollback_policy_json, DEFAULT_ROLLBACK_POLICY)
  const result = {
    windowSize: boundedInteger(source.windowSize, 'rollbackPolicy.windowSize', 3, 200, DEFAULT_ROLLBACK_POLICY.windowSize),
    minimumCandidateOutcomes: boundedInteger(
      source.minimumCandidateOutcomes,
      'rollbackPolicy.minimumCandidateOutcomes',
      3,
      100,
      DEFAULT_ROLLBACK_POLICY.minimumCandidateOutcomes,
    ),
    minimumBaselineOutcomes: boundedInteger(
      source.minimumBaselineOutcomes,
      'rollbackPolicy.minimumBaselineOutcomes',
      3,
      100,
      DEFAULT_ROLLBACK_POLICY.minimumBaselineOutcomes,
    ),
    maximumCandidateFailureRate: boundedNumber(
      source.maximumCandidateFailureRate,
      'rollbackPolicy.maximumCandidateFailureRate',
      0,
      1,
      DEFAULT_ROLLBACK_POLICY.maximumCandidateFailureRate,
    ),
    maximumCandidateCancellationRate: boundedNumber(
      source.maximumCandidateCancellationRate,
      'rollbackPolicy.maximumCandidateCancellationRate',
      0,
      1,
      DEFAULT_ROLLBACK_POLICY.maximumCandidateCancellationRate,
    ),
    maximumLatencyRatio: boundedNumber(
      source.maximumLatencyRatio,
      'rollbackPolicy.maximumLatencyRatio',
      1,
      10,
      DEFAULT_ROLLBACK_POLICY.maximumLatencyRatio,
    ),
  }
  if (result.minimumCandidateOutcomes > result.windowSize
    || result.minimumBaselineOutcomes > result.windowSize) {
    throw serviceError(
      'EVOLUTION_AUTO_CONFIG_INVALID',
      'rollbackPolicy minimum outcome counts cannot exceed windowSize',
    )
  }
  return result
}

async function resolveAutomaticSessionIds({ userId, sourceEvidenceIds = [], readSession = null }) {
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
        throw serviceError(
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

export async function configureEvolutionAutoLoop({
  userId,
  input = {},
  readSession = null,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const updatedAt = timestamp(now)
  const existing = configRow(owner)
  const enabled = input.enabled == null ? existing?.enabled === 1 : input.enabled === true
  if (!enabled && !existing) return null
  if (!enabled) {
    getDb().prepare(`
      UPDATE evolution_auto_configs
      SET enabled = 0, config_revision = config_revision + 1, updated_at = ?
      WHERE user_id = ?
    `).run(updatedAt, owner)
    return getEvolutionAutoConfig({ userId: owner })
  }
  const target = String(input.target || existing?.target || SUPPORTED_TARGET).trim()
  if (target !== SUPPORTED_TARGET) {
    throw serviceError(
      'EVOLUTION_AUTO_TARGET_UNSUPPORTED',
      `automatic evolution is restricted to ${SUPPORTED_TARGET}`,
      409,
    )
  }
  const objective = boundedText(
    input.objective,
    'objective',
    2_000,
    existing?.objective || DEFAULT_OBJECTIVE,
  )
  const requestedGenerator = modelInput(input, 'generator', existing)
  const requestedReplay = modelInput(input, 'replay', existing)
  const requestedEvaluator = modelInput(input, 'evaluator', existing)
  for (const [label, selection] of Object.entries({
    generator: requestedGenerator,
    replay: requestedReplay,
    evaluator: requestedEvaluator,
  })) {
    if (!selection.providerId || !selection.modelName) {
      throw serviceError('EVOLUTION_AUTO_CONFIG_INVALID', `${label} Provider and model are required`)
    }
  }
  const generator = resolveEvolutionModelIdentity({ userId: owner, ...requestedGenerator })
  const replay = resolveEvolutionModelIdentity({ userId: owner, ...requestedReplay })
  const evaluator = resolveEvolutionModelIdentity({ userId: owner, ...requestedEvaluator })
  if (replay.providerId === evaluator.providerId && replay.modelName === evaluator.modelName) {
    throw serviceError(
      'EVOLUTION_AUTO_EVALUATOR_NOT_INDEPENDENT',
      'evaluator Provider and model must differ from replay identity',
      409,
    )
  }
  const sessionIds = await resolveAutomaticSessionIds({ userId: owner, readSession })
  if (!sessionIds.length) {
    throw serviceError(
      'EVOLUTION_AUTO_SESSION_SCOPE_UNAVAILABLE',
      'at least one recent chat with a user message is required for a bounded canary',
      409,
    )
  }
  const minimumSignalCount = boundedInteger(
    input.minimumSignalCount,
    'minimumSignalCount',
    1,
    50,
    existing?.minimum_signal_count ?? 3,
  )
  const maximumSourceRecords = boundedInteger(
    input.maximumSourceRecords,
    'maximumSourceRecords',
    1,
    10,
    existing?.maximum_source_records ?? 10,
  )
  const cooldownMs = boundedInteger(
    input.cooldownMs,
    'cooldownMs',
    60_000,
    2_592_000_000,
    existing?.cooldown_ms ?? 86_400_000,
  )
  const trafficPercent = boundedInteger(
    input.trafficPercent,
    'trafficPercent',
    1,
    10,
    existing?.traffic_percent ?? 5,
  )
  const canaryMaxOutcomes = boundedInteger(
    input.canaryMaxOutcomes,
    'canaryMaxOutcomes',
    6,
    200,
    existing?.canary_max_outcomes ?? 20,
  )
  const canaryMaxAgeMs = boundedInteger(
    input.canaryMaxAgeMs,
    'canaryMaxAgeMs',
    300_000,
    2_592_000_000,
    existing?.canary_max_age_ms ?? 604_800_000,
  )
  const rollbackPolicy = normalizeRollbackPolicy(input.rollbackPolicy, existing)
  const revision = (existing?.config_revision || 0) + 1
  const createdAt = existing?.created_at ?? updatedAt
  getDb().prepare(`
    INSERT INTO evolution_auto_configs (
      user_id, enabled, target, objective,
      generator_provider_id, generator_model,
      replay_provider_id, replay_model,
      evaluator_provider_id, evaluator_model,
      session_ids_json, minimum_signal_count, maximum_source_records,
      cooldown_ms, traffic_percent, canary_max_outcomes, canary_max_age_ms,
      rollback_policy_json, config_revision, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = 1,
      target = excluded.target,
      objective = excluded.objective,
      generator_provider_id = excluded.generator_provider_id,
      generator_model = excluded.generator_model,
      replay_provider_id = excluded.replay_provider_id,
      replay_model = excluded.replay_model,
      evaluator_provider_id = excluded.evaluator_provider_id,
      evaluator_model = excluded.evaluator_model,
      session_ids_json = excluded.session_ids_json,
      minimum_signal_count = excluded.minimum_signal_count,
      maximum_source_records = excluded.maximum_source_records,
      cooldown_ms = excluded.cooldown_ms,
      traffic_percent = excluded.traffic_percent,
      canary_max_outcomes = excluded.canary_max_outcomes,
      canary_max_age_ms = excluded.canary_max_age_ms,
      rollback_policy_json = excluded.rollback_policy_json,
      config_revision = excluded.config_revision,
      updated_at = excluded.updated_at
  `).run(
    owner,
    target,
    objective,
    generator.providerId,
    generator.modelName,
    replay.providerId,
    replay.modelName,
    evaluator.providerId,
    evaluator.modelName,
    JSON.stringify(sessionIds),
    minimumSignalCount,
    maximumSourceRecords,
    cooldownMs,
    trafficPercent,
    canaryMaxOutcomes,
    canaryMaxAgeMs,
    JSON.stringify(rollbackPolicy),
    revision,
    createdAt,
    updatedAt,
  )
  return getEvolutionAutoConfig({ userId: owner })
}

export function getEvolutionAutoConfig({ userId } = {}) {
  return configView(configRow(ownerId(userId)))
}

export function getEvolutionAutoRun({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(`
    SELECT * FROM evolution_auto_runs WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_AUTO_RUN_NOT_FOUND', 'automatic evolution run was not found', 404)
  return runView(row)
}

export function listEvolutionAutoRuns({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_auto_runs WHERE user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?
  `).all(owner, limitValue(limit)).map(runView)
}

function negativeRecord(record) {
  return record?.signal === 'blocked'
    || record?.signal === 'fixable'
    || record?.signal === 'explicit_feedback'
}

function usedEvidenceIds(userId) {
  const used = new Set()
  for (const row of getDb().prepare(`
    SELECT source_evidence_ids_json FROM evolution_auto_runs WHERE user_id = ?
  `).all(userId)) {
    for (const id of parseJson(row.source_evidence_ids_json, [])) used.add(String(id))
  }
  return used
}

function selectNewSignals(userId, config, dataset) {
  const used = usedEvidenceIds(userId)
  const selected = dataset.records
    .filter(negativeRecord)
    .map((record) => ({
      record,
      newEvidenceIds: record.evidenceIds.filter((id) => !used.has(id)),
    }))
    .filter((entry) => entry.newEvidenceIds.length > 0)
    .sort((left, right) => (
      right.record.lastSeenAt - left.record.lastSeenAt
      || left.record.id.localeCompare(right.record.id)
    ))
    .slice(0, config.maximum_source_records)
  const signalCount = selected.reduce((count, entry) => count + entry.newEvidenceIds.length, 0)
  if (signalCount < config.minimum_signal_count) return null
  const sourceRecordIds = selected.map((entry) => entry.record.id).sort()
  const sourceEvidenceIds = selected.flatMap((entry) => entry.newEvidenceIds).sort()
  const signalCutoffAt = Math.max(...selected.map((entry) => entry.record.lastSeenAt))
  const evidenceFingerprint = sha256(selected.map((entry) => ({
    recordId: entry.record.id,
    contentFingerprint: entry.record.contentFingerprint,
    evidenceIds: [...entry.newEvidenceIds].sort(),
  })))
  return { selected, sourceRecordIds, sourceEvidenceIds, signalCount, signalCutoffAt, evidenceFingerprint }
}

async function queueEvolutionAutoRun({ userId, config, readSession, now }) {
  const db = getDb()
  if (db.prepare(`
    SELECT 1 FROM evolution_auto_runs
    WHERE user_id = ? AND state IN ('queued', 'running', 'canary_active', 'validated')
  `).get(userId)) return null
  if (db.prepare(`
    SELECT 1 FROM evolution_active_promotions
    WHERE user_id = ? AND target = ?
  `).get(userId, SUPPORTED_TARGET)) return null
  const latest = db.prepare(`
    SELECT created_at FROM evolution_auto_runs
    WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(userId)
  if (latest && now - latest.created_at < config.cooldown_ms) return null
  const dataset = buildEvolutionDataset({ userId, limit: 200 })
  const selection = selectNewSignals(userId, config, dataset)
  if (!selection) return null
  const sessionIds = await resolveAutomaticSessionIds({
    userId,
    sourceEvidenceIds: selection.sourceEvidenceIds,
    readSession,
  })
  if (!sessionIds.length) return null
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO evolution_auto_runs (
        id, user_id, config_revision, evidence_fingerprint, dataset_fingerprint,
        source_record_ids_json, source_evidence_ids_json, session_ids_json,
        signal_count, signal_cutoff_at, state, stage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)
    `).run(
      id,
      userId,
      config.config_revision,
      selection.evidenceFingerprint,
      dataset.datasetFingerprint,
      JSON.stringify(selection.sourceRecordIds),
      JSON.stringify(selection.sourceEvidenceIds),
      JSON.stringify(sessionIds),
      selection.signalCount,
      selection.signalCutoffAt,
      now,
      now,
    )
  } catch (error) {
    if (/UNIQUE constraint failed/iu.test(String(error?.message || ''))) return null
    throw error
  }
  return db.prepare('SELECT * FROM evolution_auto_runs WHERE id = ?').get(id)
}

function updateRunningStage({ id, userId, stage, now, fields = {} }) {
  const allowed = new Map([
    ['candidate_id', fields.candidateId],
    ['replay_suite_id', fields.replaySuiteId],
    ['replay_id', fields.replayId],
    ['evaluation_id', fields.evaluationId],
    ['approval_id', fields.approvalId],
    ['canary_id', fields.canaryId],
    ['verdict', fields.verdict],
  ].filter(([, value]) => value != null))
  const assignments = [...allowed.keys()].map((key) => `${key} = ?`)
  const result = getDb().prepare(`
    UPDATE evolution_auto_runs
    SET stage = ?, updated_at = ?${assignments.length ? `, ${assignments.join(', ')}` : ''}
    WHERE id = ? AND user_id = ? AND state = 'running'
  `).run(stage, now, ...allowed.values(), id, userId)
  if (result.changes !== 1) {
    throw serviceError('EVOLUTION_AUTO_RUN_FENCE_LOST', 'automatic evolution run changed during execution', 409)
  }
}

function terminalRun({ id, userId, state, stage, now, verdict = null, error = null }) {
  const safeCode = error
    ? String(error.code || 'EVOLUTION_AUTO_RUN_FAILED').replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 160)
    : null
  const safeMessage = error
    ? sanitizeEvolutionText(error.statusCode && error.statusCode < 500
      ? error.message
      : 'automatic evolution failed closed').slice(0, 2_000)
    : null
  getDb().prepare(`
    UPDATE evolution_auto_runs
    SET state = ?, stage = ?, verdict = COALESCE(?, verdict),
      error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
    WHERE id = ? AND user_id = ? AND state IN ('queued', 'running', 'canary_active', 'validated')
  `).run(state, stage, verdict, safeCode, safeMessage, now, now, id, userId)
}

function replayCases(dataset, sourceRecordIds) {
  const byId = new Map(dataset.records.map((record) => [record.id, record]))
  return sourceRecordIds.map((id, index) => {
    const record = byId.get(id)
    if (!record) throw serviceError('EVOLUTION_DATASET_STALE', 'automatic replay evidence changed', 409)
    return {
      sourceRecordId: record.id,
      title: `Failure replay ${index + 1}: ${record.cluster}`.slice(0, 160),
      input: [
        'Reproduce a helpful response for this sanitized failure signal.',
        stableJson({ source: record.source, signal: record.signal, cluster: record.cluster, payload: record.payload }),
      ].join('\n').slice(0, 4_000),
    }
  })
}

const DEFAULT_SERVICES = Object.freeze({
  generateEvolutionCandidate,
  createEvolutionReplaySuite,
  runEvolutionReplay,
  evaluateEvolutionReplay,
  decideEvolutionAutomaticApproval,
  createEvolutionCanary,
  createEvolutionCanaryRollbackPolicy,
  createEvolutionCanaryGraderPolicy,
  startEvolutionCanary,
  stopEvolutionCanary,
  getEvolutionCanary,
  getEvolutionCanaryOnlineGradeState,
  createEvolutionAutomaticPromotion,
})

async function stopCanaryIfActive({ services, userId, canaryId, reason, now }) {
  if (!canaryId) return null
  const canary = services.getEvolutionCanary({ userId, id: canaryId })
  if (canary.state !== 'active') return canary
  return services.stopEvolutionCanary({ userId, id: canaryId, reason, now })
}

export async function runQueuedEvolutionAutoRun({
  userId,
  runId,
  readSession = null,
  env = process.env,
  now = Date.now(),
  signal,
  services: overrides = {},
} = {}) {
  const owner = ownerId(userId)
  const startedAt = timestamp(now)
  const services = { ...DEFAULT_SERVICES, ...overrides }
  const claimed = getDb().prepare(`
    UPDATE evolution_auto_runs
    SET state = 'running', stage = 'candidate_generation', updated_at = ?
    WHERE id = ? AND user_id = ? AND state = 'queued'
  `).run(startedAt, String(runId || '').trim(), owner)
  if (claimed.changes !== 1) return getEvolutionAutoRun({ userId: owner, id: runId })
  let row = getDb().prepare('SELECT * FROM evolution_auto_runs WHERE id = ? AND user_id = ?').get(runId, owner)
  const config = configRow(owner)
  if (!config || config.enabled !== 1 || config.config_revision !== row.config_revision) {
    terminalRun({ id: row.id, userId: owner, state: 'stopped', stage: 'config_changed', now: startedAt })
    return getEvolutionAutoRun({ userId: owner, id: row.id })
  }
  try {
    const candidate = await services.generateEvolutionCandidate({
      userId: owner,
      kind: 'prompt',
      target: SUPPORTED_TARGET,
      objective: config.objective,
      datasetFingerprint: row.dataset_fingerprint,
      sourceRecordIds: parseJson(row.source_record_ids_json, []),
      providerId: config.generator_provider_id,
      modelName: config.generator_model,
      idempotencyKey: `auto:${row.id}:candidate`,
      now: startedAt,
      signal,
    })
    if (candidate.kind !== 'prompt' || candidate.target !== SUPPORTED_TARGET
      || candidate.permissionsRequested.length > 0) {
      throw serviceError(
        'EVOLUTION_AUTO_CANDIDATE_UNSAFE',
        'automatic evolution candidate requested an unsupported target or permissions',
        409,
      )
    }
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: 'replay_suite',
      now: Date.now(),
      fields: { candidateId: candidate.id },
    })
    const dataset = buildEvolutionDataset({ userId: owner, limit: 200 })
    if (dataset.datasetFingerprint !== row.dataset_fingerprint) {
      throw serviceError('EVOLUTION_DATASET_STALE', 'automatic evolution dataset changed during execution', 409)
    }
    const suite = services.createEvolutionReplaySuite({
      userId: owner,
      name: `Automatic failure replay ${row.id.slice(0, 8)}`,
      datasetFingerprint: row.dataset_fingerprint,
      cases: replayCases(dataset, parseJson(row.source_record_ids_json, [])),
      now: Date.now(),
    })
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: 'isolated_replay',
      now: Date.now(),
      fields: { replaySuiteId: suite.id },
    })
    const baselineContent = String(readWorkspaceInstructions({ env })?.text || '').trim()
    if (!baselineContent) {
      throw serviceError(
        'EVOLUTION_AUTO_BASELINE_UNAVAILABLE',
        'workspace instructions are required for automatic replay and rollback',
        409,
      )
    }
    const replay = await services.runEvolutionReplay({
      userId: owner,
      suiteId: suite.id,
      candidateId: candidate.id,
      baselineContent,
      providerId: config.replay_provider_id,
      modelName: config.replay_model,
      parameters: { temperature: 0, maxTokens: 1_024 },
      idempotencyKey: `auto:${row.id}:replay`,
      now: Date.now(),
      signal,
    })
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: 'independent_evaluation',
      now: Date.now(),
      fields: { replayId: replay.id },
    })
    const evaluation = await services.evaluateEvolutionReplay({
      userId: owner,
      replayId: replay.id,
      evaluatorProviderId: config.evaluator_provider_id,
      evaluatorModelName: config.evaluator_model,
      idempotencyKey: `auto:${row.id}:evaluation`,
      now: Date.now(),
      signal,
    })
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: evaluation.verdict === 'pass' ? 'automatic_approval' : 'evaluation_rejected',
      now: Date.now(),
      fields: { evaluationId: evaluation.id, verdict: evaluation.verdict },
    })
    if (evaluation.verdict !== 'pass') {
      terminalRun({
        id: row.id,
        userId: owner,
        state: 'rejected',
        stage: 'evaluation_rejected',
        verdict: evaluation.verdict,
        now: Date.now(),
      })
      return getEvolutionAutoRun({ userId: owner, id: row.id })
    }
    const approval = services.decideEvolutionAutomaticApproval({
      userId: owner,
      evaluationId: evaluation.id,
      automationRunId: row.id,
      now: Date.now(),
    })
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: 'canary_creation',
      now: Date.now(),
      fields: { approvalId: approval.id },
    })
    const sessionIds = parseJson(row.session_ids_json, [])
    const canary = await services.createEvolutionCanary({
      userId: owner,
      approvalId: approval.id,
      sessionIds,
      trafficPercent: config.traffic_percent,
      reason: 'Automatic bounded canary after independent replay validation.',
      readSession,
      env,
      now: Date.now(),
    })
    updateRunningStage({
      id: row.id,
      userId: owner,
      stage: 'canary_policy',
      now: Date.now(),
      fields: { canaryId: canary.id },
    })
    services.createEvolutionCanaryRollbackPolicy({
      userId: owner,
      releaseId: canary.id,
      policy: parseJson(config.rollback_policy_json, DEFAULT_ROLLBACK_POLICY),
      reason: 'Immutable automatic rollback policy for an opt-in evolution run.',
      now: Date.now(),
    })
    const evaluatorIdentity = resolveEvolutionModelIdentity({
      userId: owner,
      providerId: config.evaluator_provider_id,
      modelName: config.evaluator_model,
    })
    services.createEvolutionCanaryGraderPolicy({
      userId: owner,
      releaseId: canary.id,
      graderProviderId: evaluatorIdentity.providerId,
      graderModelName: evaluatorIdentity.modelName,
      graderModelRevision: evaluatorIdentity.configRevision
        ? `config:${evaluatorIdentity.configRevision}`
        : `auto-config:${config.config_revision}`,
      policy: {
        minimumQualityScore: 2,
        maximumQualityRegression: 0,
        maximumSafetyFailureRate: 0,
        productionMonitoringEnabled: true,
      },
      reason: 'Independent online grader with production monitoring enabled.',
      now: Date.now(),
    })
    services.startEvolutionCanary({
      userId: owner,
      id: canary.id,
      reason: 'Automatic low-traffic canary started by the explicit opt-in policy.',
      env,
      now: Date.now(),
    })
    const activated = getDb().prepare(`
      UPDATE evolution_auto_runs
      SET state = 'canary_active', stage = 'canary_monitoring', updated_at = ?
      WHERE id = ? AND user_id = ? AND state = 'running' AND canary_id = ?
    `).run(Date.now(), row.id, owner, canary.id)
    if (activated.changes !== 1) {
      throw serviceError('EVOLUTION_AUTO_RUN_FENCE_LOST', 'canary activation fence was lost', 409)
    }
  } catch (error) {
    row = getDb().prepare('SELECT * FROM evolution_auto_runs WHERE id = ? AND user_id = ?').get(runId, owner)
    try {
      await stopCanaryIfActive({
        services,
        userId: owner,
        canaryId: row?.canary_id,
        reason: 'Automatic evolution stopped after a fail-closed pipeline error.',
        now: Date.now(),
      })
    } catch { /* the original failure remains the audit cause */ }
    terminalRun({
      id: runId,
      userId: owner,
      state: 'failed',
      stage: 'pipeline_failed',
      now: Date.now(),
      error,
    })
  }
  return getEvolutionAutoRun({ userId: owner, id: runId })
}

function totalCanaryOutcomes(canary) {
  const totals = canary?.stats?.outcomes || {}
  return ['baseline', 'candidate'].reduce((sum, variant) => (
    sum + ['completed', 'failed', 'cancelled']
      .reduce((count, state) => count + (Number(totals?.[variant]?.[state]) || 0), 0)
  ), 0)
}

function hasNewNegativeSignal(userId, run) {
  const dataset = buildEvolutionDataset({ userId, limit: 200 })
  const frozen = new Set(parseJson(run.source_evidence_ids_json, []))
  return dataset.records.some((record) => negativeRecord(record)
    && record.lastSeenAt > run.signal_cutoff_at
    && record.evidenceIds.some((id) => !frozen.has(id)))
}

export async function monitorEvolutionAutoRun({
  userId,
  runId,
  env = process.env,
  now = Date.now(),
  services: overrides = {},
} = {}) {
  const owner = ownerId(userId)
  const checkedAt = timestamp(now)
  const services = { ...DEFAULT_SERVICES, ...overrides }
  const run = getDb().prepare(`
    SELECT * FROM evolution_auto_runs WHERE id = ? AND user_id = ?
  `).get(String(runId || '').trim(), owner)
  if (!run) throw serviceError('EVOLUTION_AUTO_RUN_NOT_FOUND', 'automatic evolution run was not found', 404)
  if (run.state !== 'canary_active' && run.state !== 'validated') return runView(run)
  const config = configRow(owner)
  const stop = async (stage, error = null) => {
    try {
      await stopCanaryIfActive({
        services,
        userId: owner,
        canaryId: run.canary_id,
        reason: `Automatic evolution stopped: ${stage}.`,
        now: checkedAt,
      })
    } finally {
      terminalRun({
        id: run.id,
        userId: owner,
        state: 'stopped',
        stage,
        now: checkedAt,
        error,
      })
    }
    return getEvolutionAutoRun({ userId: owner, id: run.id })
  }
  if (!config || config.enabled !== 1 || config.config_revision !== run.config_revision) {
    return stop('config_changed')
  }
  const canary = services.getEvolutionCanary({ userId: owner, id: run.canary_id })
  if (canary.state === 'rolled_back') {
    terminalRun({ id: run.id, userId: owner, state: 'rolled_back', stage: 'canary_rollback', now: checkedAt })
    return getEvolutionAutoRun({ userId: owner, id: run.id })
  }
  if (canary.state !== 'active') return stop('canary_not_active')
  if (hasNewNegativeSignal(owner, run)) return stop('new_negative_signal')
  const online = services.getEvolutionCanaryOnlineGradeState({
    userId: owner,
    releaseId: run.canary_id,
    limit: 200,
  })
  if (online.grades.some((grade) => grade.status === 'failed')) {
    return stop(
      'online_grader_failed',
      serviceError('EVOLUTION_AUTO_ONLINE_GRADER_FAILED', 'independent online grader failed', 502),
    )
  }
  const rollback = canary.automaticRollback
  const statisticalGuard = rollback?.evaluations?.[0] || null
  const statisticalContinue = statisticalGuard?.decision === 'continue'
  const onlineContinue = online.guard?.decision === 'continue'
    && online.currentEvidence?.decision === 'continue'
    && online.currentEvidence?.latestEvaluationCurrent === true
    && online.guard?.breaches?.length === 0
    && online.currentEvidence?.blockers?.length === 0
  if (statisticalContinue && onlineContinue) {
    services.stopEvolutionCanary({
      userId: owner,
      id: run.canary_id,
      reason: 'Automatic canary validated by both immutable guards.',
      now: checkedAt,
    })
    services.createEvolutionAutomaticPromotion({
      userId: owner,
      automationRunId: run.id,
      env,
      now: checkedAt,
    })
    return getEvolutionAutoRun({ userId: owner, id: run.id })
  }
  if (totalCanaryOutcomes(canary) >= config.canary_max_outcomes
    || checkedAt - canary.createdAt >= config.canary_max_age_ms) {
    return stop(
      'canary_evidence_timeout',
      serviceError(
        'EVOLUTION_AUTO_CANARY_EVIDENCE_INSUFFICIENT',
        'canary reached its immutable limit before both guards passed',
        409,
      ),
    )
  }
  return runView(run)
}

function failInterruptedRuns(now) {
  getDb().prepare(`
    UPDATE evolution_auto_runs
    SET state = 'failed', stage = 'interrupted_fail_closed',
      error_code = 'EVOLUTION_AUTO_RUN_INTERRUPTED',
      error_message = 'automatic evolution was interrupted before a durable canary boundary',
      updated_at = ?, finished_at = ?
    WHERE state = 'running'
  `).run(now, now)
}

export async function scanEvolutionAutoLoops({
  readSession = null,
  env = process.env,
  now = Date.now(),
  signal,
  services = {},
} = {}) {
  const scannedAt = timestamp(now)
  failInterruptedRuns(scannedAt)
  const configs = getDb().prepare(`
    SELECT * FROM evolution_auto_configs ORDER BY updated_at ASC, user_id ASC
  `).all()
  const results = []
  for (const config of configs) {
    if (signal?.aborted) break
    const active = getDb().prepare(`
      SELECT * FROM evolution_auto_runs
      WHERE user_id = ? AND state IN ('canary_active', 'validated')
      ORDER BY created_at ASC, rowid ASC LIMIT 1
    `).get(config.user_id)
    if (active) {
      results.push(await monitorEvolutionAutoRun({
        userId: config.user_id,
        runId: active.id,
        env,
        now: scannedAt,
        services,
      }))
      continue
    }
    if (config.enabled !== 1) continue
    const queued = getDb().prepare(`
      SELECT * FROM evolution_auto_runs
      WHERE user_id = ? AND state = 'queued'
      ORDER BY created_at ASC, rowid ASC LIMIT 1
    `).get(config.user_id) || await queueEvolutionAutoRun({
      userId: config.user_id,
      config,
      readSession,
      now: scannedAt,
    })
    if (!queued) continue
    results.push(await runQueuedEvolutionAutoRun({
      userId: config.user_id,
      runId: queued.id,
      readSession,
      env,
      now: scannedAt,
      signal,
      services,
    }))
  }
  return { scannedAt, results }
}
