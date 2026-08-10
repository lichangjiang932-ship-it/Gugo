import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const SECRET_PURPOSE = 'web-search-secret'
const CONFIG_VERSION = 2
const DEFAULT_STRATEGY = 'fallback'

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readSecret(row) {
  if (!row) return {}
  const decoded = openCredentialObject(row.secret_json, {
    purpose: SECRET_PURPOSE,
    legacyDecoder: parseObject,
  })
  if (decoded.legacy && Object.keys(decoded.value).length) {
    getDb().prepare('UPDATE web_search_configs SET secret_json = ? WHERE user_id = ?')
      .run(sealCredentialObject(decoded.value, { purpose: SECRET_PURPOSE }), row.user_id)
  }
  return decoded.value
}

function connectionId(value, index = 0) {
  const candidate = String(value || '').trim()
  return candidate || (index === 0 ? 'primary' : `connection-${index + 1}`)
}

function storedConfig(row) {
  const parsed = parseObject(row?.config_json)
  if (Array.isArray(parsed.connections)) {
    return {
      version: CONFIG_VERSION,
      strategy: parsed.strategy === 'fallback' ? parsed.strategy : DEFAULT_STRATEGY,
      connections: parsed.connections.map((item, index) => ({
        id: connectionId(item?.id, index),
        provider: String(item?.provider || '').trim(),
        enabled: item?.enabled !== false,
        config: item?.config && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : {},
      })),
    }
  }
  if (!row) return { version: CONFIG_VERSION, strategy: DEFAULT_STRATEGY, connections: [] }
  return {
    version: CONFIG_VERSION,
    strategy: DEFAULT_STRATEGY,
    connections: [{
      id: 'primary',
      provider: row.provider,
      enabled: true,
      config: parsed,
    }],
  }
}

function apiKeyMap(secret, connections) {
  const stored = secret?.apiKeys && typeof secret.apiKeys === 'object' && !Array.isArray(secret.apiKeys)
    ? secret.apiKeys
    : {}
  const result = {}
  connections.forEach((connection, index) => {
    const value = String(stored[connection.id] || (index === 0 ? secret?.apiKey : '') || '').trim()
    if (value) result[connection.id] = value
  })
  return result
}

function publicConfig(row) {
  if (!row) return null
  const stored = storedConfig(row)
  const keys = apiKeyMap(readSecret(row), stored.connections)
  const connections = stored.connections.map((connection) => ({
    ...connection,
    apiKeyPresent: Boolean(keys[connection.id]),
  }))
  const primary = connections[0] || null
  return {
    version: CONFIG_VERSION,
    enabled: row.enabled === 1,
    strategy: stored.strategy,
    connections,
    // Legacy aliases keep old clients and integrations working during rollout.
    provider: primary?.provider || row.provider,
    config: primary?.config || {},
    apiKeyPresent: Boolean(primary?.apiKeyPresent),
    lastTest: row.last_test_at ? {
      at: row.last_test_at,
      ok: row.last_test_ok === 1,
      message: row.last_test_message || '',
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function findRow(userId) {
  if (!userId) return null
  return getDb().prepare('SELECT * FROM web_search_configs WHERE user_id = ?').get(userId) || null
}

export function getWebSearchConfig({ userId } = {}) {
  return publicConfig(findRow(userId))
}

export function getWebSearchCredentials({ userId } = {}) {
  const row = findRow(userId)
  if (!row) return null
  const config = publicConfig(row)
  const keys = apiKeyMap(readSecret(row), config.connections)
  const connections = config.connections.map((connection) => ({
    ...connection,
    secret: { apiKey: keys[connection.id] || '' },
  }))
  return {
    ...config,
    connections,
    secret: { apiKey: connections[0]?.secret.apiKey || '' },
  }
}

export function saveWebSearchConfigs({ userId, enabled = true, strategy = DEFAULT_STRATEGY, connections = [] } = {}) {
  if (!userId) throw Object.assign(new Error('userId required'), { code: 'WEB_SEARCH_USER_REQUIRED', statusCode: 400 })
  const now = Date.now()
  const existing = findRow(userId)
  const previous = existing ? getWebSearchCredentials({ userId }) : null
  const previousById = new Map((previous?.connections || []).map((item) => [item.id, item]))
  const normalizedConnections = connections.map((item, index) => ({
    id: connectionId(item?.id, index),
    provider: String(item?.provider || '').trim(),
    enabled: item?.enabled !== false,
    config: item?.config && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : {},
  }))
  const apiKeys = {}
  connections.forEach((item, index) => {
    const normalized = normalizedConnections[index]
    const previousConnection = previousById.get(normalized.id)
    const explicit = Object.hasOwn(item || {}, 'apiKey')
    const key = explicit
      ? String(item.apiKey || '').trim()
      : (previousConnection?.provider === normalized.provider ? previousConnection.secret?.apiKey : '')
    if (key) apiKeys[normalized.id] = key
  })
  const sealed = sealCredentialObject({ apiKeys }, { purpose: SECRET_PURPOSE })
  const configJson = JSON.stringify({
    version: CONFIG_VERSION,
    strategy: strategy === 'fallback' ? strategy : DEFAULT_STRATEGY,
    connections: normalizedConnections,
  })
  const primaryProvider = normalizedConnections[0]?.provider || existing?.provider || 'tavily'
  if (existing) {
    getDb().prepare(`UPDATE web_search_configs
      SET provider = ?, enabled = ?, config_json = ?, secret_json = ?, last_test_at = NULL,
          last_test_ok = NULL, last_test_message = NULL, updated_at = ?
      WHERE user_id = ?`).run(primaryProvider, enabled ? 1 : 0, configJson, sealed, now, userId)
  } else {
    getDb().prepare(`INSERT INTO web_search_configs
      (user_id, provider, enabled, config_json, secret_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      userId, primaryProvider, enabled ? 1 : 0, configJson, sealed, now, now,
    )
  }
  return getWebSearchConfig({ userId })
}

export function saveWebSearchConfig({ userId, provider, enabled = true, config = {}, apiKey } = {}) {
  const existing = getWebSearchConfig({ userId })
  const id = existing?.connections?.[0]?.id || 'primary'
  return saveWebSearchConfigs({
    userId,
    enabled,
    connections: [{
      id,
      provider,
      enabled: true,
      config,
      ...(apiKey !== undefined ? { apiKey } : {}),
    }],
  })
}

export function recordWebSearchTest({ userId, ok, message = '' } = {}) {
  getDb().prepare(`UPDATE web_search_configs
    SET last_test_at = ?, last_test_ok = ?, last_test_message = ?, updated_at = ?
    WHERE user_id = ?`).run(Date.now(), ok ? 1 : 0, String(message || '').slice(0, 500), Date.now(), userId)
  return getWebSearchConfig({ userId })
}

export function deleteWebSearchConfig({ userId } = {}) {
  if (!userId) return false
  return getDb().prepare('DELETE FROM web_search_configs WHERE user_id = ?').run(userId).changes > 0
}
