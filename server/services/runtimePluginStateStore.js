import { getDb } from '../db.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const LAST_ERROR_LIMIT = 2_000

function normalizePluginId(value) {
  const pluginId = String(value || '').trim()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new TypeError('pluginId must match [a-z0-9][a-z0-9-]* and be at most 80 characters')
  }
  return pluginId
}

function normalizeError(value) {
  const text = String(value || '').trim()
  return text ? text.slice(0, LAST_ERROR_LIMIT) : null
}

function publicState(row) {
  if (!row) return null
  return {
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    lastError: row.last_error || null,
    updatedAt: Number(row.updated_at) || 0,
  }
}

export function listRuntimePluginStates() {
  return getDb().prepare(`
    SELECT plugin_id, enabled, last_error, updated_at
    FROM runtime_plugin_states
    ORDER BY plugin_id ASC
  `).all().map(publicState)
}

export function getRuntimePluginState(pluginId) {
  const id = normalizePluginId(pluginId)
  return publicState(getDb().prepare(`
    SELECT plugin_id, enabled, last_error, updated_at
    FROM runtime_plugin_states
    WHERE plugin_id = ?
  `).get(id))
}

export function setRuntimePluginState({ pluginId, enabled, lastError = null, now = Date.now() }) {
  const id = normalizePluginId(pluginId)
  const timestamp = Number(now)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('now must be a non-negative safe integer')
  }
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
  const current = getRuntimePluginState(id)
  return setRuntimePluginState({
    pluginId: id,
    enabled: current?.enabled === true,
    lastError: error,
    now,
  })
}
