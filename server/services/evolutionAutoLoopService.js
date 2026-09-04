import { getDb } from '../db.js'
import { resolveEvolutionModelIdentity } from './evolutionModelRuntime.js'
import {
  boundedEvolutionAutoInteger as boundedInteger,
  boundedEvolutionAutoNumber as boundedNumber,
  boundedEvolutionAutoText as boundedText,
  DEFAULT_AUTO_EVOLUTION_OBJECTIVE as DEFAULT_OBJECTIVE,
  DEFAULT_AUTO_ROLLBACK_POLICY as DEFAULT_ROLLBACK_POLICY,
  evolutionAutoModelInput as modelInput,
  evolutionAutoServiceError as serviceError,
  getEvolutionAutoConfig,
  getEvolutionAutoConfigRow as configRow,
  normalizeEvolutionAutoTimestamp as timestamp,
  parseEvolutionAutoJson as parseJson,
  requireEvolutionAutoOwner as ownerId,
  resolveEvolutionAutoSessionIds as resolveAutomaticSessionIds,
  SUPPORTED_AUTO_EVOLUTION_TARGET as SUPPORTED_TARGET,
} from './evolutionAutoLoopShared.js'

export {
  getEvolutionAutoConfig,
  getEvolutionAutoRun,
  listEvolutionAutoRuns,
} from './evolutionAutoLoopShared.js'
export {
  monitorEvolutionAutoRun,
  runQueuedEvolutionAutoRun,
  scanEvolutionAutoLoops,
} from './evolutionAutoLoopPipeline.js'

function normalizeRollbackPolicy(value, existing) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : parseJson(existing?.rollback_policy_json, DEFAULT_ROLLBACK_POLICY)
  const result = {
    windowSize: boundedInteger(
      source.windowSize,
      'rollbackPolicy.windowSize',
      3,
      200,
      DEFAULT_ROLLBACK_POLICY.windowSize,
    ),
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

function resolveAutoLoopModels({ input, existing, owner }) {
  const requested = {
    generator: modelInput(input, 'generator', existing),
    replay: modelInput(input, 'replay', existing),
    evaluator: modelInput(input, 'evaluator', existing),
  }
  for (const [label, selection] of Object.entries(requested)) {
    if (!selection.providerId || !selection.modelName) {
      throw serviceError('EVOLUTION_AUTO_CONFIG_INVALID', `${label} Provider and model are required`)
    }
  }
  const generator = resolveEvolutionModelIdentity({ userId: owner, ...requested.generator })
  const replay = resolveEvolutionModelIdentity({ userId: owner, ...requested.replay })
  const evaluator = resolveEvolutionModelIdentity({ userId: owner, ...requested.evaluator })
  if (replay.providerId === evaluator.providerId && replay.modelName === evaluator.modelName) {
    throw serviceError(
      'EVOLUTION_AUTO_EVALUATOR_NOT_INDEPENDENT',
      'evaluator Provider and model must differ from replay identity',
      409,
    )
  }
  return { generator, replay, evaluator }
}

function resolveAutoLoopLimits(input, existing) {
  return {
    minimumSignalCount: boundedInteger(
      input.minimumSignalCount, 'minimumSignalCount', 1, 50, existing?.minimum_signal_count ?? 3,
    ),
    maximumSourceRecords: boundedInteger(
      input.maximumSourceRecords, 'maximumSourceRecords', 1, 10, existing?.maximum_source_records ?? 10,
    ),
    cooldownMs: boundedInteger(
      input.cooldownMs, 'cooldownMs', 60_000, 2_592_000_000, existing?.cooldown_ms ?? 86_400_000,
    ),
    trafficPercent: boundedInteger(
      input.trafficPercent, 'trafficPercent', 1, 10, existing?.traffic_percent ?? 5,
    ),
    canaryMaxOutcomes: boundedInteger(
      input.canaryMaxOutcomes, 'canaryMaxOutcomes', 6, 200, existing?.canary_max_outcomes ?? 20,
    ),
    canaryMaxAgeMs: boundedInteger(
      input.canaryMaxAgeMs, 'canaryMaxAgeMs', 300_000, 2_592_000_000,
      existing?.canary_max_age_ms ?? 604_800_000,
    ),
    rollbackPolicy: normalizeRollbackPolicy(input.rollbackPolicy, existing),
  }
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
  const { generator, replay, evaluator } = resolveAutoLoopModels({ input, existing, owner })
  const sessionIds = await resolveAutomaticSessionIds({ userId: owner, readSession })
  if (!sessionIds.length) {
    throw serviceError(
      'EVOLUTION_AUTO_SESSION_SCOPE_UNAVAILABLE',
      'at least one recent chat with a user message is required for a bounded canary',
      409,
    )
  }
  const {
    minimumSignalCount,
    maximumSourceRecords,
    cooldownMs,
    trafficPercent,
    canaryMaxOutcomes,
    canaryMaxAgeMs,
    rollbackPolicy,
  } = resolveAutoLoopLimits(input, existing)
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
