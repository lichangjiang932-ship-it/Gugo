import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { decideEvolutionAutomaticApproval } from './evolutionApprovalService.js'
import { generateEvolutionCandidate } from './evolutionCandidateService.js'
import { createEvolutionCanary, getEvolutionCanary, startEvolutionCanary, stopEvolutionCanary } from './evolutionCanaryService.js'
import { buildEvolutionDataset, sanitizeEvolutionText } from './evolutionDatasetService.js'
import { evaluateEvolutionReplay } from './evolutionEvaluationService.js'
import { resolveEvolutionModelIdentity } from './evolutionModelRuntime.js'
import { createEvolutionCanaryGraderPolicy, getEvolutionCanaryOnlineGradeState } from './evolutionOnlineGraderService.js'
import { createEvolutionAutomaticPromotion } from './evolutionPromotionService.js'
import { createEvolutionReplaySuite, runEvolutionReplay } from './evolutionReplayService.js'
import { createEvolutionCanaryRollbackPolicy } from './evolutionRollbackService.js'
import {
  DEFAULT_AUTO_ROLLBACK_POLICY as DEFAULT_ROLLBACK_POLICY,
  evolutionAutoRunView as runView,
  evolutionAutoServiceError as serviceError,
  evolutionAutoSha256 as sha256,
  getEvolutionAutoConfigRow as configRow,
  getEvolutionAutoRun,
  normalizeEvolutionAutoTimestamp as timestamp,
  parseEvolutionAutoJson as parseJson,
  requireEvolutionAutoOwner as ownerId,
  resolveEvolutionAutoSessionIds as resolveAutomaticSessionIds,
  stableEvolutionAutoJson as stableJson,
  SUPPORTED_AUTO_EVOLUTION_TARGET as SUPPORTED_TARGET,
} from './evolutionAutoLoopShared.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

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
