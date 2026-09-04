import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { getDb } from '../db.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'
import {
  MODEL_PROVIDER_RUNTIME_BINDINGS_ENV,
  serializeModelProviderRuntimeBindings,
} from '../utils/modelProviderRuntimeBinding.js'
import {
  buildProviderOverrides,
  envPrefix,
  expectedProviderRevision,
  modelProviderHeaderError,
  normalizeModelProfiles,
  normalizeModelProviderBaseUrl,
  normalizeModelProviderHeaderRemovalKeys,
  normalizeModelProviderHeaders,
  normalizeProviderReadiness,
  normalizeReadinessEntry,
  parseModels,
  positiveInteger,
  PROVIDER_KEY_RE,
  providerRevisionConflict,
  readTribool,
  REDACTED_VALUE,
  removeModelProviderHeaders,
} from './modelProviderConfig.js'
import {
  assertProviderKeyAvailable,
  resolveProviderRuntimeOptions,
} from './modelProviderUpsertSupport.js'

export {
  normalizeModelProviderBaseUrl,
  normalizeModelProviderHeaderRemovalKeys,
  normalizeModelProviderHeaders,
  removeModelProviderHeaders,
}

const MODEL_SECRET_PURPOSE = 'model-provider-secret'
const MODEL_HEADERS_PURPOSE = 'model-provider-headers'
const PROVIDER_REFERENCE_SOURCES = Object.freeze([
  { key: 'jobs', table: 'jobs', column: 'model_provider_id' },
  { key: 'subagentRuns', table: 'subagent_runs', column: 'model_provider_id' },
  { key: 'evolutionCandidates', table: 'evolution_candidates', column: 'generator_provider_id' },
  { key: 'evolutionReplayRuns', table: 'evolution_replay_runs', column: 'model_provider_id' },
  { key: 'evolutionEvaluations', table: 'evolution_evaluations', column: 'evaluator_provider_id' },
])

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
      ? 'UPDATE model_providers SET secret_json = ? WHERE id = ? AND secret_json IS ?'
      : 'UPDATE model_providers SET headers_json = ? WHERE id = ? AND headers_json IS ?'
    // Lazy legacy-envelope migration must not overwrite a credential that was
    // replaced after this row was read. The original column value is its CAS
    // token; a zero-change result simply means another writer already won.
    getDb().prepare(sql).run(
      sealCredentialObject(decoded.value, { purpose }),
      row.id,
      row[column],
    )
  }
  return decoded.value
}

function writeCredential(value, purpose) {
  return sealCredentialObject(value || {}, { purpose })
}

