/**
 * 第三方集成（社交平台 / IM）配置存储 + 测试连接
 *
 * 设计原则：
 *  - 凭据落 DB 不落 .env：每用户每平台一条记录，可随时启停（enabled）
 *  - secret_json 与 config_json 拆开：返回前端时 secret_json 永远脱敏（只暴露存在性）
 *  - testConnection 不做真实推送，只做最低成本的鉴权/连通性探测（如读 bot info）
 */

import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { normalizeProductLanguage } from '../../shared/productLanguage.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'
import {
  BROWSER_CONNECTOR_TOOLS,
  NATIVE_CONNECTOR_TOOLS,
  PROVIDER_REGISTRY,
} from './integrationsProviderRegistry.js'

export { listProviderRegistry } from './integrationsProviderRegistry.js'

const INTEGRATION_SECRET_PURPOSE = 'integration-secret'

function newId() {
  return crypto.randomUUID?.() || `integration-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeIntegrationConfig(provider, config) {
  if (provider !== 'vision_assist') return config
  const normalized = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...config }
    : {}
  normalized.language = normalizeProductLanguage(normalized.language, 'zh')
  return normalized
}

function readIntegrationConfig(row) {
  const stored = parseJson(row?.config_json, {})
  return normalizeIntegrationConfig(row?.provider, stored)
}

function readIntegrationSecret(row) {
  if (!row) return {}
  const decoded = openCredentialObject(row.secret_json, {
    purpose: INTEGRATION_SECRET_PURPOSE,
    legacyDecoder: (raw) => parseJson(raw, {}),
  })
  if (decoded.legacy && row.id && Object.keys(decoded.value).length) {
    getDb().prepare('UPDATE integrations SET secret_json = ? WHERE id = ?')
      .run(sealCredentialObject(decoded.value, { purpose: INTEGRATION_SECRET_PURPOSE }), row.id)
  }
  return decoded.value
}

function writeIntegrationSecret(secret) {
  return sealCredentialObject(secret || {}, { purpose: INTEGRATION_SECRET_PURPOSE })
}

function maskSecret(secret) {
  const out = {}
  for (const [key, val] of Object.entries(secret || {})) {
    if (val == null || val === '') { out[key] = { present: false }; continue }
    const str = String(val)
    if (/password|authorization.?code/i.test(key)) {
      out[key] = { present: true }
      continue
    }
    out[key] = {
      present: true,
      preview: str.length <= 6 ? '*'.repeat(str.length) : `${str.slice(0, 2)}***${str.slice(-2)}`,
    }
  }
  return out
}

function row2integration(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    name: row.name || '',
    enabled: row.enabled === 1,
    config: readIntegrationConfig(row),
    // 仅返回脱敏视图；如需读取真实值请用 getIntegrationSecret
    secret: maskSecret(readIntegrationSecret(row)),
    lastTest: row.last_test_at ? {
      at: row.last_test_at,
      ok: row.last_test_ok === 1,
      message: row.last_test_message || '',
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function row2integrationCredentials(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    name: row.name || '',
    enabled: row.enabled === 1,
    config: readIntegrationConfig(row),
    secret: readIntegrationSecret(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listIntegrations({ userId, kind = null } = {}) {
  if (!userId) return []
  const db = getDb()
  const rows = kind
    ? db.prepare('SELECT * FROM integrations WHERE user_id = ? AND kind = ? ORDER BY updated_at DESC').all(userId, kind)
    : db.prepare('SELECT * FROM integrations WHERE user_id = ? ORDER BY kind, updated_at DESC').all(userId)
  return rows.map(row2integration)
}

/**
 * Return only connector tools backed by an enabled integration for this user.
 * Keeping this lookup next to the provider registry prevents the turn runtime
 * from advertising credentials/capabilities that do not actually exist.
 */
export function listEnabledIntegrationToolNames({ userId } = {}) {
  if (!userId) return []
  const names = new Set()
  for (const integration of listIntegrations({ userId })) {
    if (!integration.enabled) continue
    const nativeTools = NATIVE_CONNECTOR_TOOLS[integration.provider]
    if (nativeTools) {
      for (const name of nativeTools) names.add(name)
      continue
    }
    const meta = PROVIDER_REGISTRY[integration.provider]
    if (integration.provider === 'browser') {
      for (const name of BROWSER_CONNECTOR_TOOLS) names.add(name)
    } else if (meta?.kind === 'browser_app') {
      names.add('connected_app_open')
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en'))
}

export function listEnabledIntegrationCredentials({ kind = 'social' } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM integrations
    WHERE enabled = 1 AND kind = ?
    ORDER BY updated_at DESC
  `).all(kind)
  return rows.map(row2integrationCredentials)
}

export function getIntegrationCredentialsById({ userId, id }) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  return row2integrationCredentials(row)
}

export function getIntegration({ userId, id }) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  return row2integration(row)
}

function findByProvider({ userId, provider }) {
  return getDb().prepare('SELECT * FROM integrations WHERE user_id = ? AND provider = ?').get(userId, provider)
}

