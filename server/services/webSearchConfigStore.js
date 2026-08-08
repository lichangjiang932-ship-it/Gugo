import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const SECRET_PURPOSE = 'web-search-secret'

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

function publicConfig(row) {
  if (!row) return null
  const secret = readSecret(row)
  return {
    provider: row.provider,
    enabled: row.enabled === 1,
    config: parseObject(row.config_json),
    apiKeyPresent: Boolean(secret.apiKey),
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
  return {
    ...publicConfig(row),
    secret: readSecret(row),
  }
}

export function saveWebSearchConfig({ userId, provider, enabled = true, config = {}, apiKey } = {}) {
  if (!userId) throw Object.assign(new Error('userId required'), { code: 'WEB_SEARCH_USER_REQUIRED', statusCode: 400 })
  const now = Date.now()
  const existing = findRow(userId)
  const secret = readSecret(existing)
  if (existing && existing.provider !== provider && apiKey === undefined) delete secret.apiKey
  if (apiKey !== undefined) {
    const normalized = String(apiKey || '').trim()
    if (normalized) secret.apiKey = normalized
    else delete secret.apiKey
  }
  const sealed = sealCredentialObject(secret, { purpose: SECRET_PURPOSE })
  if (existing) {
    getDb().prepare(`UPDATE web_search_configs
      SET provider = ?, enabled = ?, config_json = ?, secret_json = ?, last_test_at = NULL,
          last_test_ok = NULL, last_test_message = NULL, updated_at = ?
      WHERE user_id = ?`).run(provider, enabled ? 1 : 0, JSON.stringify(config), sealed, now, userId)
  } else {
    getDb().prepare(`INSERT INTO web_search_configs
      (user_id, provider, enabled, config_json, secret_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      userId, provider, enabled ? 1 : 0, JSON.stringify(config), sealed, now, now,
    )
  }
  return getWebSearchConfig({ userId })
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
