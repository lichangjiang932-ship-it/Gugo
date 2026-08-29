import { getDb } from '../db.js'
import {
  buildRuntimePluginReleaseContentIdentity,
  verifyRuntimePluginReleaseContentIdentity,
} from '../plugins/runtimePluginReleaseIdentity.js'
import {
  grantRuntimePluginPermissionsInDb,
  runtimePluginPermissionGrantMatchesInDb,
} from './runtimePluginPermissionGrantStore.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const RELEASE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const SOURCE_DIGEST_RE = /^sha256-[a-f0-9]{64}$/
const LAST_ERROR_LIMIT = 2_000
const MAX_RELEASE_SOURCE_BYTES = 512 * 1024
const MAX_PLUGIN_SNAPSHOT_BYTES = 256 * 1024

function normalizePluginId(value) {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new TypeError('pluginId must match [a-z0-9][a-z0-9-]* and be at most 80 characters')
  }
  return pluginId
}

function normalizeReleaseId(value, { nullable = false } = {}) {
  if (nullable && value == null) return null
  const releaseId = String(value || '').trim()
  if (!RELEASE_ID_RE.test(releaseId)) {
    throw new TypeError('releaseId must be a bounded opaque identifier')
  }
  return releaseId
}

function normalizeTimestamp(value, field = 'now') {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return timestamp
}

function normalizeRevision(value, field = 'releaseRevision') {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return revision
}

function releaseStateConflict() {
  const error = new Error('运行时插件权威 Release 已被其他进程修改')
  error.code = 'PLUGIN_RELEASE_STATE_CONFLICT'
  error.statusCode = 409
  return error
}

function permissionApprovalRequired(request) {
  const error = new Error('插件源码或权限已变化，需要本机所有者明确授权')
  error.code = 'PLUGIN_PERMISSION_APPROVAL_REQUIRED'
  error.statusCode = 409
  error.retryable = false
  error.permissionApproval = request
  return error
}

function commitPermissionGrant(db, {
  permissionRequest,
  persistPermissionGrant,
  now,
}) {
  if (!permissionRequest) {
    if (persistPermissionGrant) {
      throw new TypeError('permissionRequest is required when persistPermissionGrant is true')
    }
    return
  }
  if (persistPermissionGrant) {
    grantRuntimePluginPermissionsInDb(db, { request: permissionRequest, now })
  }
  if (!runtimePluginPermissionGrantMatchesInDb(db, permissionRequest)) {
    throw permissionApprovalRequired(permissionRequest)
  }
}

function normalizeError(value) {
  const text = String(value || '').trim()
  return text ? text.slice(0, LAST_ERROR_LIMIT) : null
}

function publicState(row) {
  if (!row) return null
  const rollbackStatus = row.last_rollback_status || null
  return {
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    lastError: row.last_error || null,
    updatedAt: Number(row.updated_at) || 0,
    activeReleaseId: row.active_release_id || null,
    previousReleaseId: row.previous_release_id || null,
    releaseRevision: normalizeRevision(row.release_revision || 0),
    lastRollback: rollbackStatus
      ? {
          status: rollbackStatus,
          fromReleaseId: row.last_rollback_from_release_id || null,
          toReleaseId: row.last_rollback_to_release_id || null,
          reason: row.last_rollback_reason || null,
          at: Number(row.last_rollback_at) || 0,
        }
      : null,
  }
}

