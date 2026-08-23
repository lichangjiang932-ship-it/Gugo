import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { getEvolutionCandidate } from './evolutionCandidateService.js'
import {
  EVOLUTION_CONFIG_POLICY_VERSION,
  configPatchChanges,
  configSha256,
  normalizeEvolutionConfigPatch,
  stableConfigJson,
} from './evolutionConfigPolicy.js'
import {
  lockedEvolutionConfigKeys,
  proposedEvolutionRuntimeState,
  readEvolutionRuntimeState,
} from './evolutionConfigRuntime.js'

const MAX_LIMIT = 100
const CONFIG_EVALUATION_POLICY_VERSION = 'runtime-config-evaluation-v1'

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

function replayView(row, { includeReport = false } = {}) {
  return {
    id: row.id,
    state: 'completed',
    candidateId: row.candidate_id,
    baselineDocumentSha256: row.baseline_document_sha256,
    proposedDocumentSha256: row.proposed_document_sha256,
    baselineEffectiveSha256: row.baseline_effective_sha256,
    proposedEffectiveSha256: row.proposed_effective_sha256,
    isolationMode: row.isolation_mode,
    runFingerprint: row.run_fingerprint,
    createdAt: row.created_at,
    ...(includeReport ? { report: parseJson(row.report_json, {}) } : {}),
  }
}

function evaluationView(row, { includeDetails = false } = {}) {
  return {
    id: row.id,
    replayId: row.replay_id,
    candidateId: row.candidate_id,
    evaluator: { mode: 'deterministic_policy', independent: true },
    policyVersion: row.policy_version,
    verdict: row.verdict,
    summary: row.summary,
    evaluationFingerprint: row.evaluation_fingerprint,
    createdAt: row.created_at,
    ...(includeDetails ? {
      issues: parseJson(row.issues_json, []),
      metrics: parseJson(row.metrics_json, {}),
    } : {}),
  }
}

