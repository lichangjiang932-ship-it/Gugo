import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/
const REDACTED_VALUE = '••••••'

function encode(value) {
  return Buffer.from(JSON.stringify(value ?? {}), 'utf8').toString('base64')
}

function decode(value, fallback = {}) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'))
  } catch {
    return fallback
  }
}

function parseModels(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100)
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  let url
  try { url = new URL(raw) } catch { throw new Error('Base URL 必须是有效的 http/https 地址') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 仅支持 http/https')
  return raw
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, headerValue] of Object.entries(value)) {
    const name = String(key || '').trim()
    if (!name || /[\r\n]/.test(name)) continue
    out[name] = String(headerValue ?? '')
  }
  return out
}

function mapRow(row, { includeSecrets = false } = {}) {
  if (!row) return null
  let models
  try { models = JSON.parse(row.models_json || '[]') } catch { models = [] }
  const secret = decode(row.secret_json)
  const headers = decode(row.headers_json)
  return {
    id: row.id,
    key: row.provider_key,
    label: row.label,
    baseUrl: row.base_url,
    models,
    defaultModel: row.default_model,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    hasApiKey: !!secret.apiKey,
    headers: includeSecrets ? headers : Object.fromEntries(Object.keys(headers).map((key) => [key, REDACTED_VALUE])),
    ...(includeSecrets ? { apiKey: secret.apiKey || '' } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getRow(userId, id) {
  if (!userId || !id) return null
  return getDb().prepare('SELECT * FROM model_providers WHERE user_id = ? AND id = ?').get(userId, id) || null
}

export function listModelProviders({ userId, includeSecrets = false } = {}) {
  if (!userId) return []
  return getDb()
    .prepare('SELECT * FROM model_providers WHERE user_id = ? ORDER BY is_default DESC, label, provider_key')
    .all(userId)
    .map((row) => mapRow(row, { includeSecrets }))
}

export function getModelProvider({ userId, id, includeSecrets = false } = {}) {
  return mapRow(getRow(userId, id), { includeSecrets })
}

export function upsertModelProvider({ userId, provider = {} } = {}) {
  if (!userId) throw new Error('userId required')
  const key = String(provider.key || '').trim().toLowerCase()
  if (!PROVIDER_KEY_RE.test(key)) throw new Error('Provider ID 需以字母开头，只能包含小写字母、数字、_、-')
  const label = String(provider.label || key).trim().slice(0, 80)
  if (!label) throw new Error('Provider 名称不能为空')
  const baseUrl = normalizeBaseUrl(provider.baseUrl)
  const models = parseModels(provider.models)
  if (!models.length) throw new Error('至少配置一个模型名称')
  const defaultModel = String(provider.defaultModel || models[0]).trim()
  if (!models.includes(defaultModel)) throw new Error('默认模型必须在模型列表中')

  const db = getDb()
  const existing = provider.id ? getRow(userId, provider.id) : null
  const sameKey = db.prepare('SELECT * FROM model_providers WHERE user_id = ? AND provider_key = ?').get(userId, key)
  if (sameKey && sameKey.id !== existing?.id) throw new Error(`Provider ID ${key} 已存在`)
  const previousSecret = existing ? decode(existing.secret_json) : {}
  const previousHeaders = existing ? decode(existing.headers_json) : {}
  const apiKey = String(provider.apiKey || '').trim() || previousSecret.apiKey || ''
  const submittedHeaders = provider.headers === undefined ? previousHeaders : normalizeHeaders(provider.headers)
  const headers = Object.fromEntries(Object.entries(submittedHeaders).map(([name, value]) => [
    name,
    value === REDACTED_VALUE && Object.hasOwn(previousHeaders, name) ? previousHeaders[name] : value,
  ]))
  const id = existing?.id || randomUUID()
  const now = Date.now()
  const enabled = provider.enabled !== false
  const isDefault = provider.isDefault === true || !db.prepare('SELECT 1 FROM model_providers WHERE user_id = ? LIMIT 1').get(userId)

  const tx = db.transaction(() => {
    if (isDefault) db.prepare('UPDATE model_providers SET is_default = 0 WHERE user_id = ?').run(userId)
    if (existing) {
      db.prepare(`UPDATE model_providers SET provider_key=?, label=?, base_url=?, secret_json=?, headers_json=?,
        models_json=?, default_model=?, enabled=?, is_default=?, updated_at=? WHERE id=? AND user_id=?`).run(
        key, label, baseUrl, encode({ apiKey }), encode(headers), JSON.stringify(models), defaultModel,
        enabled ? 1 : 0, isDefault ? 1 : 0, now, id, userId,
      )
    } else {
      db.prepare(`INSERT INTO model_providers
        (id,user_id,provider_key,label,base_url,secret_json,headers_json,models_json,default_model,enabled,is_default,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, userId, key, label, baseUrl, encode({ apiKey }), encode(headers), JSON.stringify(models),
        defaultModel, enabled ? 1 : 0, isDefault ? 1 : 0, now, now,
      )
    }
  })
  tx()
  return getModelProvider({ userId, id })
}

export function deleteModelProvider({ userId, id } = {}) {
  if (!userId || !id) return false
  const db = getDb()
  const row = getRow(userId, id)
  if (!row) return false
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM model_providers WHERE user_id = ? AND id = ?').run(userId, id)
    if (row.is_default) {
      const next = db.prepare('SELECT id FROM model_providers WHERE user_id = ? ORDER BY enabled DESC, created_at LIMIT 1').get(userId)
      if (next) db.prepare('UPDATE model_providers SET is_default = 1 WHERE id = ? AND user_id = ?').run(next.id, userId)
    }
  })
  tx()
  return true
}

function envPrefix(key) {
  return `MODEL_PROVIDER_${String(key).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

export function buildUserModelEnv({ userId, env = process.env } = {}) {
  if (!userId) return env
  const providers = listModelProviders({ userId, includeSecrets: true }).filter((provider) => provider.enabled)
  if (!providers.length) return env
  const next = { ...env }
  const envIds = String(env.MODEL_PROVIDERS || '').split(',').map((item) => item.trim()).filter(Boolean)
  next.MODEL_PROVIDERS = [...new Set([...providers.map((provider) => provider.key), ...envIds])].join(',')
  for (const provider of providers) {
    const prefix = envPrefix(provider.key)
    next[`${prefix}_BASE_URL`] = provider.baseUrl
    next[`${prefix}_API_KEY`] = provider.apiKey
    next[`${prefix}_MODELS`] = provider.models.join(',')
    if (Object.keys(provider.headers || {}).length) next[`${prefix}_HEADERS`] = JSON.stringify(provider.headers)
  }
  const preferred = providers.find((provider) => provider.isDefault) || providers[0]
  next.MODEL_NAME = preferred.defaultModel
  next.MODEL_NAMES = providers.flatMap((provider) => provider.models).join(',')
  return next
}