function getIntegrationSecretInternal({ userId, id }) {
  const row = getDb().prepare('SELECT id, provider, secret_json, config_json FROM integrations WHERE user_id = ? AND id = ?').get(userId, id)
  if (!row) return null
  return {
    config: readIntegrationConfig(row),
    secret: readIntegrationSecret(row),
  }
}

export function getIntegrationByProvider({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  return row2integration(row)
}

export function isIntegrationEnabled({ userId, provider, defaultEnabled = false }) {
  const row = findByProvider({ userId, provider })
  return row ? row.enabled === 1 : !!defaultEnabled
}

// 给后端服务（不通过 API）读真实凭据：例：调度器拉 enabled=true 的 IM 配置
export function getEnabledIntegrationCredentials({ userId, provider }) {
  const row = findByProvider({ userId, provider })
  if (!row || row.enabled !== 1) return null
  return {
    config: readIntegrationConfig(row),
    secret: readIntegrationSecret(row),
  }
}

function mergeSecret(existing = {}, incoming = {}) {
  // 只在 incoming 提供了非空值时覆盖；空字符串 = 用户清空；undefined = 不动
  const merged = { ...existing }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined) continue
    if (value === '' || value === null) {
      delete merged[key]
    } else {
      merged[key] = String(value)
    }
  }
  return merged
}

export function upsertIntegration({ userId, id, provider, name, enabled, config, secret }) {
  if (!userId) throw badRequest('userId required')
  if (!provider || !PROVIDER_REGISTRY[provider]) throw badRequest(`unknown provider: ${provider}`)

  const meta = PROVIDER_REGISTRY[provider]
  const now = Date.now()
  const db = getDb()

  let row = id ? db.prepare('SELECT * FROM integrations WHERE user_id = ? AND id = ?').get(userId, id) : null
  if (!row) {
    row = findByProvider({ userId, provider })
  }

  const nextEnabled = enabled === undefined ? (row ? row.enabled === 1 : true) : !!enabled
  const nextConfig = normalizeIntegrationConfig(
    provider,
    config === undefined ? parseJson(row?.config_json, {}) : (config || {}),
  )
  const existingSecret = readIntegrationSecret(row)
  const nextSecret = mergeSecret(existingSecret, secret || {})
  const nextName = name === undefined ? (row?.name || meta.label) : (name || meta.label)

  if (row) {
    db.prepare(`UPDATE integrations
      SET name = ?, enabled = ?, config_json = ?, secret_json = ?, updated_at = ?
      WHERE id = ?`).run(
      nextName, nextEnabled ? 1 : 0, JSON.stringify(nextConfig), writeIntegrationSecret(nextSecret), now, row.id,
    )
    return getIntegration({ userId, id: row.id })
  }

  const newRowId = id || newId()
  db.prepare(`INSERT INTO integrations
    (id, user_id, kind, provider, name, enabled, config_json, secret_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newRowId, userId, meta.kind, provider, nextName, nextEnabled ? 1 : 0,
    JSON.stringify(nextConfig), writeIntegrationSecret(nextSecret), now, now,
  )
  return getIntegration({ userId, id: newRowId })
}

export function setIntegrationEnabled({ userId, id, enabled }) {
  const integration = getIntegration({ userId, id })
  if (!integration) throw notFound('integration not found')
  getDb().prepare('UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id)
  return getIntegration({ userId, id })
}

export function deleteIntegration({ userId, id }) {
  const integration = getIntegration({ userId, id })
  if (!integration) return false
  getDb().prepare('DELETE FROM integrations WHERE user_id = ? AND id = ?').run(userId, id)
  return true
}

export async function testProviderCredentials({
  provider,
  config = {},
  secret = {},
  fetchImpl = fetch,
  env = process.env,
  mailClient,
  lookup,
}) {
  const meta = PROVIDER_REGISTRY[provider]
  if (!meta) throw badRequest(`unknown provider: ${provider}`)
  return meta.test({ config, secret, fetchImpl, env, mailClient, lookup })
}

export async function testIntegration({ userId, id, fetchImpl = fetch, env = process.env, mailClient, lookup }) {
  const integration = getIntegration({ userId, id })
  if (!integration) throw notFound('integration not found')
  const meta = PROVIDER_REGISTRY[integration.provider]
  if (!meta) throw badRequest(`unknown provider: ${integration.provider}`)

  const creds = getIntegrationSecretInternal({ userId, id })
  let result
  try {
    result = await testProviderCredentials({
      provider: integration.provider,
      config: creds.config,
      secret: creds.secret,
      fetchImpl,
      env,
      mailClient,
      lookup,
    })
  } catch (err) {
    result = { ok: false, message: err?.message || '未知错误' }
  }
  const now = Date.now()
  getDb().prepare(`UPDATE integrations
    SET last_test_at = ?, last_test_ok = ?, last_test_message = ?, updated_at = ?
    WHERE id = ?`).run(now, result.ok ? 1 : 0, String(result.message || '').slice(0, 500), now, id)
  return { ...result, at: now }
}

function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e }
function notFound(message)   { const e = new Error(message); e.statusCode = 404; return e }