export function runEvolutionConfigReplay({
  userId,
  candidateId,
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const candidate = getEvolutionCandidate({ userId: owner, id: candidateId })
  if (candidate.kind !== 'config' || candidate.target !== 'config:runtime') {
    throw serviceError(
      'EVOLUTION_CONFIG_CANDIDATE_UNSUPPORTED',
      'only config:runtime candidates use deterministic config replay',
      409,
    )
  }
  const patch = normalizeEvolutionConfigPatch(candidate.content)
  const state = readEvolutionRuntimeState({ cwd, env, hostEnv })
  const proposed = proposedEvolutionRuntimeState(state, patch)
  const keys = Object.keys(patch.env)
  const locked = lockedEvolutionConfigKeys(state, keys)
  const changes = configPatchChanges(state.effective, proposed.effective, patch, locked)
  const issues = [
    ...locked.map((entry) => `locked_key:${entry.key}`),
    ...(candidate.permissionsRequested.length > 0 ? ['permission_change_unsupported'] : []),
    ...(changes.some((change) => change.changed) ? [] : ['no_effective_change']),
  ]
  const report = Object.freeze({
    schemaVersion: 1,
    policyVersion: EVOLUTION_CONFIG_POLICY_VERSION,
    candidateContentSha256: candidate.contentSha256,
    touchedKeys: Object.freeze([...keys].sort()),
    changes,
    locked,
    issues: Object.freeze(issues),
    sideEffects: Object.freeze({ fileWrites: 0, pluginCalls: 0, modelCalls: 0 }),
  })
  const baselineEffectiveSha256 = configSha256(state.effective)
  const proposedEffectiveSha256 = configSha256(proposed.effective)
  const runFingerprint = configSha256({
    policyVersion: EVOLUTION_CONFIG_POLICY_VERSION,
    candidateContentSha256: candidate.contentSha256,
    baselineDocumentSha256: state.documentSha256,
    proposedDocumentSha256: proposed.documentSha256,
    baselineEffectiveSha256,
    proposedEffectiveSha256,
    report,
    isolationMode: 'config_parse_no_side_effects',
  })
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO evolution_config_replays (
      id, user_id, candidate_id, baseline_document_json, proposed_document_json,
      baseline_document_sha256, proposed_document_sha256,
      baseline_effective_sha256, proposed_effective_sha256,
      isolation_mode, report_json, run_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'config_parse_no_side_effects', ?, ?, ?)
  `).run(
    id,
    owner,
    candidate.id,
    state.rawContent,
    proposed.content,
    state.documentSha256,
    proposed.documentSha256,
    baselineEffectiveSha256,
    proposedEffectiveSha256,
    stableConfigJson(report),
    runFingerprint,
    timestamp(now),
  )
  return getEvolutionConfigReplay({ userId: owner, id })
}

export function getEvolutionConfigReplay({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(
    'SELECT * FROM evolution_config_replays WHERE id = ? AND user_id = ?',
  ).get(String(id || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CONFIG_REPLAY_NOT_FOUND', 'config replay was not found', 404)
  return replayView(row, { includeReport: true })
}

export function listEvolutionConfigReplays({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_config_replays WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => replayView(row))
}

export function evaluateEvolutionConfigReplay({ userId, replayId, now = Date.now() } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(
    'SELECT * FROM evolution_config_replays WHERE id = ? AND user_id = ?',
  ).get(String(replayId || '').trim(), owner)
  if (!row) throw serviceError('EVOLUTION_CONFIG_REPLAY_NOT_FOUND', 'config replay was not found', 404)
  const existing = getDb().prepare(
    'SELECT * FROM evolution_config_evaluations WHERE user_id = ? AND replay_id = ?',
  ).get(owner, row.id)
  if (existing) return evaluationView(existing, { includeDetails: true })
  const candidate = getEvolutionCandidate({ userId: owner, id: row.candidate_id })
  const report = parseJson(row.report_json, {})
  const issues = [...new Set([
    ...(Array.isArray(report.issues) ? report.issues : ['replay_report_invalid']),
    ...(candidate.contentSha256 === report.candidateContentSha256 ? [] : ['candidate_hash_mismatch']),
    ...(candidate.permissionsRequested.length > 0 ? ['permission_change_unsupported'] : []),
    ...(row.isolation_mode === 'config_parse_no_side_effects' ? [] : ['replay_isolation_invalid']),
  ])].sort()
  const changedKeys = Array.isArray(report.changes)
    ? report.changes.filter((change) => change?.changed === true).length
    : 0
  const metrics = Object.freeze({
    touchedKeys: Array.isArray(report.touchedKeys) ? report.touchedKeys.length : 0,
    changedKeys,
    lockedKeys: Array.isArray(report.locked) ? report.locked.length : 0,
    permissionChanges: candidate.permissionsRequested.length,
  })
  const verdict = issues.length === 0 && changedKeys > 0 ? 'pass' : 'fail'
  const summary = verdict === 'pass'
    ? `Deterministic config policy accepted ${changedKeys} effective change(s).`
    : `Deterministic config policy rejected the candidate with ${issues.length} issue(s).`
  const evaluationFingerprint = configSha256({
    policyVersion: CONFIG_EVALUATION_POLICY_VERSION,
    runFingerprint: row.run_fingerprint,
    candidateContentSha256: candidate.contentSha256,
    verdict,
    issues,
    metrics,
  })
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO evolution_config_evaluations (
      id, user_id, replay_id, candidate_id, policy_version, verdict,
      summary, issues_json, metrics_json, evaluation_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    owner,
    row.id,
    candidate.id,
    CONFIG_EVALUATION_POLICY_VERSION,
    verdict,
    summary,
    JSON.stringify(issues),
    JSON.stringify(metrics),
    evaluationFingerprint,
    timestamp(now),
  )
  return getEvolutionConfigEvaluation({ userId: owner, id })
}

export function getEvolutionConfigEvaluation({ userId, id } = {}) {
  const owner = ownerId(userId)
  const row = getDb().prepare(
    'SELECT * FROM evolution_config_evaluations WHERE id = ? AND user_id = ?',
  ).get(String(id || '').trim(), owner)
  if (!row) {
    throw serviceError('EVOLUTION_CONFIG_EVALUATION_NOT_FOUND', 'config evaluation was not found', 404)
  }
  return evaluationView(row, { includeDetails: true })
}

export function listEvolutionConfigEvaluations({ userId, limit } = {}) {
  const owner = ownerId(userId)
  return getDb().prepare(`
    SELECT * FROM evolution_config_evaluations WHERE user_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, limitValue(limit)).map((row) => evaluationView(row))
}

export { CONFIG_EVALUATION_POLICY_VERSION }
