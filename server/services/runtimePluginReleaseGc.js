import { createHash, randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import { verifyRuntimePluginReleaseContentIdentity } from '../plugins/runtimePluginReleaseIdentity.js'
import { collectRuntimePluginReleaseProtections } from './runtimePluginReleaseGcReferences.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const FAILURE_LIMIT = 2_000
const RESULT_SAMPLE_LIMIT = 100
const MAX_RELEASE_ROW_BYTES = 800 * 1024
const MAX_TOTAL_RELEASE_BYTES = 256 * 1024 * 1024
const RELEASE_CONTENT_COLUMNS = Object.freeze([
  'release_id',
  'plugin_id',
  'source_digest',
  'source_text',
  'plugin_snapshot_json',
  'release_content_digest',
  'digest_version',
  'validation_status',
  'health_status',
  'failure',
  'created_at',
])
export const RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS = 5 * 60 * 1_000

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  keepLatest: 10,
  minAgeMs: 7 * DAY_MS,
  maxDeletesPerRun: 25,
  maxReleasesScanned: 10_000,
  maxAuditRuns: 100,
})

const POLICY_FIELDS = Object.freeze({
  keepLatest: {
    env: 'RUNTIME_PLUGIN_RELEASE_GC_KEEP_LATEST', min: 1, max: 1_000,
  },
  minAgeMs: {
    env: 'RUNTIME_PLUGIN_RELEASE_GC_MIN_AGE_MS', min: 0, max: 10 * 365 * DAY_MS,
  },
  maxDeletesPerRun: {
    env: 'RUNTIME_PLUGIN_RELEASE_GC_MAX_DELETE', min: 1, max: 100,
  },
  maxReleasesScanned: {
    env: 'RUNTIME_PLUGIN_RELEASE_GC_MAX_SCAN', min: 1, max: 100_000,
  },
  maxAuditRuns: {
    env: 'RUNTIME_PLUGIN_RELEASE_GC_AUDIT_RUNS', min: 10, max: 1_000,
  },
})

function gcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizedTimestamp(value, field = 'now') {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return timestamp
}

function normalizedEnabled(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['', '0', 'false', 'no', 'off'].includes(text)) return false
  throw new TypeError('RUNTIME_PLUGIN_RELEASE_GC_ENABLED must be a boolean')
}

function normalizedDryRun(value) {
  if (typeof value !== 'boolean') throw new TypeError('dryRun must be a boolean')
  return value
}

function normalizedPolicyInteger(value, fallback, { min, max }, name) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return number
}

export function resolveRuntimePluginReleaseRetentionPolicy({
  env = process.env,
  overrides = {},
} = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {}
  const enabledValue = Object.hasOwn(source, 'enabled')
    ? source.enabled
    : env?.RUNTIME_PLUGIN_RELEASE_GC_ENABLED
  const policy = { enabled: normalizedEnabled(enabledValue) }
  for (const [name, bounds] of Object.entries(POLICY_FIELDS)) {
    const value = Object.hasOwn(source, name) ? source[name] : env?.[bounds.env]
    policy[name] = normalizedPolicyInteger(value, DEFAULT_POLICY[name], bounds, bounds.env)
  }
  return Object.freeze(policy)
}

function releaseFromRow(row) {
  return {
    releaseId: row.release_id,
    pluginId: row.plugin_id,
    sourceDigest: row.source_digest,
    source: row.source_text,
    pluginSnapshotJson: row.plugin_snapshot_json,
    releaseContentDigest: row.release_content_digest || null,
    digestVersion: Number(row.digest_version) || 0,
    validationStatus: row.validation_status,
    healthStatus: row.health_status,
    failure: row.failure || null,
    createdAt: Number(row.created_at) || 0,
  }
}

function storedValueBytes(value) {
  if (value == null) return 0
  if (Buffer.isBuffer(value)) return value.byteLength
  return Buffer.byteLength(String(value), 'utf8')
}

function releaseRowBytes(row) {
  return RELEASE_CONTENT_COLUMNS.reduce((total, column) => (
    total + storedValueBytes(row[column])
  ), 0)
}

function releaseRetentionView(release) {
  return {
    releaseId: release.releaseId,
    pluginId: release.pluginId,
    releaseContentDigest: release.releaseContentDigest,
    digestVersion: release.digestVersion,
    createdAt: release.createdAt,
  }
}

