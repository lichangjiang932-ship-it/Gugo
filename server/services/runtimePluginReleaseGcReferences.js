import { createHash } from 'node:crypto'

import { normalizeTurnExecutionEnvironmentSnapshot } from './turnExecutionEnvironment.js'

const MAX_REFERENCE_ROWS = 100_000
const MAX_REFERENCE_JSON_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_REFERENCE_BYTES = 256 * 1024 * 1024

function gcError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function parseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function addProtection(protections, releaseId, reason, referenceId = null) {
  if (!releaseId) return
  const entries = protections.get(releaseId) || []
  entries.push({ reason, referenceId })
  protections.set(releaseId, entries)
}

function collectAuthoritativeProtections(db, releasesById, protections) {
  const fields = [
    ['active_release_id', 'active'],
    ['previous_release_id', 'rollback'],
    ['last_rollback_from_release_id', 'rollback_audit'],
    ['last_rollback_to_release_id', 'rollback_audit'],
  ]
  const states = db.prepare(`
    SELECT * FROM runtime_plugin_states ORDER BY plugin_id ASC
  `).iterate()
  for (const state of states) {
    for (const [field, reason] of fields) {
      const releaseId = state[field]
      if (!releaseId) continue
      const release = releasesById.get(releaseId)
      if (!release || release.pluginId !== state.plugin_id) {
        throw gcError(
          'PLUGIN_RELEASE_GC_REFERENCE_INVALID',
          `runtime plugin state has an invalid ${field} reference`,
        )
      }
      addProtection(protections, releaseId, reason, state.plugin_id)
    }
  }
}

function collectExplicitProtections(db, releasesById, protections) {
  const pins = db.prepare(`
    SELECT plugin_id, release_id, reference_kind, reference_id
    FROM runtime_plugin_release_pins
    ORDER BY plugin_id ASC, release_id ASC, reference_kind ASC, reference_id ASC
  `).iterate()
  let pinCount = 0
  for (const pin of pins) {
    pinCount += 1
    const release = releasesById.get(pin.release_id)
    if (!release || release.pluginId !== pin.plugin_id) {
      throw gcError('PLUGIN_RELEASE_GC_REFERENCE_INVALID', 'runtime plugin release pin is invalid')
    }
    addProtection(protections, pin.release_id, pin.reference_kind, pin.reference_id)
  }
  return pinCount
}

function findExecutionEnvironments(value, output, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1
  if (budget.nodes > 200_000 || depth > 40) {
    throw gcError('PLUGIN_RELEASE_GC_REFERENCE_LIMIT', 'checkpoint reference graph exceeds safety limits')
  }
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const entry of value) findExecutionEnvironments(entry, output, depth + 1, budget)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'executionEnvironment') {
      const normalized = normalizeTurnExecutionEnvironmentSnapshot(entry)
      if (!normalized) {
        throw gcError(
          'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE',
          'checkpoint execution environment cannot be verified',
        )
      }
      output.push(normalized)
      continue
    }
    findExecutionEnvironments(entry, output, depth + 1, budget)
  }
}

function sourceDefinition(db, {
  kind,
  from,
  where = '',
  referenceId,
  referenceJson,
  referenceCreatedAt = 'created_at',
  referenceUpdatedAt = 'created_at',
  orderBy,
}) {
  const stats = db.prepare(`
    SELECT COUNT(*) AS row_count,
      COALESCE(SUM(length(CAST(${referenceJson} AS BLOB))), 0) AS total_bytes,
      COALESCE(MAX(length(CAST(${referenceJson} AS BLOB))), 0) AS max_bytes
    FROM ${from}
    ${where}
  `).get()
  const rows = db.prepare(`
    SELECT ${referenceId} AS reference_id,
      ${referenceJson} AS reference_json,
      ${referenceCreatedAt} AS created_at,
      ${referenceUpdatedAt} AS updated_at
    FROM ${from}
    ${where}
    ORDER BY ${orderBy}
  `)
  return {
    kind,
    rowCount: Number(stats?.row_count) || 0,
    totalBytes: Number(stats?.total_bytes) || 0,
    maxBytes: Number(stats?.max_bytes) || 0,
    iterate: () => rows.iterate(),
  }
}

function checkpointSources(db) {
  return [
    sourceDefinition(db, {
      kind: 'turn_checkpoint',
      from: 'turn_checkpoints',
      referenceId: "user_id || ':' || session_id || ':' || turn_id",
      referenceJson: 'state_json',
      referenceUpdatedAt: 'updated_at',
      orderBy: 'user_id ASC, session_id ASC, turn_id ASC',
    }),
    sourceDefinition(db, {
      kind: 'job_checkpoint',
      from: 'job_turn_checkpoints',
      referenceId: "user_id || ':' || job_id || ':' || step_id",
      referenceJson: 'state_json',
      referenceUpdatedAt: 'updated_at',
      orderBy: 'user_id ASC, job_id ASC, step_id ASC',
    }),
    sourceDefinition(db, {
      kind: 'legacy_turn_checkpoint',
      from: 'turn_events',
      where: `WHERE type = 'turn.checkpoint'
        AND json_extract(payload_json, '$.state') IS NOT NULL`,
      referenceId: "user_id || ':' || session_id || ':' || turn_id || ':' || sequence",
      referenceJson: 'payload_json',
      orderBy: 'user_id ASC, session_id ASC, turn_id ASC, sequence ASC',
    }),
    sourceDefinition(db, {
      kind: 'event_write_failure_checkpoint',
      from: 'event_write_failures',
      where: 'WHERE checkpoint_state_json IS NOT NULL',
      referenceId: "COALESCE(user_id, '') || ':' || CAST(id AS TEXT)",
      referenceJson: 'checkpoint_state_json',
      referenceCreatedAt: 'failed_at',
      referenceUpdatedAt: 'failed_at',
      orderBy: 'failed_at ASC, id ASC',
    }),
  ]
}

