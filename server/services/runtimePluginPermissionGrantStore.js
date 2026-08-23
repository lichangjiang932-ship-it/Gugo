import { getDb } from '../db.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const DIGEST_RE = /^sha256-[a-f0-9]{64}$/
const PERMISSION_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const LOCAL_OWNER_META_KEY = 'local_auth_owner_user_id'

function normalizePluginId(value) {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) throw new TypeError('pluginId is invalid')
  return pluginId
}

function normalizeDigest(value, field) {
  const digest = String(value || '').trim().toLowerCase()
  if (!DIGEST_RE.test(digest)) throw new TypeError(`${field} must be a sha256 hex digest`)
  return digest
}

function normalizeTimestamp(value, field) {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return timestamp
}

function normalizePermissions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError('permissions must be a non-empty array with at most 64 entries')
  }
  const permissions = value.map((permission) => String(permission || '').trim())
  if (permissions.some((permission) => !PERMISSION_RE.test(permission))) {
    throw new TypeError('permissions contain an invalid identifier')
  }
  return Object.freeze([...new Set(permissions)].sort())
}

function parsePermissions(value) {
  try {
    return normalizePermissions(JSON.parse(value))
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('stored runtime plugin permissions are invalid', { cause: error })
  }
}

function publicGrant(row) {
  if (!row) return null
  return Object.freeze({
    pluginId: row.plugin_id,
    ownerId: row.owner_id,
    approvalDigest: row.approval_digest,
    sourceDigest: row.source_digest,
    permissions: parsePermissions(row.permissions_json),
    grantedAt: Number(row.granted_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  })
}

function currentLocalOwnerId(db, { required = false } = {}) {
  const ownerId = String(db.prepare(`
    SELECT m.value
    FROM meta m
    JOIN users u ON u.id = m.value
    WHERE m.key = ?
  `).get(LOCAL_OWNER_META_KEY)?.value || '').trim()
  if (ownerId) return ownerId
  if (!required) return null
  const error = new Error('固定的本机插件授权所有者不可用')
  error.code = 'PLUGIN_PERMISSION_OWNER_UNAVAILABLE'
  error.statusCode = 409
  error.retryable = false
  throw error
}

export function getRuntimePluginPermissionGrantFromDb(db, pluginId) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const id = normalizePluginId(pluginId)
  const ownerId = currentLocalOwnerId(db)
  if (!ownerId) return null
  return publicGrant(db.prepare(`
    SELECT plugin_id, owner_id, approval_digest, source_digest,
           permissions_json, granted_at, updated_at
    FROM runtime_plugin_permission_grants
    WHERE plugin_id = ? AND owner_id = ?
  `).get(id, ownerId))
}

export function getRuntimePluginPermissionGrant(pluginId) {
  return getRuntimePluginPermissionGrantFromDb(getDb(), pluginId)
}

function normalizedPermissionRequest(request) {
  const id = normalizePluginId(request?.pluginId)
  const approvalDigest = normalizeDigest(request?.approvalDigest, 'approvalDigest')
  const sourceDigest = normalizeDigest(request?.sourceDigest, 'sourceDigest')
  const permissions = normalizePermissions(request?.permissions)
  return { id, approvalDigest, sourceDigest, permissions }
}

function permissionsEqual(left, right) {
  return left.length === right.length
    && left.every((permission, index) => permission === right[index])
}

export function runtimePluginPermissionGrantMatchesInDb(db, request) {
  const normalized = normalizedPermissionRequest(request)
  const grant = getRuntimePluginPermissionGrantFromDb(db, normalized.id)
  return Boolean(
    grant
    && grant.approvalDigest === normalized.approvalDigest
    && grant.sourceDigest === normalized.sourceDigest
    && permissionsEqual(grant.permissions, normalized.permissions),
  )
}

export function grantRuntimePluginPermissionsInDb(db, { request, now = Date.now() }) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required')
  const { id, approvalDigest, sourceDigest, permissions } = normalizedPermissionRequest(request)
  const ownerId = currentLocalOwnerId(db, { required: true })
  const timestamp = normalizeTimestamp(now, 'now')
  const existing = getRuntimePluginPermissionGrantFromDb(db, id)
  const sameGrant = existing
    && existing.approvalDigest === approvalDigest
    && existing.sourceDigest === sourceDigest
    && permissionsEqual(existing.permissions, permissions)
  const grantedAt = sameGrant ? existing.grantedAt : timestamp
  db.prepare(`
    INSERT INTO runtime_plugin_permission_grants (
      plugin_id, owner_id, approval_digest, source_digest,
      permissions_json, granted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      approval_digest = excluded.approval_digest,
      source_digest = excluded.source_digest,
      permissions_json = excluded.permissions_json,
      granted_at = excluded.granted_at,
      updated_at = excluded.updated_at
  `).run(
    id,
    ownerId,
    approvalDigest,
    sourceDigest,
    JSON.stringify(permissions),
    grantedAt,
    timestamp,
  )
  return getRuntimePluginPermissionGrantFromDb(db, id)
}

export function grantRuntimePluginPermissions({ request, now = Date.now() }) {
  return grantRuntimePluginPermissionsInDb(getDb(), { request, now })
}

export function runtimePluginPermissionGrantMatches(request) {
  return runtimePluginPermissionGrantMatchesInDb(getDb(), request)
}

export function revokeRuntimePluginPermissionGrant(pluginId) {
  const id = normalizePluginId(pluginId)
  // Revocation is installation/plugin-scoped so a dormant prior-owner grant
  // cannot become effective again if the fixed local owner is switched back.
  return getDb().prepare(
    'DELETE FROM runtime_plugin_permission_grants WHERE plugin_id = ?',
  ).run(id).changes === 1
}
