import { parseOptionalModelProviderInteger } from '../../../shared/modelProviderNumericConfig.js'

const CAPS = {
  tools: { supportsTools: '1', supportsStreaming: '1', supportsVision: '1', supportsPdf: '0' },
  toolsVision: { supportsTools: '1', supportsStreaming: '1', supportsVision: '1', supportsPdf: '1' },
  toolsText: { supportsTools: '1', supportsStreaming: '1', supportsVision: '0', supportsPdf: '0' },
  local: { supportsTools: '1', supportsStreaming: '1', supportsVision: '0', supportsPdf: '0' },
}

export const LOCAL_PRESETS = Object.freeze([
  { id: 'ollama', key: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'ollama', local: true, caps: CAPS.local },
  { id: 'lm-studio', key: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'lmstudio', local: true, caps: CAPS.local },
  { id: 'llamacpp', key: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', kind: 'llamacpp', local: true, caps: CAPS.local },
  { id: 'vllm', key: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', kind: 'vllm', local: true, caps: CAPS.local },
])

export const CLOUD_PRESETS = Object.freeze([
  { id: 'openai', key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'anthropic', key: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], kind: 'anthropic', caps: CAPS.toolsVision },
  { id: 'gemini', key: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro-preview'], kind: 'gemini', caps: CAPS.toolsVision },
  { id: 'deepseek', key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro'], kind: 'openai-compatible', caps: CAPS.toolsText },
  { id: 'openrouter', key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5.6-sol', 'anthropic/claude-opus-4.8', 'google/gemini-3.1-pro-preview'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'qwen', key: 'qwen', labelKey: 'providerQwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'siliconflow', key: 'siliconflow', labelKey: 'providerSiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-Next-80B-A3B-Instruct', 'moonshotai/Kimi-K2.5'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'moonshot', key: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'moonshot-v1-128k'], legacyModels: ['kimi-k2.5', 'kimi-k2-thinking', 'moonshot-v1-128k'], kind: 'openai-compatible', caps: CAPS.toolsText },
  { id: 'zhipu', key: 'zhipu', labelKey: 'providerZhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5', 'glm-5-flash', 'glm-4.6v'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'xai', key: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', models: ['grok-4.6', 'grok-4.5', 'grok-4.3'], kind: 'openai-compatible', caps: CAPS.tools },
  { id: 'groq', key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'llama-3.3-70b-versatile'], kind: 'openai-compatible', caps: CAPS.toolsText },
  { id: 'mistral', key: 'mistral', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'magistral-medium-latest', 'codestral-latest'], kind: 'openai-compatible', caps: CAPS.toolsVision },
])

export const PROVIDER_PRESETS = Object.freeze([...CLOUD_PRESETS, ...LOCAL_PRESETS])
export const KIND_OPTIONS = ['', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'anthropic', 'gemini', 'openai-compatible']
export const TRIBOOL_VALUES = ['', '1', '0']
const PROVIDER_KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/

export function emptyProvider() {
  return {
    id: '', key: '', label: '', baseUrl: '', apiKey: '', modelsText: '', defaultModel: '', presetId: '',
    headersText: '', enabled: true, isDefault: false, kind: '', contextWindow: '', supportsTools: '',
    supportsStreaming: '', supportsVision: '', supportsPdf: '', firstTokenTimeoutMs: '', idleTimeoutMs: '',
    failoverEnabled: '', keepAlive: '', modelProfiles: {}, clearApiKey: false, savedHeaderKeys: [],
    removedHeaderKeys: [], clearHeaders: false,
  }
}

export function nextCustomProviderKey(providers = []) {
  const usedKeys = new Set((Array.isArray(providers) ? providers : [])
    .map((provider) => String(provider?.key || '').trim().toLowerCase())
    .filter(Boolean))
  if (!usedKeys.has('custom')) return 'custom'
  let suffix = 2
  while (usedKeys.has(`custom-${suffix}`)) suffix += 1
  return `custom-${suffix}`
}

export function providerKeyError(value) {
  const key = String(value || '').trim()
  if (!key) return 'required'
  return PROVIDER_KEY_RE.test(key) ? '' : 'invalid'
}

export function providerLabelError(value) {
  return String(value || '').trim() ? '' : 'required'
}

export function providerModelsError(value) {
  const models = Array.isArray(value) ? value : String(value || '').split(/[\n,]/)
  return models.some((model) => String(model || '').trim()) ? '' : 'required'
}

export function providerHeadersError(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'json'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'type'
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const name = String(rawName || '').trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return 'name'
    let headerValue
    try {
      headerValue = String(rawValue ?? '')
    } catch {
      return 'value'
    }
    if (/[\r\n]/.test(headerValue)) return 'value'
  }
  return ''
}

export function providerHasCredentials(provider) {
  const source = provider && typeof provider === 'object' ? provider : {}
  if (String(source.apiKey || '').trim()) return true
  if (source.hasApiKey === true && source.clearApiKey !== true) return true
  const removedHeaders = new Set((Array.isArray(source.removedHeaderKeys) ? source.removedHeaderKeys : [])
    .map((key) => String(key || '').trim().toLowerCase()).filter(Boolean))
  if (source.clearHeaders !== true && Array.isArray(source.savedHeaderKeys)
    && source.savedHeaderKeys.some((key) => {
      const normalized = String(key || '').trim().toLowerCase()
      return normalized && !removedHeaders.has(normalized)
    })) return true
  const text = String(source.headersText || '').trim()
  if (!text) return false
  try {
    const parsed = JSON.parse(text)
    return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.entries(parsed).some(([key, value]) => (
        String(key || '').trim() && String(value ?? '').trim()
      )))
  } catch {
    return false
  }
}