function updateReferenceDigest(hash, source, row) {
  const serialized = JSON.stringify([
    source.kind,
    row.reference_id,
    Number(row.created_at) || 0,
    Number(row.updated_at) || 0,
    String(row.reference_json || ''),
  ])
  hash.update(String(Buffer.byteLength(serialized, 'utf8')))
  hash.update(':')
  hash.update(serialized)
}

function collectCheckpointProtections(db, releasesById, protections) {
  const sources = checkpointSources(db)
  const rowCount = sources.reduce((sum, source) => sum + source.rowCount, 0)
  const totalBytes = sources.reduce((sum, source) => sum + source.totalBytes, 0)
  const maxBytes = Math.max(0, ...sources.map((source) => source.maxBytes))
  if (!Number.isSafeInteger(rowCount) || rowCount > MAX_REFERENCE_ROWS) {
    throw gcError('PLUGIN_RELEASE_GC_REFERENCE_LIMIT', 'too many checkpoint references to verify safely')
  }
  if (!Number.isSafeInteger(totalBytes)
    || maxBytes > MAX_REFERENCE_JSON_BYTES
    || totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
    throw gcError('PLUGIN_RELEASE_GC_REFERENCE_LIMIT', 'checkpoint reference data exceeds safety limits')
  }
  const earliestReleaseAt = Math.min(
    ...[...releasesById.values()].map((release) => release.createdAt),
    Number.POSITIVE_INFINITY,
  )
  const referenceHash = createHash('sha256')
  let scannedRows = 0
  let scannedBytes = 0
  let protectedCount = 0
  for (const source of sources) {
    for (const row of source.iterate()) {
      scannedRows += 1
      const bytes = Buffer.byteLength(String(row.reference_json || ''), 'utf8')
      scannedBytes += bytes
      if (bytes > MAX_REFERENCE_JSON_BYTES
        || scannedRows > MAX_REFERENCE_ROWS
        || scannedBytes > MAX_TOTAL_REFERENCE_BYTES) {
        throw gcError('PLUGIN_RELEASE_GC_REFERENCE_LIMIT', 'checkpoint reference data exceeds safety limits')
      }
      updateReferenceDigest(referenceHash, source, row)
      const value = parseJson(row.reference_json)
      if (!value || typeof value !== 'object') {
        throw gcError('PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE', 'checkpoint JSON cannot be verified')
      }
      const snapshots = []
      findExecutionEnvironments(value, snapshots)
      const referenceActivityAt = Math.max(
        Number(row.created_at) || 0,
        Number(row.updated_at) || 0,
      )
      if (snapshots.length === 0 && referenceActivityAt >= earliestReleaseAt) {
        throw gcError(
          'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE',
          `${source.kind} does not contain a verifiable execution environment`,
        )
      }
      for (const snapshot of snapshots) {
        if (snapshot.unpinnedPluginIds.length > 0) {
          throw gcError('PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE', 'checkpoint contains unpinned runtime plugins')
        }
        for (const plugin of snapshot.runtimePlugins) {
          if (!plugin.releaseId) continue
          const release = releasesById.get(plugin.releaseId)
          if (!release
            || release.pluginId !== plugin.id
            || release.digestVersion !== plugin.digestVersion
            || release.releaseContentDigest !== plugin.contentDigest) {
            throw gcError(
              'PLUGIN_RELEASE_GC_REFERENCE_INVALID',
              'checkpoint runtime plugin Release identity does not match storage',
            )
          }
          addProtection(protections, plugin.releaseId, source.kind, row.reference_id)
          protectedCount += 1
        }
      }
    }
  }
  if (scannedRows !== rowCount || scannedBytes !== totalBytes) {
    throw gcError('PLUGIN_RELEASE_GC_REFERENCE_INVALID', 'checkpoint reference scan changed unexpectedly')
  }
  return {
    rowCount,
    protectedCount,
    totalBytes,
    referenceDigest: `sha256-${referenceHash.digest('hex')}`,
  }
}

export function collectRuntimePluginReleaseProtections(db, releasesById) {
  const protections = new Map()
  collectAuthoritativeProtections(db, releasesById, protections)
  const pinCount = collectExplicitProtections(db, releasesById, protections)
  const checkpointStats = collectCheckpointProtections(db, releasesById, protections)
  return { protections, pinCount, checkpointStats }
}
