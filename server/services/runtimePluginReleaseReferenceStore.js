import { getDb } from '../db.js'
import { getRuntimePluginRelease } from './runtimePluginStateStore.js'
import { runRuntimePluginReferenceWrite } from './runtimePluginLifecycleCoordinator.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const RELEASE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const REFERENCE_KINDS = new Set([
  'rollback', 'canary', 'turn', 'job', 'checkpoint', 'manual',
])
const MAX_REFERENCE_ID_LENGTH = 512

function normalizedPluginId(value) {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) throw new TypeError('pluginId is invalid')
  return pluginId
}

function normalizedReleaseId(value) {
  const releaseId = String(value || '').trim()
  if (!RELEASE_ID_RE.test(releaseId)) throw new TypeError('releaseId is invalid')
  return releaseId
}

function normalizedReferenceKind(value) {
  const kind = String(value || '').trim()
  if (!REFERENCE_KINDS.has(kind)) throw new TypeError('referenceKind is invalid')
  return kind
}

function normalizedReferenceId(value) {
  const referenceId = String(value || '').trim()
  if (!referenceId || referenceId.length > MAX_REFERENCE_ID_LENGTH) {
    throw new TypeError('referenceId must be between 1 and 512 characters')
  }
  return referenceId
}

function normalizedTimestamp(value) {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('now must be a non-negative safe integer')
  }
  return timestamp
}

function publicPin(row) {
  return row ? {
    pluginId: row.plugin_id,
    releaseId: row.release_id,
    referenceKind: row.reference_kind,
    referenceId: row.reference_id,
    createdAt: Number(row.created_at) || 0,
  } : null
}

export function pinRuntimePluginRelease({
  pluginId,
  releaseId,
  referenceKind,
  referenceId,
  now = Date.now(),
} = {}) {
  const normalized = {
    pluginId: normalizedPluginId(pluginId),
    releaseId: normalizedReleaseId(releaseId),
    referenceKind: normalizedReferenceKind(referenceKind),
    referenceId: normalizedReferenceId(referenceId),
    createdAt: normalizedTimestamp(now),
  }
  const db = getDb()
  return runRuntimePluginReferenceWrite(normalized.pluginId, () => db.transaction(() => {
    // This call verifies v76 content identity before a reference can be trusted.
    if (!getRuntimePluginRelease(normalized.pluginId, normalized.releaseId)) {
      throw new Error('runtime plugin release not found')
    }
    db.prepare(`
      INSERT INTO runtime_plugin_release_pins (
        plugin_id, release_id, reference_kind, reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, release_id, reference_kind, reference_id) DO NOTHING
    `).run(
      normalized.pluginId,
      normalized.releaseId,
      normalized.referenceKind,
      normalized.referenceId,
      normalized.createdAt,
    )
    return publicPin(db.prepare(`
      SELECT plugin_id, release_id, reference_kind, reference_id, created_at
      FROM runtime_plugin_release_pins
      WHERE plugin_id = ? AND release_id = ?
        AND reference_kind = ? AND reference_id = ?
    `).get(
      normalized.pluginId,
      normalized.releaseId,
      normalized.referenceKind,
      normalized.referenceId,
    ))
  }).immediate())
}

export function unpinRuntimePluginRelease({
  pluginId,
  releaseId,
  referenceKind,
  referenceId,
} = {}) {
  return getDb().prepare(`
    DELETE FROM runtime_plugin_release_pins
    WHERE plugin_id = ? AND release_id = ?
      AND reference_kind = ? AND reference_id = ?
  `).run(
    normalizedPluginId(pluginId),
    normalizedReleaseId(releaseId),
    normalizedReferenceKind(referenceKind),
    normalizedReferenceId(referenceId),
  ).changes || 0
}

export function listRuntimePluginReleasePins({
  pluginId = null,
  releaseId = null,
  referenceKind = null,
  referenceId = null,
} = {}) {
  const clauses = []
  const params = []
  if (pluginId != null) {
    clauses.push('plugin_id = ?')
    params.push(normalizedPluginId(pluginId))
  }
  if (releaseId != null) {
    clauses.push('release_id = ?')
    params.push(normalizedReleaseId(releaseId))
  }
  if (referenceKind != null) {
    clauses.push('reference_kind = ?')
    params.push(normalizedReferenceKind(referenceKind))
  }
  if (referenceId != null) {
    clauses.push('reference_id = ?')
    params.push(normalizedReferenceId(referenceId))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return getDb().prepare(`
    SELECT plugin_id, release_id, reference_kind, reference_id, created_at
    FROM runtime_plugin_release_pins
    ${where}
    ORDER BY created_at ASC, plugin_id ASC, release_id ASC
  `).all(...params).map(publicPin)
}