export function validateRuntimePluginReleaseScanStats({ rowCount, totalBytes, maxBytes }) {
  for (const [name, value] of Object.entries({ rowCount, totalBytes, maxBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw gcError(
        'PLUGIN_RELEASE_GC_RELEASE_SCAN_INVALID',
        `runtime plugin Release ${name} statistic is invalid`,
      )
    }
  }
  if (maxBytes > MAX_RELEASE_ROW_BYTES || totalBytes > MAX_TOTAL_RELEASE_BYTES) {
    throw gcError(
      'PLUGIN_RELEASE_GC_RELEASE_LIMIT',
      'runtime plugin Release content exceeds GC safety limits',
    )
  }
}

function loadVerifiedReleaseInventory(db, policy) {
  const contentBytesSql = RELEASE_CONTENT_COLUMNS
    .map((column) => `length(CAST(COALESCE(${column}, '') AS BLOB))`)
    .join(' + ')
  const stats = db.prepare(`
    SELECT COUNT(*) AS row_count,
      COALESCE(SUM(${contentBytesSql}), 0) AS total_bytes,
      COALESCE(MAX(${contentBytesSql}), 0) AS max_bytes
    FROM runtime_plugin_releases
  `).get()
  const rowCount = Number(stats?.row_count)
  const totalBytes = Number(stats?.total_bytes)
  const maxBytes = Number(stats?.max_bytes)
  validateRuntimePluginReleaseScanStats({ rowCount, totalBytes, maxBytes })
  if (rowCount > policy.maxReleasesScanned) {
    return {
      skipped: 'scan_limit_exceeded',
      extra: { releaseCount: rowCount },
    }
  }

  const rows = db.prepare(`
    SELECT release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
      release_content_digest, digest_version, validation_status, health_status,
      failure, created_at
    FROM runtime_plugin_releases
    ORDER BY plugin_id ASC, created_at DESC, release_id DESC
  `).iterate()
  const releases = []
  let scannedRows = 0
  let scannedBytes = 0
  for (const row of rows) {
    scannedRows += 1
    const bytes = releaseRowBytes(row)
    scannedBytes += bytes
    if (bytes > MAX_RELEASE_ROW_BYTES
      || scannedRows > rowCount
      || scannedBytes > MAX_TOTAL_RELEASE_BYTES) {
      throw gcError(
        'PLUGIN_RELEASE_GC_RELEASE_LIMIT',
        'runtime plugin Release content exceeds GC safety limits',
      )
    }
    const verified = verifyRuntimePluginReleaseContentIdentity(releaseFromRow(row))
    releases.push(releaseRetentionView(verified))
  }
  if (scannedRows !== rowCount || scannedBytes !== totalBytes) {
    throw gcError(
      'PLUGIN_RELEASE_GC_RELEASE_SCAN_INVALID',
      'runtime plugin Release scan changed unexpectedly',
    )
  }
  return { releases }
}

function safeFailure(error) {
  const message = String(error?.message || error || 'unknown GC failure').trim()
  return message.slice(0, FAILURE_LIMIT)
}

function parseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function publicAudit(row) {
  if (!row) return null
  return {
    runId: row.run_id,
    status: row.status,
    policy: parseJson(row.policy_json),
    result: parseJson(row.result_json),
    failure: row.failure || null,
    startedAt: Number(row.started_at) || 0,
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  }
}

export function getRuntimePluginReleaseGcAudit(runId) {
  const id = String(runId || '').trim()
  if (!id) return null
  return publicAudit(getDb().prepare(`
    SELECT * FROM runtime_plugin_release_gc_runs WHERE run_id = ?
  `).get(id))
}

export function listRuntimePluginReleaseGcAudits({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)))
  return getDb().prepare(`
    SELECT * FROM runtime_plugin_release_gc_runs
    ORDER BY started_at DESC, run_id DESC
    LIMIT ?
  `).all(safeLimit).map(publicAudit)
}

function startAudit(db, { runId, policy, now }) {
  db.prepare(`
    INSERT INTO runtime_plugin_release_gc_runs (
      run_id, status, policy_json, started_at
    ) VALUES (?, 'running', ?, ?)
  `).run(runId, JSON.stringify(policy), now)
}

function finishAudit(db, { runId, status, result, failure = null, now }) {
  const changed = db.prepare(`
    UPDATE runtime_plugin_release_gc_runs
    SET status = ?, result_json = ?, failure = ?, finished_at = ?
    WHERE run_id = ? AND status = 'running'
  `).run(status, JSON.stringify(result), failure, now, runId)
  if (changed.changes !== 1) throw gcError('PLUGIN_RELEASE_GC_AUDIT_CONFLICT', 'GC audit state changed unexpectedly')
}

