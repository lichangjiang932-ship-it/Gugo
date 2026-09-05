import { getDb } from '../db.js'
import { buildEvolutionDataset } from './evolutionDatasetService.js'
import { resolveEvolutionModelIdentity } from './evolutionModelRuntime.js'
import { evolutionAutoServiceError as serviceError } from './evolutionAutoLoopShared.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

export async function runAutoReplayValidation({
  services,
  owner,
  row,
  config,
  env,
  signal,
  startedAt,
  supportedTarget,
  parseJson,
  createReplayCases,
  updateStage,
}) {
  const candidate = await services.generateEvolutionCandidate({
    userId: owner,
    kind: 'prompt',
    target: supportedTarget,
    objective: config.objective,
    datasetFingerprint: row.dataset_fingerprint,
    sourceRecordIds: parseJson(row.source_record_ids_json, []),
    providerId: config.generator_provider_id,
    modelName: config.generator_model,
    idempotencyKey: `auto:${row.id}:candidate`,
    now: startedAt,
    signal,
  })
  if (candidate.kind !== 'prompt' || candidate.target !== supportedTarget
    || candidate.permissionsRequested.length > 0) {
    throw serviceError(
      'EVOLUTION_AUTO_CANDIDATE_UNSAFE',
      'automatic evolution candidate requested an unsupported target or permissions',
      409,
    )
  }
  updateStage({
    id: row.id, userId: owner, stage: 'replay_suite', now: Date.now(),
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
    cases: createReplayCases(dataset, parseJson(row.source_record_ids_json, [])),
    now: Date.now(),
  })
  updateStage({
    id: row.id, userId: owner, stage: 'isolated_replay', now: Date.now(),
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
  updateStage({
    id: row.id, userId: owner, stage: 'independent_evaluation', now: Date.now(),
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
  updateStage({
    id: row.id,
    userId: owner,
    stage: evaluation.verdict === 'pass' ? 'automatic_approval' : 'evaluation_rejected',
    now: Date.now(),
    fields: { evaluationId: evaluation.id, verdict: evaluation.verdict },
  })
  return evaluation
}

export async function activateAutoCanary({
  services,
  owner,
  row,
  config,
  evaluation,
  readSession,
  env,
  parseJson,
  defaultRollbackPolicy,
  updateStage,
}) {
  const approval = services.decideEvolutionAutomaticApproval({
    userId: owner,
    evaluationId: evaluation.id,
    automationRunId: row.id,
    now: Date.now(),
  })
  updateStage({
    id: row.id, userId: owner, stage: 'canary_creation', now: Date.now(),
    fields: { approvalId: approval.id },
  })
  const canary = await services.createEvolutionCanary({
    userId: owner,
    approvalId: approval.id,
    sessionIds: parseJson(row.session_ids_json, []),
    trafficPercent: config.traffic_percent,
    reason: 'Automatic bounded canary after independent replay validation.',
    readSession,
    env,
    now: Date.now(),
  })
  updateStage({
    id: row.id, userId: owner, stage: 'canary_policy', now: Date.now(),
    fields: { canaryId: canary.id },
  })
  services.createEvolutionCanaryRollbackPolicy({
    userId: owner,
    releaseId: canary.id,
    policy: parseJson(config.rollback_policy_json, defaultRollbackPolicy),
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
  return canary
}
