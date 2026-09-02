import { getDb } from '../db.js'
import { verifyRuntimePluginReleaseContentIdentity } from '../plugins/runtimePluginReleaseIdentity.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const FAILURE_LIMIT = 2_000
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

function normalizedEnabled(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['', '0', 'false', 'no', 'off'].includes(text)) return false
  throw new TypeError('RUNTIME_PLUGIN_RELEASE_GC_ENABLED must be a boolean')
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

export function loadVerifiedReleaseInventory(db, policy) {
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

export function safeFailure(error) {
  const message = String(error?.message || error || 'unknown GC failure').trim()
  return message.slice(0, FAILURE_LIMIT)
}

export function parseJson(value) {
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

export function startAudit(db, { runId, policy, now }) {
  db.prepare(`
    INSERT INTO runtime_plugin_release_gc_runs (
      run_id, status, policy_json, started_at
    ) VALUES (?, 'running', ?, ?)
  `).run(runId, JSON.stringify(policy), now)
}

export function finishAudit(db, { runId, status, result, failure = null, now }) {
  const changed = db.prepare(`
    UPDATE runtime_plugin_release_gc_runs
    SET status = ?, result_json = ?, failure = ?, finished_at = ?
    WHERE run_id = ? AND status = 'running'
  `).run(status, JSON.stringify(result), failure, now, runId)
  if (changed.changes !== 1) throw gcError('PLUGIN_RELEASE_GC_AUDIT_CONFLICT', 'GC audit state changed unexpectedly')
}

export function pruneAudits(db, maxAuditRuns, now) {
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

export function activeExecutionCounts(db, now) {
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