function pruneAudits(db, maxAuditRuns, now) {
  db.prepare(`
    DELETE FROM runtime_plugin_release_gc_runs
    WHERE status <> 'running'
      AND run_id NOT IN (
        SELECT run_id FROM runtime_plugin_release_gc_runs
        WHERE status <> 'running'
        ORDER BY started_at DESC, run_id DESC
        LIMIT ?
      )
      AND NOT (
        status = 'completed'
        AND CASE WHEN json_valid(result_json) THEN (
          json_extract(result_json, '$.mode') = 'dry_run'
          AND json_extract(result_json, '$.reason') IS NULL
          AND json_extract(result_json, '$.preview.version') = 1
          AND json_extract(result_json, '$.preview.consumedAt') IS NULL
          AND json_extract(result_json, '$.preview.consumedByRunId') IS NULL
          AND json_extract(result_json, '$.preview.expiresAt')
            = started_at + ?
          AND started_at <= ?
          AND json_extract(result_json, '$.preview.expiresAt') > ?
        ) ELSE 0 END
      )
  `).run(maxAuditRuns, RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS, now, now)
}

function activeExecutionCounts(db, now) {
  db.prepare('DELETE FROM turn_execution_leases WHERE expires_at <= ?').run(now)
  db.prepare('DELETE FROM job_execution_leases WHERE expires_at <= ?').run(now)
  return {
    turns: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM turn_execution_leases WHERE expires_at > ?
    `).get(now)?.count) || 0,
    jobs: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM job_execution_leases WHERE expires_at > ?
    `).get(now)?.count) || 0,
  }
}

function normalizedOwnerId(value) {
  const ownerId = String(value || '').trim()
  if (!ownerId || ownerId.length > 256) {
    throw gcError('PLUGIN_RELEASE_GC_OWNER_REQUIRED', 'GC preview requires a bounded owner identity')
  }
  return ownerId
}

function normalizedPreviewRunId(value) {
  const runId = String(value || '').trim()
  if (!/^plugin-release-gc-[0-9a-f-]{36}$/u.test(runId)) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_REQUIRED', 'a valid previewRunId is required')
  }
  return runId
}