function mapRow(row, { includeSecrets = false } = {}) {
  if (!row) return null
  let models
  try { models = JSON.parse(row.models_json || '[]') } catch { models = [] }
  const secret = readCredentialColumn(row, 'secret_json', MODEL_SECRET_PURPOSE)
  const headers = readCredentialColumn(row, 'headers_json', MODEL_HEADERS_PURPOSE)
  const modelProfiles = normalizeModelProfiles(row.model_profiles_json, models)
  const configRevision = positiveInteger(row.config_revision)
  const { readiness, modelReadiness } = normalizeProviderReadiness(row.readiness_json, configRevision, {
    models,
    defaultModel: row.default_model,
  })
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
    configRevision,
    readiness,
    modelReadiness,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getRow(userId, id) {
  if (!userId || !id) return null
  return getDb().prepare('SELECT * FROM model_providers WHERE user_id = ? AND id = ?').get(userId, id) || null
}

function checkpointProviderDeletionWal(db, phase) {
  let result
  try {
    result = db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (cause) {
    throw Object.assign(
      new Error('模型 Provider 安全删除暂时无法完成，请稍后重试。', { cause }),
      {
        code: 'MODEL_PROVIDER_SECURE_DELETE_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
        phase,
      },
    )
  }
  const row = Array.isArray(result) ? result[0] : result
  const busy = Number(row?.busy || 0)
  if (busy > 0) {
    throw Object.assign(
      new Error('模型 Provider 数据库正在被使用，安全删除尚未完成，请稍后重试。'),
      {
        code: 'MODEL_PROVIDER_SECURE_DELETE_BUSY',
        statusCode: 503,
        retryable: true,
        phase,
      },
    )
  }
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

export function resolveUserModelProvider({ userId, providerId = '', modelName = '', includeSecrets = false } = {}) {
  const providers = listModelProviders({ userId, includeSecrets }).filter((provider) => provider.enabled)
  const requestedProviderId = String(providerId || '').trim()
  const requestedModel = String(modelName || '').trim()
  if (requestedProviderId) {
    // Durable callers persist the UUID. Accepting the user-owned key here keeps
    // selections written by older clients usable, but every returned binding is
    // normalized back to provider.id before it is persisted again.
    // UUID is authoritative: a legacy key is user-controlled and may itself be
    // UUID-shaped, so a combined find could let that key shadow another row's
    // durable id depending on list order.
    const provider = providers.find((item) => item.id === requestedProviderId)
      || providers.find((item) => item.key === requestedProviderId)
    return provider && (!requestedModel || provider.models.includes(requestedModel)) ? provider : null
  }
  if (requestedModel) {
    const matches = providers.filter((provider) => provider.models.includes(requestedModel))
    if (matches.length > 1) {
      throw Object.assign(
        new Error('多个 Provider 提供同名模型，请传入 modelProviderId。'),
        {
          code: 'MODEL_PROVIDER_AMBIGUOUS',
          statusCode: 409,
          action: 'choose_agent_provider',
          providerId: null,
          modelName: requestedModel,
          details: { providerIds: matches.map((provider) => provider.id) },
        },
      )
    }
    return matches[0] || null
  }
  return providers.find((provider) => provider.isDefault) || providers[0] || null
}

export function recordModelProviderReadiness({
  userId,
  id,
  modelName = '',
  readiness = {},
  expectedConfigRevision = null,
  now = Date.now(),
} = {}) {
  const db = getDb()
  let savedRow = null
  const tx = db.transaction(() => {
    const row = getRow(userId, id)
    if (!row) return
    const configRevision = positiveInteger(
      expectedConfigRevision ?? readiness.configRevision ?? row.config_revision,
      0,
    )
    if (!configRevision || positiveInteger(row.config_revision, 0) !== configRevision) return
    let models
    try { models = parseModels(JSON.parse(row.models_json || '[]')) } catch { models = [] }
    const selectedModel = String(modelName || row.default_model || '').trim()
    if (!selectedModel || !models.includes(selectedModel)) {
      throw Object.assign(new Error('测试模型必须属于当前 Provider 的模型列表'), {
        code: 'MODEL_PROVIDER_MODEL_INVALID',
        statusCode: 400,
        field: 'modelName',
      })
    }
    const normalized = normalizeReadinessEntry({
      ...readiness,
      checkedAt: Number.isFinite(Number(readiness.checkedAt)) ? Number(readiness.checkedAt) : now,
      configRevision,
    }, configRevision)
    if (!normalized) throw new Error('Provider readiness 无效')
    const current = normalizeProviderReadiness(row.readiness_json, configRevision, {
      models,
      defaultModel: row.default_model,
    })
    const nextModelReadiness = Object.fromEntries(models.flatMap((name) => {
      if (name === selectedModel) return [[name, normalized]]
      return current.modelReadiness[name] ? [[name, current.modelReadiness[name]]] : []
    }))
    const storedReadiness = {
      version: 2,
      configRevision,
      models: nextModelReadiness,
    }
    const changed = db.prepare(`UPDATE model_providers
      SET readiness_json = ?
      WHERE id = ? AND user_id = ? AND config_revision = ?`).run(
      JSON.stringify(storedReadiness), id, userId, configRevision,
    )
    if (changed.changes > 0) savedRow = getRow(userId, id)
  })
  // Serialize the read/merge/write cycle across SQLite connections. A deferred
  // transaction would let two model probes read the same JSON and lose one
  // model's result when the later writer replaces the document.
  tx.immediate()
  return mapRow(savedRow)
}

function resolveProviderCredentials(provider, existing) {
  const previousSecret = existing
    ? readCredentialColumn(existing, 'secret_json', MODEL_SECRET_PURPOSE)
    : {}
  const previousHeaders = existing
    ? readCredentialColumn(existing, 'headers_json', MODEL_HEADERS_PURPOSE)
    : {}
  const submittedApiKey = String(provider.apiKey || '').trim()
  const clearApiKey = provider.clearApiKey === true
  if (clearApiKey && submittedApiKey) throw new Error('清除 API Key 时不能同时提交新 Key')
  const apiKey = clearApiKey ? '' : (submittedApiKey || previousSecret.apiKey || '')
  const replacesHeaders = provider.headers !== undefined
  const patchesHeaders = provider.headerUpdates !== undefined
  const removesHeaders = Object.hasOwn(provider, 'removeHeaderKeys')
  if (replacesHeaders && patchesHeaders) throw new Error('不能同时替换和增量更新自定义 Header')
  if (replacesHeaders && removesHeaders) {
    throw modelProviderHeaderError(
      'MODEL_PROVIDER_HEADERS_CONFLICT',
      '不能同时整包替换和单项删除自定义 Header',
      'removeHeaderKeys',
    )
  }
  const removeHeaderKeys = removesHeaders
    ? normalizeModelProviderHeaderRemovalKeys(provider.removeHeaderKeys)
    : []
  const retainedHeaders = removesHeaders
    ? removeModelProviderHeaders(previousHeaders, removeHeaderKeys)
    : previousHeaders
  const submittedHeaders = replacesHeaders
    ? normalizeModelProviderHeaders(provider.headers, { field: 'headers' })
    : patchesHeaders
      ? { ...retainedHeaders, ...normalizeModelProviderHeaders(provider.headerUpdates, { field: 'headerUpdates' }) }
      : retainedHeaders
  const headers = Object.fromEntries(Object.entries(submittedHeaders).map(([name, value]) => [
    name,
    value === REDACTED_VALUE && Object.hasOwn(previousHeaders, name) ? previousHeaders[name] : value,
  ]))
  return { apiKey, headers, previousSecret, previousHeaders }
}

export function upsertModelProvider({ userId, provider = {}, env = process.env } = {}) {
  if (!userId) throw new Error('userId required')
  const key = String(provider.key || '').trim().toLowerCase()
  if (!PROVIDER_KEY_RE.test(key)) throw new Error('Provider ID 需以字母开头，只能包含小写字母、数字、_、-')
  const label = String(provider.label || key).trim().slice(0, 80)
  if (!label) throw new Error('Provider 名称不能为空')
  const baseUrl = normalizeModelProviderBaseUrl(provider.baseUrl)
  const models = parseModels(provider.models)
  if (!models.length) throw new Error('至少配置一个模型名称')
  const defaultModel = String(provider.defaultModel || models[0]).trim()
  if (!models.includes(defaultModel)) throw new Error('默认模型必须在模型列表中')

  const db = getDb()
  const existing = provider.id ? getRow(userId, provider.id) : null
  if (provider.id && !existing) {
    throw providerRevisionConflict({
      id: provider.id,
      expectedConfigRevision: provider.expectedConfigRevision ?? provider.configRevision ?? null,
      actualConfigRevision: null,
    })
  }
  const expectedConfigRevision = existing ? expectedProviderRevision(provider, existing) : null
  assertProviderKeyAvailable({ db, userId, key, existing, env })
  const { apiKey, headers, previousSecret, previousHeaders } = resolveProviderCredentials(
    provider,
    existing,
  )
  const id = existing?.id || randomUUID()
  const now = Date.now()
  const enabled = provider.enabled !== false
  const isDefault = provider.isDefault === true || !db.prepare('SELECT 1 FROM model_providers WHERE user_id = ? LIMIT 1').get(userId)

  const {
    kindRaw,
    contextWindow,
    supportsTools,
    supportsStreaming,
    supportsVision,
    supportsPdf,
    firstTokenTimeoutMs,
    idleTimeoutMs,
    failoverEnabled,
    keepAlive,
    modelProfiles,
    previousModels,
  } = resolveProviderRuntimeOptions(provider, existing, models)
  const runtimeConfig = {
    key,
    baseUrl,
    apiKey,
    headers,
    models,
    defaultModel,
    enabled: enabled ? 1 : 0,
    kind: kindRaw,
    contextWindow,
    supportsTools,
    supportsStreaming,
    supportsVision,
    supportsPdf,
    firstTokenTimeoutMs,
    idleTimeoutMs,
    failoverEnabled,
    keepAlive,
    modelProfiles,
  }
  const previousRuntimeConfig = existing ? {
    key: existing.provider_key,
    baseUrl: existing.base_url,
    apiKey: previousSecret.apiKey || '',
    headers: previousHeaders,
    models: previousModels,
    defaultModel: existing.default_model,
    enabled: existing.enabled ? 1 : 0,
    kind: existing.kind || null,
    contextWindow: existing.context_window ?? null,
    supportsTools: existing.supports_tools ?? null,
    supportsStreaming: existing.supports_streaming ?? null,
    supportsVision: existing.supports_vision ?? null,
    supportsPdf: existing.supports_pdf ?? null,
    firstTokenTimeoutMs: existing.first_token_timeout_ms ?? null,
    idleTimeoutMs: existing.idle_timeout_ms ?? null,
    failoverEnabled: existing.failover_enabled ?? null,
    keepAlive: existing.keep_alive || null,
    modelProfiles: normalizeModelProfiles(existing.model_profiles_json, previousModels),
  } : null
  const runtimeConfigChanged = !existing || !isDeepStrictEqual(previousRuntimeConfig, runtimeConfig)
  const configRevision = existing
    ? positiveInteger(existing.config_revision) + (runtimeConfigChanged ? 1 : 0)
    : 1
  let savedRow = null

  const tx = db.transaction(() => {
    if (isDefault) db.prepare('UPDATE model_providers SET is_default = 0 WHERE user_id = ?').run(userId)
    if (existing) {
      const changed = db.prepare(`UPDATE model_providers SET provider_key=?, label=?, base_url=?, secret_json=?, headers_json=?,
        models_json=?, default_model=?, enabled=?, is_default=?, updated_at=?,
        kind=?, context_window=?, supports_tools=?, supports_streaming=?, supports_vision=?, supports_pdf=?,
        first_token_timeout_ms=?, idle_timeout_ms=?, failover_enabled=?, keep_alive=?, model_profiles_json=?,
        config_revision=?, readiness_json=CASE WHEN ? = 1 THEN NULL ELSE readiness_json END
        WHERE id=? AND user_id=? AND config_revision=?`).run(
        key, label, baseUrl, writeCredential({ apiKey }, MODEL_SECRET_PURPOSE),
        writeCredential(headers, MODEL_HEADERS_PURPOSE), JSON.stringify(models), defaultModel,
        enabled ? 1 : 0, isDefault ? 1 : 0, now,
        kindRaw, contextWindow, supportsTools, supportsStreaming, supportsVision, supportsPdf,
        firstTokenTimeoutMs, idleTimeoutMs, failoverEnabled, keepAlive, JSON.stringify(modelProfiles), configRevision,
        runtimeConfigChanged ? 1 : 0, id, userId, expectedConfigRevision,
      )
      if (changed.changes === 0) {
        const current = getRow(userId, id)
        throw providerRevisionConflict({
          id,
          expectedConfigRevision,
          actualConfigRevision: positiveInteger(current?.config_revision, 0) || null,
        })
      }
    } else {
      db.prepare(`INSERT INTO model_providers
        (id,user_id,provider_key,label,base_url,secret_json,headers_json,models_json,default_model,enabled,is_default,created_at,updated_at,
         kind,context_window,supports_tools,supports_streaming,supports_vision,supports_pdf,first_token_timeout_ms,idle_timeout_ms,failover_enabled,keep_alive,model_profiles_json,
         config_revision,readiness_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, userId, key, label, baseUrl, writeCredential({ apiKey }, MODEL_SECRET_PURPOSE),
        writeCredential(headers, MODEL_HEADERS_PURPOSE), JSON.stringify(models),
        defaultModel, enabled ? 1 : 0, isDefault ? 1 : 0, now, now,
        kindRaw, contextWindow, supportsTools, supportsStreaming, supportsVision, supportsPdf,
        firstTokenTimeoutMs, idleTimeoutMs, failoverEnabled, keepAlive, JSON.stringify(modelProfiles), configRevision, null,
      )
    }
    savedRow = getRow(userId, id)
  })
  tx()
  return mapRow(savedRow)
}

export function deleteModelProvider({ userId, id } = {}) {
  if (!userId || !id) return false
  const db = getDb()
  const row = getRow(userId, id)
  if (!row) return false
  // First fold any historical WAL frames into the main database. The DELETE
  // below runs with secure_delete enabled, and the second checkpoint removes
  // the resulting zeroed/delete frames from the WAL as well.
  db.pragma('secure_delete = ON')
  checkpointProviderDeletionWal(db, 'before_delete')
  const tx = db.transaction(() => {
    const references = {}
    let total = 0
    for (const source of PROVIDER_REFERENCE_SOURCES) {
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(source.table)
      if (!table) continue
      const hasColumns = new Set(db.prepare(`PRAGMA table_info(${source.table})`).all().map((column) => column.name))
      if (!hasColumns.has('user_id') || !hasColumns.has(source.column)) continue
      const count = Number(db.prepare(
        `SELECT COUNT(*) AS count FROM ${source.table} WHERE user_id = ? AND ${source.column} = ?`,
      ).get(userId, id)?.count || 0)
      if (count <= 0) continue
      references[source.key] = count
      total += count
    }
    if (total > 0) {
      throw Object.assign(
        new Error(`该模型 Provider 仍被 ${total} 条任务或运行记录引用，请先清理相关记录。`),
        {
          code: 'MODEL_PROVIDER_IN_USE',
          statusCode: 409,
          action: 'clear_provider_references',
          providerId: id,
          details: { total, references },
        },
      )
    }
    db.prepare('DELETE FROM model_providers WHERE user_id = ? AND id = ?').run(userId, id)
    if (row.is_default) {
      const next = db.prepare('SELECT id FROM model_providers WHERE user_id = ? ORDER BY enabled DESC, created_at LIMIT 1').get(userId)
      if (next) db.prepare('UPDATE model_providers SET is_default = 1 WHERE id = ? AND user_id = ?').run(next.id, userId)
    }
  })
  tx()
  checkpointProviderDeletionWal(db, 'after_delete')
  return true
}

export function buildUserModelEnv({ userId, env = process.env } = {}) {
  if (!userId) return env
  const providers = listModelProviders({ userId, includeSecrets: true }).filter((provider) => provider.enabled)
  if (!providers.length) return env
  const envIds = String(env.MODEL_PROVIDERS || '').split(',').map((item) => item.trim()).filter(Boolean)
  for (const provider of providers) {
    const conflict = envIds.find((environmentKey) => (
      environmentKey !== provider.key && envPrefix(environmentKey) === envPrefix(provider.key)
    ))
    if (conflict) {
      throw Object.assign(
        new Error(`数据库 Provider ${provider.key} 与环境 Provider ${conflict} 的运行时标识冲突。`),
        {
          code: 'MODEL_PROVIDER_ENV_KEY_COLLISION',
          statusCode: 409,
          providerId: provider.id,
          providerKey: provider.key,
          conflictingProviderKey: conflict,
        },
      )
    }
  }
  const databasePrefixes = new Set(providers.map((provider) => envPrefix(provider.key)))
  const runtimePrefixes = [...new Set([
    ...databasePrefixes,
    ...envIds.map((environmentKey) => envPrefix(environmentKey)),
  ])].sort((left, right) => right.length - left.length)
  // A DB provider owns its complete runtime namespace. Resolve the longest
  // prefix first so `foo` cannot consume the environment provider `foo_bar`.
  const next = Object.fromEntries(Object.entries(env).filter(([name]) => {
    const ownerPrefix = runtimePrefixes.find((prefix) => name.startsWith(`${prefix}_`))
    return !ownerPrefix || !databasePrefixes.has(ownerPrefix)
  }))
  next.MODEL_PROVIDERS = [...new Set([...providers.map((provider) => provider.key), ...envIds])].join(',')
  next[MODEL_PROVIDER_RUNTIME_BINDINGS_ENV] = serializeModelProviderRuntimeBindings(providers)
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