export function selectToTribool(value) {
  if (value === '') return null
  return value === '1'
}

export function providerNumericFieldError(value, field) {
  const result = parseOptionalModelProviderInteger(value, field)
  return result.valid ? null : result
}

export function numberOrNull(value, field) {
  const result = parseOptionalModelProviderInteger(value, field)
  if (!result.valid) {
    throw Object.assign(new TypeError(`Invalid model Provider numeric field: ${field}`), {
      code: 'MODEL_PROVIDER_NUMERIC_FIELD_INVALID',
      field,
      reason: result.reason,
      min: result.min,
      max: result.max,
    })
  }
  return result.value
}

export function normalizeEditorModelProfiles(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(Object.entries(input).flatMap(([model, rawProfile]) => {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) return []
    const profile = { ...rawProfile }
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      if (!Object.hasOwn(profile, field)) continue
      const parsed = parseOptionalModelProviderInteger(profile[field], field)
      if (!parsed.valid) {
        throw Object.assign(new TypeError(`Invalid model Provider numeric field: modelProfiles.${model}.${field}`), {
          code: 'MODEL_PROVIDER_NUMERIC_FIELD_INVALID',
          field: `modelProfiles.${model}.${field}`,
          reason: parsed.reason,
          min: parsed.min,
          max: parsed.max,
        })
      }
      if (parsed.empty) delete profile[field]
      else profile[field] = parsed.value
    }
    return Object.keys(profile).length ? [[model, profile]] : []
  }))
}

export function resolveProviderDefaultModel(models, requestedModel) {
  const available = Array.isArray(models) ? models : []
  return available.includes(requestedModel) ? requestedModel : (available[0] || '')
}

export function providerBaseUrlError(value) {
  const input = String(value || '').trim()
  if (!input) return 'required'
  let url
  try {
    url = new URL(input)
  } catch {
    return 'invalid'
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'protocol'
  const schemeEnd = input.indexOf('://')
  const authority = schemeEnd < 0 ? '' : input.slice(schemeEnd + 3).split(/[/?#]/, 1)[0]
  if (url.username || url.password || authority.includes('@')) return 'credentials'
  if (input.includes('?') || url.search) return 'query'
  if (input.includes('#') || url.hash) return 'fragment'
  return ''
}

export function mergeDiscoveredModelProfiles(existing, discovered, models = []) {
  const allowed = new Set(models.map((model) => String(model || '').trim()).filter(Boolean))
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  const incoming = discovered && typeof discovered === 'object' && !Array.isArray(discovered) ? discovered : {}
  const merged = {}
  for (const model of allowed) {
    const previous = current[model]
    const next = incoming[model]
    if (previous && typeof previous === 'object' && !Array.isArray(previous)) merged[model] = { ...previous }
    if (next && typeof next === 'object' && !Array.isArray(next)) merged[model] = { ...(merged[model] || {}), ...next }
  }
  return merged
}

function triboolToSelect(value) {
  if (value === null || value === undefined) return ''
  return value ? '1' : '0'
}

export function toEditor(provider) {
  const source = provider && typeof provider === 'object' ? provider : {}
  const { headers, ...safeProvider } = source
  const matchedPreset = PROVIDER_PRESETS.find((preset) => preset.baseUrl === source.baseUrl)
  return {
    ...safeProvider, presetId: matchedPreset?.id || 'custom', apiKey: '', clearApiKey: false, modelsText: (source.models || []).join('\n'),
    headersText: '', savedHeaderKeys: Object.keys(headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {}),
    removedHeaderKeys: [], clearHeaders: false, kind: source.kind || '', contextWindow: source.contextWindow ?? '',
    supportsTools: triboolToSelect(source.supportsTools), supportsStreaming: triboolToSelect(source.supportsStreaming),
    supportsVision: triboolToSelect(source.supportsVision), supportsPdf: triboolToSelect(source.supportsPdf),
    firstTokenTimeoutMs: source.firstTokenTimeoutMs ?? '', idleTimeoutMs: source.idleTimeoutMs ?? '',
    failoverEnabled: triboolToSelect(source.failoverEnabled), keepAlive: source.keepAlive || '',
  }
}

export function findConfiguredPresetProvider(providers, preset) {
  if (!preset) return null
  return (Array.isArray(providers) ? providers : []).find((provider) => provider?.key === preset.key) || null
}

export function formatContextTokens(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return ''
  const millions = num / 1e6
  if (millions >= 1) return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  const thousands = num / 1e3
  return `${Number.isInteger(thousands) ? thousands : Math.round(thousands)}K`
}

export function effectiveUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(url.hostname)
    const path = url.pathname.replace(/\/+$/, '')
    if (isLoopback && (path === '' || path === '/')) {
      url.pathname = '/v1'
      return `${url.toString().replace(/\/+$/, '')}/chat/completions`
    }
    return `${raw}/chat/completions`
  } catch { return raw }
}