function digestJson(value) {
  return `sha256-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function policyBindingView(policy) {
  return {
    enabled: policy.enabled,
    keepLatest: policy.keepLatest,
    minAgeMs: policy.minAgeMs,
    maxDeletesPerRun: policy.maxDeletesPerRun,
    maxReleasesScanned: policy.maxReleasesScanned,
    maxAuditRuns: policy.maxAuditRuns,
  }
}

function releaseBindingView(release) {
  return {
    pluginId: release.pluginId,
    releaseId: release.releaseId,
    createdAt: release.createdAt,
    digestVersion: release.digestVersion,
    releaseContentDigest: release.releaseContentDigest,
  }
}

function canonicalProtections(protections) {
  return [...protections.entries()]
    .map(([releaseId, references]) => ({
      releaseId,
      references: references
        .map(({ reason, referenceId }) => ({ reason, referenceId }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
    }))
    .sort((left, right) => left.releaseId.localeCompare(right.releaseId, 'en'))
}

function createPlanBinding({ policy, releases, protections, checkpointStats, plan }) {
  const inventory = releases.map(releaseBindingView)
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId, 'en')
      || left.releaseId.localeCompare(right.releaseId, 'en'))
  const candidates = plan.selected.map(releaseBindingView)
  return {
    version: 1,
    policyDigest: digestJson(policyBindingView(policy)),
    inventoryDigest: digestJson(inventory),
    candidateDigest: digestJson(candidates),
    protectionDigest: digestJson({
      protections: canonicalProtections(protections),
      checkpointReferenceDigest: checkpointStats.referenceDigest,
    }),
    candidates,
  }
}

function samePlanBinding(left, right) {
  return left?.version === 1
    && right?.version === 1
    && left.policyDigest === right.policyDigest
    && left.inventoryDigest === right.inventoryDigest
    && left.candidateDigest === right.candidateDigest
    && left.protectionDigest === right.protectionDigest
}

function retainedReason(release, index, policy, protections, now) {
  if (index < policy.keepLatest) return 'latest'
  if (release.createdAt > now - policy.minAgeMs) return 'too_young'
  const references = protections.get(release.releaseId)
  if (references?.length) return 'referenced'
  return null
}

function buildRetentionPlan(releases, protections, policy, now) {
  const groups = new Map()
  for (const release of releases) {
    const group = groups.get(release.pluginId) || []
    group.push(release)
    groups.set(release.pluginId, group)
  }
  const eligible = []
  const retainedCounts = { latest: 0, too_young: 0, referenced: 0, delete_limit: 0 }
  const retainedSamples = []
  for (const group of groups.values()) {
    group.sort((left, right) => right.createdAt - left.createdAt
      || right.releaseId.localeCompare(left.releaseId, 'en'))
    group.forEach((release, index) => {
      const reason = retainedReason(release, index, policy, protections, now)
      if (!reason) {
        eligible.push(release)
        return
      }
      retainedCounts[reason] += 1
      if (retainedSamples.length < RESULT_SAMPLE_LIMIT) {
        retainedSamples.push({
          pluginId: release.pluginId,
          releaseId: release.releaseId,
          createdAt: release.createdAt,
          reason,
          references: (protections.get(release.releaseId) || []).slice(0, 10),
        })
      }
    })
  }
  eligible.sort((left, right) => left.createdAt - right.createdAt
    || left.releaseId.localeCompare(right.releaseId, 'en'))
  const selected = eligible.slice(0, policy.maxDeletesPerRun)
  retainedCounts.delete_limit = Math.max(0, eligible.length - selected.length)
  return { eligible, selected, retainedCounts, retainedSamples }
}

function loadPlanState(db, policy, now) {
  const executions = activeExecutionCounts(db, now)
  if (executions.turns > 0 || executions.jobs > 0) {
    return { skipped: 'execution_in_progress', extra: { executions } }
  }
  const inventory = loadVerifiedReleaseInventory(db, policy)
  if (inventory.skipped) return inventory
  const { releases } = inventory
  const releasesById = new Map(releases.map((release) => [release.releaseId, release]))
  const { protections, pinCount, checkpointStats } = collectRuntimePluginReleaseProtections(
    db,
    releasesById,
  )
  const plan = buildRetentionPlan(releases, protections, policy, now)
  const binding = createPlanBinding({ policy, releases, protections, checkpointStats, plan })
  return { releases, protections, pinCount, checkpointStats, plan, binding }
}

function candidateView(release) {
  return {
    pluginId: release.pluginId,
    releaseId: release.releaseId,
    createdAt: release.createdAt,
  }
}

function completedResult({
  releases,
  protections,
  checkpointStats,
  pinCount,
  plan,
  deleted,
  dryRun,
  preview = null,
  previewRunId = null,
}) {
  const candidates = plan.selected.map(candidateView)
  return {
    mode: dryRun ? 'dry_run' : 'delete',
    reason: null,
    scannedCount: releases.length,
    eligibleCount: plan.eligible.length,
    candidateCount: candidates.length,
    candidates,
    retainedCount: releases.length - candidates.length,
    remainingCount: releases.length - deleted.length,
    deletedCount: deleted.length,
    deleted,
    failureCount: 0,
    failures: [],
    protectedReleaseCount: protections.size,
    explicitPinCount: pinCount,
    checkpointReferenceRows: checkpointStats.rowCount,
    checkpointReleaseReferences: checkpointStats.protectedCount,
    retainedCounts: plan.retainedCounts,
    retainedSamples: plan.retainedSamples,
    ...(preview ? { preview } : {}),
    ...(previewRunId ? { previewRunId } : {}),
  }
}

function skippedResult(reason, { dryRun = false, ...extra } = {}) {
  return {
    mode: dryRun ? 'dry_run' : 'delete',
    reason,
    scannedCount: 0,
    eligibleCount: 0,
    candidateCount: 0,
    candidates: [],
    retainedCount: 0,
    remainingCount: null,
    deletedCount: 0,
    deleted: [],
    failureCount: 0,
    failures: [],
    ...extra,
  }
}

function failureResult(error, { dryRun, context = null, failedCandidate = null, previewRunId = null }) {
  const failure = safeFailure(error)
  const code = error?.code || 'gc_failed'
  return {
    failure,
    result: skippedResult(code, {
      dryRun,
      ...(context || {}),
      ...(previewRunId ? { previewRunId } : {}),
      failureCount: 1,
      failures: [{ code, message: failure, ...(failedCandidate || {}) }],
    }),
  }
}

function policyFromPreview(value) {
  if (!value || typeof value !== 'object' || value.dryRun !== true) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_INVALID', 'GC preview policy is invalid')
  }
  return resolveRuntimePluginReleaseRetentionPolicy({
    env: {},
    overrides: policyBindingView(value),
  })
}

function readPreview(db, { previewRunId, ownerId, now }) {
  const row = db.prepare(`
    SELECT * FROM runtime_plugin_release_gc_runs WHERE run_id = ?
  `).get(previewRunId)
  if (!row) throw gcError('PLUGIN_RELEASE_GC_PREVIEW_NOT_FOUND', 'GC preview was not found')
  const policyJson = parseJson(row.policy_json)
  const resultJson = parseJson(row.result_json)
  const preview = resultJson?.preview
  if (row.status !== 'completed'
    || resultJson?.mode !== 'dry_run'
    || resultJson?.reason !== null
    || !preview
    || preview.version !== 1) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_INVALID', 'GC preview is not executable')
  }
  if (policyJson?.ownerId !== ownerId || preview.ownerId !== ownerId) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_OWNER_MISMATCH', 'GC preview belongs to another owner')
  }
  const expiresAt = Number(preview.expiresAt)
  const startedAt = Number(row.started_at)
  if (!Number.isSafeInteger(expiresAt)
    || expiresAt !== startedAt + RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS
    || now < startedAt
    || now >= expiresAt) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_EXPIRED', 'GC preview has expired')
  }
  if (preview.consumedAt != null || preview.consumedByRunId != null) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_ALREADY_USED', 'GC preview has already been used')
  }
  const policy = policyFromPreview(policyJson)
  if (!policy.enabled
    || preview.policyDigest !== digestJson(policyBindingView(policy))
    || preview.candidateDigest !== digestJson(preview.candidates)) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_INVALID', 'GC preview binding is invalid')
  }
  return { row, policy, resultJson, preview }
}

function claimPreview(db, { previewRunId, ownerId, actualRunId, now }) {
  const current = readPreview(db, { previewRunId, ownerId, now })
  const nextResult = {
    ...current.resultJson,
    preview: {
      ...current.preview,
      consumedAt: now,
      consumedByRunId: actualRunId,
    },
  }
  const changed = db.prepare(`
    UPDATE runtime_plugin_release_gc_runs
    SET result_json = ?
    WHERE run_id = ? AND status = 'completed' AND result_json = ?
  `).run(JSON.stringify(nextResult), previewRunId, current.row.result_json)
  if (changed.changes !== 1) {
    throw gcError('PLUGIN_RELEASE_GC_PREVIEW_ALREADY_USED', 'GC preview claim lost a CAS race')
  }
  return current
}

function runPreview({ db, env, policyOverrides, ownerId, now }) {
  const policy = resolveRuntimePluginReleaseRetentionPolicy({ env, overrides: policyOverrides })
  const normalizedOwner = policy.enabled ? normalizedOwnerId(ownerId) : null
  const runId = `plugin-release-gc-${randomUUID()}`
  const auditPolicy = Object.freeze({ ...policy, dryRun: true, ownerId: normalizedOwner })
  startAudit(db, { runId, policy: auditPolicy, now })
  let context = null
  try {
    db.transaction(() => {
      if (!policy.enabled) {
        finishAudit(db, {
          runId,
          status: 'skipped',
          result: skippedResult('disabled', { dryRun: true }),
          now,
        })
        return
      }
      const state = loadPlanState(db, policy, now)
      if (state.skipped) {
        finishAudit(db, {
          runId,
          status: 'skipped',
          result: skippedResult(state.skipped, { dryRun: true, ...state.extra }),
          now,
        })
        return
      }
      context = {
        scannedCount: state.releases.length,
        eligibleCount: state.plan.eligible.length,
        candidateCount: state.plan.selected.length,
        candidates: state.plan.selected.map(candidateView),
        retainedCount: state.releases.length - state.plan.selected.length,
        remainingCount: state.releases.length,
      }
      const preview = {
        ...state.binding,
        ownerId: normalizedOwner,
        expiresAt: now + RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS,
        consumedAt: null,
        consumedByRunId: null,
      }
      finishAudit(db, {
        runId,
        status: 'completed',
        result: completedResult({
          ...state,
          deleted: [],
          dryRun: true,
          preview,
        }),
        now,
      })
    }).immediate()
  } catch (error) {
    const failed = failureResult(error, { dryRun: true, context })
    finishAudit(db, {
      runId,
      status: 'failed',
      result: failed.result,
      failure: failed.failure,
      now,
    })
  }
  pruneAudits(db, policy.maxAuditRuns, now)
  return getRuntimePluginReleaseGcAudit(runId)
}

function runFromPreview({ db, ownerId, previewRunId, now }) {
  const normalizedOwner = normalizedOwnerId(ownerId)
  const normalizedPreview = normalizedPreviewRunId(previewRunId)
  const initial = readPreview(db, {
    previewRunId: normalizedPreview,
    ownerId: normalizedOwner,
    now,
  })
  const policy = initial.policy
  const runId = `plugin-release-gc-${randomUUID()}`
  const auditPolicy = {
    ...policy,
    dryRun: false,
    ownerId: normalizedOwner,
    previewRunId: normalizedPreview,
  }
  let context = null
  let failedCandidate = null
  try {
    db.transaction(() => {
      startAudit(db, { runId, policy: auditPolicy, now })
      const claimed = claimPreview(db, {
        previewRunId: normalizedPreview,
        ownerId: normalizedOwner,
        actualRunId: runId,
        now,
      })
      const state = loadPlanState(db, policy, now)
      if (state.skipped || !samePlanBinding(claimed.preview, state.binding)) {
        throw gcError(
          'PLUGIN_RELEASE_GC_PREVIEW_STALE',
          'GC candidates or protection state changed after preview',
        )
      }
      context = {
        scannedCount: state.releases.length,
        eligibleCount: state.plan.eligible.length,
        candidateCount: state.plan.selected.length,
        candidates: state.plan.selected.map(candidateView),
        retainedCount: state.releases.length - state.plan.selected.length,
        remainingCount: state.releases.length,
      }
      const deleted = []
      const insertGuard = db.prepare(`
        INSERT INTO runtime_plugin_release_gc_delete_guards (release_id, run_id, created_at)
        VALUES (?, ?, ?)
      `)
      const deleteRelease = db.prepare(`
        DELETE FROM runtime_plugin_releases WHERE release_id = ?
      `)
      const clearGuard = db.prepare(`
        DELETE FROM runtime_plugin_release_gc_delete_guards
        WHERE release_id = ? AND run_id = ?
      `)
      for (const release of state.plan.selected) {
        failedCandidate = candidateView(release)
        insertGuard.run(release.releaseId, runId, now)
        const result = deleteRelease.run(release.releaseId)
        if (result.changes !== 1) {
          throw gcError('PLUGIN_RELEASE_GC_DELETE_CONFLICT', 'Release changed during GC')
        }
        clearGuard.run(release.releaseId, runId)
        deleted.push({ pluginId: release.pluginId, releaseId: release.releaseId })
        failedCandidate = null
      }
      finishAudit(db, {
        runId,
        status: 'completed',
        result: completedResult({
          ...state,
          deleted,
          dryRun: false,
          previewRunId: normalizedPreview,
        }),
        now,
      })
    }).immediate()
  } catch (error) {
    const failed = failureResult(error, {
      dryRun: false,
      context,
      failedCandidate,
      previewRunId: normalizedPreview,
    })
    db.transaction(() => {
      startAudit(db, { runId, policy: auditPolicy, now })
      finishAudit(db, {
        runId,
        status: 'failed',
        result: failed.result,
        failure: failed.failure,
        now,
      })
    }).immediate()
  }
  pruneAudits(db, policy.maxAuditRuns, now)
  return getRuntimePluginReleaseGcAudit(runId)
}

export function runRuntimePluginReleaseGc({
  env = process.env,
  policy: policyOverrides = {},
  dryRun = false,
  ownerId = null,
  previewRunId = null,
  now = Date.now(),
} = {}) {
  const timestamp = normalizedTimestamp(now)
  const previewOnly = normalizedDryRun(dryRun)
  const db = getDb()
  if (previewOnly) {
    return runPreview({ db, env, policyOverrides, ownerId, now: timestamp })
  }
  if (previewRunId) {
    if (Object.keys(policyOverrides || {}).length > 0) {
      throw gcError('PLUGIN_RELEASE_GC_PREVIEW_POLICY_OVERRIDE', 'actual GC cannot override preview policy')
    }
    return runFromPreview({ db, ownerId, previewRunId, now: timestamp })
  }
  const policy = resolveRuntimePluginReleaseRetentionPolicy({ env, overrides: policyOverrides })
  if (!policy.enabled) return runPreview({ db, env, policyOverrides, ownerId, now: timestamp })
  throw gcError('PLUGIN_RELEASE_GC_PREVIEW_REQUIRED', 'actual GC requires a reviewed previewRunId')
}
