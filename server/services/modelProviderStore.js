import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/
const REDACTED_VALUE = '••••••'

const MODEL_SECRET_PURPOSE = 'model-provider-secret'
const MODEL_HEADERS_PURPOSE = 'model-provider-headers'

function decodeLegacy(value, fallback = {}) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'))
  } catch {
    return fallback
  }
}

function readCredentialColumn(row, column, purpose) {
  const decoded = openCredentialObject(row?.[column], {
    purpose,
    legacyDecoder: (raw) => decodeLegacy(raw, {}),
  })
  if (decoded.legacy && row?.id && Object.keys(decoded.value).length) {
    const sql = column === 'secret_json'
      ? 'UPDATE model_providers SET secret_json = ? WHERE id = ?'
      : 'UPDATE model_providers SET headers_json = ? WHERE id = ?'
    getDb().prepare(sql).run(sealCredentialObject(decoded.value, { purpose }), row.id)
  }
  return decoded.value
}

function writeCredential(value, purpose) {
  return sealCredentialObject(value || {}, { purpose })
}

function parseModels(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(raw.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100)
}

function parseJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeModelProfiles(value, allowedModels = []) {
  const input = parseJsonObject(value)
  const allowed = new Set(parseModels(allowedModels))
  const output = {}
  for (const [rawName, rawProfile] of Object.entries(input)) {
    const name = String(rawName || '').trim()
    if (!name || (allowed.size && !allowed.has(name)) || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue
    const profile = {}
    const contextWindow = writeNullableInt(rawProfile.contextWindow ?? rawProfile.context_window)
    const maxOutputTokens = writeNullableInt(rawProfile.maxOutputTokens ?? rawProfile.max_output_tokens)
    if (contextWindow) profile.contextWindow = contextWindow
    if (maxOutputTokens) profile.maxOutputTokens = maxOutputTokens
    for (const field of ['supportsTools', 'supportsStreaming', 'supportsVision', 'supportsPdf']) {
      const normalized = writeTribool(rawProfile[field])
      if (normalized !== null) profile[field] = normalized !== 0
    }
    const source = String(rawProfile.source || '').trim().slice(0, 80)
    if (source) profile.source = source
    if (Object.keys(profile).length) output[name] = profile
  }
  return output
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

/** DB 里的 INTEGER 三态列 ↔ JS 的 true/false/null。NULL = 未设置,走自动推断。 */
function readTribool(value) {
  if (value === null || value === undefined) return null
  return Number(value) !== 0
}

function writeTribool(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value ? 1 : 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return 1
  if (['0', 'false', 'no', 'off'].includes(text)) return 0
  return null
}

/** 可空正整数列。留空 = 用 endpointProfile 的默认值。 */
function writeNullableInt(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

const VALID_KINDS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm', 'anthropic', 'gemini', 'openai-compatible'])

function mapRow(row, { includeSecrets = false } = {}) {
  if (!row) return null
  let models
  try { models = JSON.parse(row.models_json || '[]') } catch { models = [] }
  const secret = readCredentialColumn(row, 'secret_json', MODEL_SECRET_PURPOSE)
  const headers = readCredentialColumn(row, 'headers_json', MODEL_HEADERS_PURPOSE)
  const modelProfiles = normalizeModelProfiles(row.model_profiles_json, models)
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
    // ★ v28:per-provider 能力与超时。全部可空,空 = 自动推断(endpointProfile.js)。
    kind: row.kind || null,
    contextWindow: row.context_window ?? null,
    modelProfiles,
    supportsTools: readTribool(row.supports_tools),
    supportsStreaming: readTribool(row.supports_streaming),
    supportsVision: readTribool(row.supports_vision),
    supportsPdf: readTribool(row.supports_pdf),
    firstTokenTimeoutMs: row.first_token_timeout_ms ?? null,
    idleTimeoutMs: row.idle_timeout_ms ?? null,
    failoverEnabled: readTribool(row.failover_enabled),
    keepAlive: row.keep_alive || null,
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
  const previousSecret = existing ? readCredentialColumn(existing, 'secret_json', MODEL_SECRET_PURPOSE) : {}
  const previousHeaders = existing ? readCredentialColumn(existing, 'headers_json', MODEL_HEADERS_PURPOSE) : {}
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

  // ★ v28 能力字段。未提交的字段沿用旧值(而不是清空)——
  // 前端只改一个开关时不该把其它配置一起抹掉。
  const pick = (field, column, writer) => (
    provider[field] === undefined ? (existing?.[column] ?? null) : writer(provider[field])
  )
  const kindRaw = provider.kind === undefined
    ? (existing?.kind ?? null)
    : (VALID_KINDS.has(String(provider.kind)) ? String(provider.kind) : null)
  const contextWindow = pick('contextWindow', 'context_window', writeNullableInt)
  const supportsTools = pick('supportsTools', 'supports_tools', writeTribool)
  const supportsStreaming = pick('supportsStreaming', 'supports_streaming', writeTribool)
  const supportsVision = pick('supportsVision', 'supports_vision', writeTribool)
  const supportsPdf = pick('supportsPdf', 'supports_pdf', writeTribool)
  const firstTokenTimeoutMs = pick('firstTokenTimeoutMs', 'first_token_timeout_ms', writeNullableInt)
  const idleTimeoutMs = pick('idleTimeoutMs', 'idle_timeout_ms', writeNullableInt)
  const failoverEnabled = pick('failoverEnabled', 'failover_enabled', writeTribool)
  const keepAlive = provider.keepAlive === undefined
    ? (existing?.keep_alive ?? null)
    : (String(provider.keepAlive || '').trim() || null)
  const modelProfiles = provider.modelProfiles === undefined
    ? normalizeModelProfiles(existing?.model_profiles_json, models)
    : normalizeModelProfiles(provider.modelProfiles, models)

  const tx = db.transaction(() => {
    if (isDefault) db.prepare('UPDATE model_providers SET is_default = 0 WHERE user_id = ?').run(userId)
    if (existing) {
      db.prepare(`UPDATE model_providers SET provider_key=?, label=?, base_url=?, secret_json=?, headers_json=?,
        models_json=?, default_model=?, enabled=?, is_default=?, updated_at=?,
        kind=?, context_window=?, supports_tools=?, supports_streaming=?, supports_vision=?, supports_pdf=?,
        first_token_timeout_ms=?, idle_timeout_ms=?, failover_enabled=?, keep_alive=?, model_profiles_json=?
        WHERE id=? AND user_id=?`).run(
        key, label, baseUrl, writeCredential({ apiKey }, MODEL_SECRET_PURPOSE),
        writeCredential(headers, MODEL_HEADERS_PURPOSE), JSON.stringify(models), defaultModel,
        enabled ? 1 : 0, isDefault ? 1 : 0, now,
        kindRaw, contextWindow, supportsTools, supportsStreaming, supportsVision, supportsPdf,
        firstTokenTimeoutMs, idleTimeoutMs, failoverEnabled, keepAlive, JSON.stringify(modelProfiles),
        id, userId,
      )
    } else {
      db.prepare(`INSERT INTO model_providers
        (id,user_id,provider_key,label,base_url,secret_json,headers_json,models_json,default_model,enabled,is_default,created_at,updated_at,
         kind,context_window,supports_tools,supports_streaming,supports_vision,supports_pdf,first_token_timeout_ms,idle_timeout_ms,failover_enabled,keep_alive,model_profiles_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, userId, key, label, baseUrl, writeCredential({ apiKey }, MODEL_SECRET_PURPOSE),
        writeCredential(headers, MODEL_HEADERS_PURPOSE), JSON.stringify(models),
        defaultModel, enabled ? 1 : 0, isDefault ? 1 : 0, now, now,
        kindRaw, contextWindow, supportsTools, supportsStreaming, supportsVision, supportsPdf,
        firstTokenTimeoutMs, idleTimeoutMs, failoverEnabled, keepAlive, JSON.stringify(modelProfiles),
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
    next[`${prefix}_LABEL`] = provider.label
    next[`${prefix}_BASE_URL`] = provider.baseUrl
    next[`${prefix}_API_KEY`] = provider.apiKey
    next[`${prefix}_MODELS`] = provider.models.join(',')
    if (Object.keys(provider.headers || {}).length) next[`${prefix}_HEADERS`] = JSON.stringify(provider.headers)
    // ★ v28:把 per-provider 的能力/超时配置也铺进 env。
    // modelProxy 的 profileForConfig 会按 baseUrl 找回来当 overrides 用。
    // 用一个 JSON 串而不是十个变量,避免 env 命名爆炸。
    const overrides = buildProviderOverrides(provider)
    if (overrides) next[`${prefix}_PROFILE`] = overrides
  }
  const preferred = providers.find((provider) => provider.isDefault) || providers[0]
  // 同时提供旧式单 Provider 字段。部分后台/插件调用方仍只识别这三个字段；
  // 保存到数据库的 Provider 必须对它们同样可见，不能逼用户再维护一份 .env。
  next.MODEL_BASE_URL = preferred.baseUrl
  next.MODEL_API_KEY = preferred.apiKey
  next.MODEL_NAME = preferred.defaultModel
  next.MODEL_NAMES = providers.flatMap((provider) => provider.models).join(',')
  return next
}

/**
 * 把 provider 上非空的能力字段收成一个 JSON 串。
 * 全空就返回 null —— 不往 env 里塞没有信息量的 '{}'。
 */
function buildProviderOverrides(provider) {
  const overrides = {}
  if (provider.kind) overrides.kind = provider.kind
  if (provider.contextWindow) overrides.contextWindow = provider.contextWindow
  if (provider.supportsTools !== null) overrides.supportsTools = provider.supportsTools
  if (provider.supportsStreaming !== null) overrides.supportsStreaming = provider.supportsStreaming
  if (provider.supportsVision !== null) overrides.supportsVision = provider.supportsVision
  if (provider.supportsPdf !== null) overrides.supportsPdf = provider.supportsPdf
  if (provider.firstTokenTimeoutMs) overrides.firstTokenTimeoutMs = provider.firstTokenTimeoutMs
  if (provider.idleTimeoutMs) overrides.idleTimeoutMs = provider.idleTimeoutMs
  if (provider.failoverEnabled !== null) overrides.failoverEnabled = provider.failoverEnabled
  if (provider.keepAlive) overrides.keepAlive = provider.keepAlive
  if (provider.modelProfiles && Object.keys(provider.modelProfiles).length) overrides.models = provider.modelProfiles
  return Object.keys(overrides).length ? JSON.stringify(overrides) : null
}