function publicRelease(row) {
  if (!row) return null
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

const STATE_COLUMNS = `
  plugin_id, enabled, last_error, updated_at,
  active_release_id, previous_release_id, release_revision,
  last_rollback_status, last_rollback_from_release_id,
  last_rollback_to_release_id, last_rollback_reason, last_rollback_at
`

const RELEASE_COLUMNS = `
  release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
  release_content_digest, digest_version,
  validation_status, health_status, failure, created_at
`

function verifiedActiveReleaseState(state) {
  if (!state?.enabled || !state.activeReleaseId) return state
  const release = getRuntimePluginRelease(state.pluginId, state.activeReleaseId)
  if (!release) {
    const error = new Error(`插件 Release 内容身份校验失败：active Release 不存在`)
    error.code = 'PLUGIN_RELEASE_CORRUPT'
    error.statusCode = 500
    throw error
  }
  return {
    ...state,
    activeReleaseContentDigest: release.releaseContentDigest,
    activeReleaseDigestVersion: release.digestVersion,
  }
}

export function listRuntimePluginStates({ verifyActiveReleases = false } = {}) {
  const states = getDb().prepare(`
    SELECT ${STATE_COLUMNS}
    FROM runtime_plugin_states
    ORDER BY plugin_id ASC
  `).all().map(publicState)
  return verifyActiveReleases ? states.map(verifiedActiveReleaseState) : states
}

export function getRuntimePluginState(pluginId, { verifyActiveRelease = false } = {}) {
  const id = normalizePluginId(pluginId)
  const state = publicState(getDb().prepare(`
    SELECT ${STATE_COLUMNS}
    FROM runtime_plugin_states
    WHERE plugin_id = ?
  `).get(id))
  return verifyActiveRelease ? verifiedActiveReleaseState(state) : state
}

/** Update desired state/error metadata without changing Release pointers. */
export function setRuntimePluginState({ pluginId, enabled, lastError = null, now = Date.now() }) {
  const id = normalizePluginId(pluginId)
  const timestamp = normalizeTimestamp(now)
  getDb().prepare(`
    INSERT INTO runtime_plugin_states (plugin_id, enabled, last_error, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      enabled = excluded.enabled,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(id, enabled === true ? 1 : 0, normalizeError(lastError), timestamp)
  return getRuntimePluginState(id)
}

export function recordRuntimePluginError({ pluginId, error, now = Date.now() }) {
  const id = normalizePluginId(pluginId)
  const timestamp = normalizeTimestamp(now)
  getDb().prepare(`
    INSERT INTO runtime_plugin_states (plugin_id, enabled, last_error, updated_at)
    VALUES (?, 0, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(id, normalizeError(error), timestamp)
  return getRuntimePluginState(id)
}

/** Clear a stale restore error without rewriting an unchanged Release pointer. */
export function confirmRuntimePluginRelease({
  pluginId,
  releaseId,
  expectedReleaseRevision,
  expectedEnabled = true,
  permissionRequest = null,
  persistPermissionGrant = false,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const activeId = normalizeReleaseId(releaseId)
  const expectedRevision = normalizeRevision(expectedReleaseRevision, 'expectedReleaseRevision')
  if (typeof expectedEnabled !== 'boolean') throw new TypeError('expectedEnabled must be boolean')
  const timestamp = normalizeTimestamp(now)
  const db = getDb()
  db.transaction(() => {
    requireReadyRelease(db, id, activeId)
    const changed = db.prepare(`
      UPDATE runtime_plugin_states SET
        enabled = 1,
        last_error = NULL,
        updated_at = ?
      WHERE plugin_id = ?
        AND enabled = ?
        AND active_release_id = ?
        AND release_revision = ?
    `).run(timestamp, id, expectedEnabled ? 1 : 0, activeId, expectedRevision)
    if (changed.changes !== 1) throw releaseStateConflict()
    commitPermissionGrant(db, { permissionRequest, persistPermissionGrant, now: timestamp })
  })()
  return getRuntimePluginState(id)
}

/** Restore desired=enabled only when the exact failed disable write is current. */
export function compensateRuntimePluginDisableFailure({
  pluginId,
  expectedActiveReleaseId = null,
  expectedReleaseRevision,
  expectedDisabledAt,
  error,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const activeId = normalizeReleaseId(expectedActiveReleaseId, { nullable: true })
  const expectedRevision = normalizeRevision(expectedReleaseRevision, 'expectedReleaseRevision')
  const disabledAt = normalizeTimestamp(expectedDisabledAt, 'expectedDisabledAt')
  const timestamp = normalizeTimestamp(now)
  const changed = getDb().prepare(`
    UPDATE runtime_plugin_states SET
      enabled = 1,
      last_error = ?,
      updated_at = ?
    WHERE plugin_id = ?
      AND enabled = 0
      AND release_revision = ?
      AND updated_at = ?
      AND ((active_release_id IS NULL AND ? IS NULL) OR active_release_id = ?)
  `).run(
    normalizeError(error),
    timestamp,
    id,
    expectedRevision,
    disabledAt,
    activeId,
    activeId,
  )
  return changed.changes === 1 ? getRuntimePluginState(id) : null
}

/** Insert one immutable release snapshot. This intentionally has no update API. */
export function createRuntimePluginRelease({
  pluginId,
  releaseId,
  sourceDigest,
  source,
  pluginSnapshotJson,
  validationStatus,
  healthStatus,
  failure = null,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const normalizedReleaseId = normalizeReleaseId(releaseId)
  const digest = String(sourceDigest || '').trim().toLowerCase()
  if (!SOURCE_DIGEST_RE.test(digest)) throw new TypeError('sourceDigest must be a sha256 hex digest')
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_RELEASE_SOURCE_BYTES) {
    throw new TypeError('source must be a string no larger than 512 KiB')
  }
  if (typeof pluginSnapshotJson !== 'string'
    || Buffer.byteLength(pluginSnapshotJson, 'utf8') > MAX_PLUGIN_SNAPSHOT_BYTES) {
    throw new TypeError('pluginSnapshotJson must be a bounded JSON string')
  }
  let snapshot
  try {
    snapshot = JSON.parse(pluginSnapshotJson)
  } catch {
    throw new TypeError('pluginSnapshotJson must contain valid JSON')
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.id !== id) {
    throw new TypeError('pluginSnapshotJson must identify the same plugin')
  }
  if (!['passed', 'failed'].includes(validationStatus)) {
    throw new TypeError('validationStatus must be passed or failed')
  }
  if (!['passed', 'failed', 'not_run'].includes(healthStatus)) {
    throw new TypeError('healthStatus must be passed, failed, or not_run')
  }
  if (validationStatus === 'failed' && healthStatus !== 'not_run') {
    throw new TypeError('failed validation cannot have a health result')
  }
  if (validationStatus === 'passed' && healthStatus === 'not_run') {
    throw new TypeError('passed validation must have a health result')
  }
  const timestamp = normalizeTimestamp(now)
  const normalizedFailure = normalizeError(failure)
  const identity = buildRuntimePluginReleaseContentIdentity({
    releaseId: normalizedReleaseId,
    pluginId: id,
    sourceDigest: digest,
    source,
    pluginSnapshotJson,
    validationStatus,
    healthStatus,
    failure: normalizedFailure,
    createdAt: timestamp,
  })
  getDb().prepare(`
    INSERT INTO runtime_plugin_releases (
      release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
      release_content_digest, digest_version,
      validation_status, health_status, failure, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizedReleaseId,
    id,
    digest,
    source,
    pluginSnapshotJson,
    identity.releaseContentDigest,
    identity.digestVersion,
    validationStatus,
    healthStatus,
    normalizedFailure,
    timestamp,
  )
  return getRuntimePluginRelease(id, normalizedReleaseId)
}

export function getRuntimePluginRelease(pluginId, releaseId) {
  const id = normalizePluginId(pluginId)
  const normalizedReleaseId = normalizeReleaseId(releaseId)
  const release = publicRelease(getDb().prepare(`
    SELECT ${RELEASE_COLUMNS}
    FROM runtime_plugin_releases
    WHERE plugin_id = ? AND release_id = ?
  `).get(id, normalizedReleaseId))
  return release ? verifyRuntimePluginReleaseContentIdentity(release) : null
}

export function getLatestRuntimePluginRelease(pluginId) {
  const id = normalizePluginId(pluginId)
  const release = publicRelease(getDb().prepare(`
    SELECT ${RELEASE_COLUMNS}
    FROM runtime_plugin_releases
    WHERE plugin_id = ?
    ORDER BY created_at DESC, release_id DESC
    LIMIT 1
  `).get(id))
  return release ? verifyRuntimePluginReleaseContentIdentity(release) : null
}

export function countRuntimePluginReleases(pluginId) {
  const id = normalizePluginId(pluginId)
  return Number(getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM runtime_plugin_releases
    WHERE plugin_id = ?
  `).get(id)?.count) || 0
}

function requireReadyRelease(db, pluginId, releaseId) {
  const release = publicRelease(db.prepare(`
    SELECT ${RELEASE_COLUMNS}
    FROM runtime_plugin_releases
    WHERE plugin_id = ? AND release_id = ?
  `).get(pluginId, releaseId))
  if (!release) throw new Error(`runtime plugin release not found: ${pluginId}/${releaseId}`)
  verifyRuntimePluginReleaseContentIdentity(release)
  if (release.validationStatus !== 'passed' || release.healthStatus !== 'passed') {
    throw new Error(`runtime plugin release is not healthy: ${pluginId}/${releaseId}`)
  }
}

function releaseReferenceError(field, pluginId, releaseId, reason) {
  const error = new Error(
    `${field} runtime plugin release ${reason}: ${pluginId}/${releaseId}`,
  )
  error.code = 'PLUGIN_RELEASE_REFERENCE_INVALID'
  error.statusCode = 409
  return error
}

function requireReleaseReference(db, pluginId, releaseId, field) {
  const release = db.prepare(`
    SELECT plugin_id
    FROM runtime_plugin_releases
    WHERE release_id = ?
  `).get(releaseId)
  if (!release) {
    throw releaseReferenceError(field, pluginId, releaseId, 'was not found')
  }
  if (release.plugin_id !== pluginId) {
    throw releaseReferenceError(field, pluginId, releaseId, 'belongs to another plugin')
  }
}

/** Atomically make a healthy immutable release authoritative. */
export function activateRuntimePluginRelease({
  pluginId,
  releaseId,
  previousReleaseId = null,
  expectedActiveReleaseId = null,
  expectedReleaseRevision,
  expectedEnabled = true,
  permissionRequest = null,
  persistPermissionGrant = false,
  rollbackReceipt = null,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const activeId = normalizeReleaseId(releaseId)
  const previousId = normalizeReleaseId(previousReleaseId, { nullable: true })
  const expectedActiveId = normalizeReleaseId(expectedActiveReleaseId, { nullable: true })
  const expectedRevision = normalizeRevision(expectedReleaseRevision, 'expectedReleaseRevision')
  if (typeof expectedEnabled !== 'boolean') throw new TypeError('expectedEnabled must be boolean')
  const timestamp = normalizeTimestamp(now)
  let receipt = null
  if (rollbackReceipt != null) {
    if (!rollbackReceipt || typeof rollbackReceipt !== 'object') {
      throw new TypeError('rollbackReceipt must be an object')
    }
    const fromId = normalizeReleaseId(rollbackReceipt.fromReleaseId, { nullable: true })
    const toId = normalizeReleaseId(rollbackReceipt.toReleaseId)
    if (toId !== activeId) throw new TypeError('rollbackReceipt.toReleaseId must equal releaseId')
    const status = String(rollbackReceipt.status || '')
    if (!['succeeded', 'failed'].includes(status)) {
      throw new TypeError('rollback status must be succeeded or failed')
    }
    receipt = {
      fromId,
      toId,
      status,
      summary: normalizeError(rollbackReceipt.reason),
    }
  }
  const db = getDb()
  db.transaction(() => {
    requireReadyRelease(db, id, activeId)
    if (previousId) {
      requireReleaseReference(db, id, previousId, 'previousReleaseId')
    }
    if (receipt?.fromId) {
      requireReleaseReference(db, id, receipt.fromId, 'rollbackReceipt.fromReleaseId')
    }
    const changed = db.prepare(`
      UPDATE runtime_plugin_states SET
        enabled = 1,
        last_error = NULL,
        updated_at = ?,
        active_release_id = ?,
        previous_release_id = ?,
        release_revision = release_revision + 1
      WHERE plugin_id = ?
        AND enabled = ?
        AND release_revision = ?
        AND ((active_release_id IS NULL AND ? IS NULL) OR active_release_id = ?)
    `).run(
      timestamp,
      activeId,
      previousId,
      id,
      expectedEnabled ? 1 : 0,
      expectedRevision,
      expectedActiveId,
      expectedActiveId,
    )
    if (changed.changes !== 1) throw releaseStateConflict()
    commitPermissionGrant(db, { permissionRequest, persistPermissionGrant, now: timestamp })
    if (receipt) {
      const audited = db.prepare(`
        UPDATE runtime_plugin_states SET
          last_error = ?,
          updated_at = ?,
          last_rollback_status = ?,
          last_rollback_from_release_id = ?,
          last_rollback_to_release_id = ?,
          last_rollback_reason = ?,
          last_rollback_at = ?
        WHERE plugin_id = ?
          AND active_release_id = ?
          AND release_revision = ?
      `).run(
        receipt.summary,
        timestamp,
        receipt.status,
        receipt.fromId,
        receipt.toId,
        receipt.summary,
        timestamp,
        id,
        activeId,
        expectedRevision + 1,
      )
      if (audited.changes !== 1) throw releaseStateConflict()
    }
  })()
  return getRuntimePluginState(id)
}

export function deactivateRuntimePluginRelease({
  pluginId,
  expectedActiveReleaseId = null,
  expectedReleaseRevision,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const timestamp = normalizeTimestamp(now)
  const expectedActiveId = normalizeReleaseId(expectedActiveReleaseId, { nullable: true })
  const expectedRevision = normalizeRevision(expectedReleaseRevision, 'expectedReleaseRevision')
  const changed = getDb().prepare(`
    UPDATE runtime_plugin_states SET
      last_error = NULL,
      updated_at = ?,
      previous_release_id = COALESCE(active_release_id, previous_release_id),
      active_release_id = NULL,
      release_revision = release_revision + 1
    WHERE plugin_id = ?
      AND enabled = 0
      AND release_revision = ?
      AND ((active_release_id IS NULL AND ? IS NULL) OR active_release_id = ?)
  `).run(timestamp, id, expectedRevision, expectedActiveId, expectedActiveId)
  if (changed.changes !== 1) throw releaseStateConflict()
  return getRuntimePluginState(id)
}

/** Persist automatic rollback audit metadata without changing Release pointers. */
export function recordRuntimePluginRollback({
  pluginId,
  fromReleaseId,
  toReleaseId,
  status,
  reason,
  now = Date.now(),
}) {
  const id = normalizePluginId(pluginId)
  const fromId = normalizeReleaseId(fromReleaseId, { nullable: true })
  const toId = normalizeReleaseId(toReleaseId)
  if (!['succeeded', 'failed'].includes(status)) {
    throw new TypeError('rollback status must be succeeded or failed')
  }
  const timestamp = normalizeTimestamp(now)
  const summary = normalizeError(reason)
  const db = getDb()
  db.transaction(() => {
    requireReadyRelease(db, id, toId)
    if (fromId) {
      requireReleaseReference(db, id, fromId, 'fromReleaseId')
    }
    const current = getRuntimePluginState(id)
    if (!current) throw new Error(`runtime plugin state not found: ${id}`)
    db.prepare(`
      UPDATE runtime_plugin_states SET
        last_error = ?,
        updated_at = ?,
        last_rollback_status = ?,
        last_rollback_from_release_id = ?,
        last_rollback_to_release_id = ?,
        last_rollback_reason = ?,
        last_rollback_at = ?
      WHERE plugin_id = ?
    `).run(summary, timestamp, status, fromId, toId, summary, timestamp, id)
  })()
  return getRuntimePluginState(id)
}
