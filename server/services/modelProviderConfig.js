import { parseOptionalModelProviderInteger } from '../../shared/modelProviderNumericConfig.js'

export const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
export const REDACTED_VALUE = '••••••'
const PROVIDER_READINESS_MODES = new Set(['agent', 'chat_only', 'unavailable'])

export function parseModels(value) {
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

function modelProviderNumericFieldError(field, result) {
  return Object.assign(new TypeError(`Invalid model Provider numeric field: ${field}`), {
    code: 'MODEL_PROVIDER_NUMERIC_FIELD_INVALID',
    statusCode: 400,
    field,
    reason: result.reason,
    min: result.min,
    max: result.max,
  })
}

export function parseSubmittedModelProviderInteger(value, numericField, fieldPath = numericField) {
  const result = parseOptionalModelProviderInteger(value, numericField)
  if (!result.valid) throw modelProviderNumericFieldError(fieldPath, result)
  return result.value
}

export function normalizeModelProfiles(value, allowedModels = [], { strictNumeric = false } = {}) {
  const input = parseJsonObject(value)
  const allowed = new Set(parseModels(allowedModels))
  const output = {}
  for (const [rawName, rawProfile] of Object.entries(input)) {
    const name = String(rawName || '').trim()
    if (!name || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue
    const profile = {}
    const normalizeNumeric = (field, legacyField) => {
      const value = rawProfile[field] ?? rawProfile[legacyField]
      if (!strictNumeric || (!Object.hasOwn(rawProfile, field) && !Object.hasOwn(rawProfile, legacyField))) {
        return writeNullableInt(value)
      }
      return parseSubmittedModelProviderInteger(value, field, `modelProfiles.${name}.${field}`)
    }
    const contextWindow = normalizeNumeric('contextWindow', 'context_window')
    const maxOutputTokens = normalizeNumeric('maxOutputTokens', 'max_output_tokens')
    if (allowed.size && !allowed.has(name)) continue
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

function baseUrlError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400, field: 'baseUrl' })
}

function hasUrlUserInfo(input) {
  const schemeEnd = input.indexOf('://')
  if (schemeEnd < 0) return false
  const authority = input.slice(schemeEnd + 3).split(/[/?#]/, 1)[0]
  return authority.includes('@')
}

export function normalizeModelProviderBaseUrl(value) {
  const input = String(value || '').trim()
  if (!input) {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_REQUIRED', 'Base URL 不能为空')
  }
  let url
  try {
    url = new URL(input)
  } catch {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_INVALID', 'Base URL 必须是有效的 http/https 地址')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_PROTOCOL', 'Base URL 仅支持 http/https')
  }
  if (url.username || url.password || hasUrlUserInfo(input)) {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_CREDENTIALS', 'Base URL 不能包含用户名或密码；请使用 API Key 或自定义 Header')
  }
  if (input.includes('?') || url.search) {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_QUERY', 'Base URL 不能包含查询参数；请将令牌放入 API Key 或自定义 Header')
  }
  if (input.includes('#') || url.hash) {
    throw baseUrlError('MODEL_PROVIDER_BASE_URL_FRAGMENT', 'Base URL 不能包含片段（#...）')
  }
  return input.replace(/\/+$/, '')
}

export function modelProviderHeaderError(code, message, field) {
  return Object.assign(new Error(message), { code, statusCode: 400, field })
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  let prototype
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return false
  }
  return prototype === Object.prototype || prototype === null
}

export function normalizeModelProviderHeaders(value, { field = 'headers' } = {}) {
  if (!isPlainObject(value)) {
    throw modelProviderHeaderError(
      'MODEL_PROVIDER_HEADERS_TYPE_INVALID',
      '自定义 Header 必须是普通对象',
      field,
    )
  }

  let entries
  let symbolKeys
  try {
    entries = Object.entries(value)
    symbolKeys = Object.getOwnPropertySymbols(value)
  } catch {
    throw modelProviderHeaderError(
      'MODEL_PROVIDER_HEADER_VALUE_INVALID',
      '自定义 Header 值无法安全读取',
      field,
    )
  }
  if (symbolKeys.length) {
    throw modelProviderHeaderError(
      'MODEL_PROVIDER_HEADER_NAME_INVALID',
      '自定义 Header 名称必须是合法的 HTTP Header token',
      field,
    )
  }

  const normalized = []
  for (const [key, headerValue] of entries) {
    const name = String(key).trim()
    if (!HEADER_NAME_RE.test(name)) {
      throw modelProviderHeaderError(
        'MODEL_PROVIDER_HEADER_NAME_INVALID',
        '自定义 Header 名称必须是合法的 HTTP Header token',
        field,
      )
    }
    let stringValue
    try {
      stringValue = String(headerValue ?? '')
    } catch {
      throw modelProviderHeaderError(
        'MODEL_PROVIDER_HEADER_VALUE_INVALID',
        '自定义 Header 值必须能安全转换为字符串',
        field,
      )
    }
    if (/[\r\n]/.test(stringValue)) {
      throw modelProviderHeaderError(
        'MODEL_PROVIDER_HEADER_VALUE_INVALID',
        '自定义 Header 值不能包含换行符',
        field,
      )
    }
    normalized.push([name, stringValue])
  }
  return Object.fromEntries(normalized)
}

export function normalizeModelProviderHeaderRemovalKeys(value, { field = 'removeHeaderKeys' } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw modelProviderHeaderError(
      'MODEL_PROVIDER_HEADERS_TYPE_INVALID',
      '待删除的自定义 Header 名称必须是字符串数组',
      field,
    )
  }
  const seen = new Set()
  const normalized = []
  for (const rawName of value) {
    const name = rawName.trim()
    if (!HEADER_NAME_RE.test(name)) {
      throw modelProviderHeaderError(
        'MODEL_PROVIDER_HEADER_NAME_INVALID',
        '待删除的自定义 Header 名称必须是合法的 HTTP Header token',
        field,
      )
    }
    const identity = name.toLowerCase()
    if (seen.has(identity)) continue
    seen.add(identity)
    normalized.push(name)
  }
  return normalized
}

export function removeModelProviderHeaders(headers, removeHeaderKeys) {
  const removals = new Set(removeHeaderKeys.map((name) => name.toLowerCase()))
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => (
    !removals.has(name.toLowerCase())
  )))
}

export function positiveInteger(value, fallback = 1) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

export function providerRevisionConflict({
  id,
  expectedConfigRevision,
  actualConfigRevision,
  required = false,
} = {}) {
  return Object.assign(
    new Error(required
      ? '更新模型 Provider 时必须携带当前配置版本；请刷新后重试。'
      : 'Provider 配置已被其他请求更新；本次保存未生效，请刷新后重试。'),
    {
      code: required
        ? 'MODEL_PROVIDER_CONFIG_REVISION_REQUIRED'
        : 'MODEL_PROVIDER_CONFIG_CHANGED',
      statusCode: 409,
      action: 'reload_model_provider',
      providerId: id || null,
      details: {
        expectedConfigRevision: expectedConfigRevision ?? null,
        actualConfigRevision: actualConfigRevision ?? null,
      },
    },
  )
}

export function expectedProviderRevision(provider, existing) {
  const raw = provider?.expectedConfigRevision ?? provider?.configRevision
  if (raw === null || raw === undefined || raw === '') {
    throw providerRevisionConflict({
      id: existing?.id || provider?.id,
      actualConfigRevision: positiveInteger(existing?.config_revision, 0) || null,
      required: true,
    })
  }
  const expectedConfigRevision = Number(raw)
  if (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision <= 0) {
    throw Object.assign(new TypeError('Provider 配置版本必须是正安全整数'), {
      code: 'MODEL_PROVIDER_CONFIG_REVISION_INVALID',
      statusCode: 400,
      field: 'configRevision',
    })
  }
  const actualConfigRevision = positiveInteger(existing?.config_revision, 0)
  if (!actualConfigRevision || expectedConfigRevision !== actualConfigRevision) {
    throw providerRevisionConflict({
      id: existing?.id || provider?.id,
      expectedConfigRevision,
      actualConfigRevision: actualConfigRevision || null,
    })
  }
  return expectedConfigRevision
}

export function normalizeReadinessEntry(value, configRevision) {
  const input = parseJsonObject(value)
  const revision = positiveInteger(input.configRevision, 0)
  const checkedAt = Number(input.checkedAt)
  if (revision !== configRevision || !Number.isFinite(checkedAt) || checkedAt <= 0) return null
  const chat = input.chat === true
  const tools = input.tools === true
  const agent = input.agent === true && chat && tools
  const inferredMode = agent ? 'agent' : chat ? 'chat_only' : 'unavailable'
  const mode = PROVIDER_READINESS_MODES.has(input.mode) && input.mode === inferredMode
    ? input.mode
    : inferredMode
  const errorCode = String(input.errorCode || '').trim().slice(0, 120)
  return {
    chat,
    tools,
    agent,
    mode,
    checkedAt: Math.floor(checkedAt),
    configRevision,
    ...(errorCode ? { errorCode } : {}),
  }
}

export function normalizeProviderReadiness(value, configRevision, { models = [], defaultModel = '' } = {}) {
  const input = parseJsonObject(value)
  const allowedModels = parseModels(models)
  const allowed = new Set(allowedModels)
  const selectedDefault = String(defaultModel || '').trim()
  const storedRevision = positiveInteger(input.configRevision, 0)
  const storedMap = parseJsonObject(input.models ?? input.modelReadiness)
  const entries = []

  if (storedRevision === configRevision && Object.keys(storedMap).length) {
    for (const modelName of allowedModels) {
      const readiness = normalizeReadinessEntry(storedMap[modelName], configRevision)
      if (readiness) entries.push([modelName, readiness])
    }
  } else {
    // v70 stored one provider-wide readiness object. Its probe always targeted
    // the then-current default model, so it is safe to preserve only for that
    // model; copying it to every catalog entry would overstate readiness.
    const legacy = normalizeReadinessEntry(input, configRevision)
    if (legacy && allowed.has(selectedDefault)) entries.push([selectedDefault, legacy])
  }

  const modelReadiness = Object.fromEntries(entries)
  return {
    readiness: modelReadiness[selectedDefault] || null,
    modelReadiness,
  }
}

/** DB 里的 INTEGER 三态列 ↔ JS 的 true/false/null。NULL = 未设置,走自动推断。 */
export function readTribool(value) {
  if (value === null || value === undefined) return null
  return Number(value) !== 0
}

export function writeTribool(value) {
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

export const VALID_KINDS = new Set([
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'anthropic',
  'gemini',
  'openai-compatible',
])

export function envPrefix(key) {
  return `MODEL_PROVIDER_${String(key).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** Collect non-empty per-provider capabilities into one runtime JSON value. */
export function buildProviderOverrides(provider) {
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
