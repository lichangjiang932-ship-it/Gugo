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

/**
 * Base URLs for catalogue-only OpenAI-compatible providers, so picking one does
 * not start with an empty box.
 *
 * Only ids whose documented OpenAI-compatible endpoint is stable are listed. The
 * rest (Bedrock, Vertex, GitHub Copilot and similar) use provider-specific
 * authentication and are deliberately absent: guessing an endpoint would be
 * worse than asking the reader for the one they actually use.
 */
export const CATALOG_BASE_URLS = Object.freeze({
  cerebras: 'https://api.cerebras.ai/v1',
  baseten: 'https://inference.baseten.co/v1',
  'minimax-cn': 'https://api.minimaxi.com/v1',
  minimax: 'https://api.minimax.io/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  togetherai: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
  novita: 'https://api.novita.ai/v3/openai',
  'novita-ai': 'https://api.novita.ai/v3/openai',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  nebius: 'https://api.studio.nebius.com/v1',
  scaleway: 'https://api.scaleway.ai/v1',
  venice: 'https://api.venice.ai/api/v1',
  perplexity: 'https://api.perplexity.ai',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  upstage: 'https://api.upstage.ai/v1',
})

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

/** Split the free-text model box into a trimmed, de-duplicated, order-preserving list. */
export function parseModelList(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set()
  const models = []
  for (const entry of entries) {
    const model = String(entry ?? '').trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models
}

/**
 * Add a model to the catalog. Duplicates are a no-op, so a paste of an id the
 * provider already returned does not create a second identical entry.
 */
export function addModelToList(models, value) {
  const current = parseModelList(models)
  const model = String(value ?? '').trim()
  if (!model || current.includes(model)) return current
  return [...current, model]
}

/**
 * Remove one model. Dropping the current default never leaves the provider
 * pointed at a model that is no longer in the catalog: the next surviving entry
 * (or the first) takes over.
 */
export function removeModelFromList(models, value, defaultModel = '') {
  const model = String(value ?? '').trim()
  const remaining = parseModelList(models).filter((entry) => entry !== model)
  return {
    models: remaining,
    defaultModel: resolveProviderDefaultModel(remaining, defaultModel === model ? '' : defaultModel),
  }
}

/**
 * Replace the model list wholesale — the "apply this source's list" action.
 *
 * A reader who has curated a list by hand must not lose the default they picked:
 * it survives whenever it is still in the new list, and otherwise falls back to
 * the first entry exactly as `removeModelFromList` does.
 */
export function replaceModelList(models, defaultModel = '') {
  const next = parseModelList(models)
  return { models: next, defaultModel: resolveProviderDefaultModel(next, defaultModel) }
}

/**
 * Add the ids the list does not have yet, keeping the reader's order.
 *
 * This is a merge, not a sync: the reader's own list is never reordered or pruned
 * by a source that happens to know fewer models. Because it is a merge, handing it
 * a whole source list does re-add an id that was removed by hand — which is why a
 * caller offering "add everything from this source" passes only the ids that are
 * currently missing, and why the per-model toggle exists for a single id.
 */
export function applyModelList(models, incoming, defaultModel = '') {
  const next = parseModelList(models)
  const added = []
  for (const entry of parseModelList(incoming)) {
    if (next.includes(entry)) continue
    next.push(entry)
    added.push(entry)
  }
  return { models: next, added, defaultModel: resolveProviderDefaultModel(next, defaultModel) }
}

/**
 * Seed a fresh custom endpoint edit.
 *
 * Both the `custom` button and a provider picked from the knowledge base enter
 * through here, so "a provider with no bundled preset" is the custom path rather
 * than a second activation model. Region-scoped header keys on the live edit are
 * carried over: they belong to the local profile, not to the provider name.
 */
export function seedCustomEditor(current = {}, { key, label, isDefault = true } = {}) {
  if (current.presetId === 'custom' && current.id) return current
  const carry = current.id
    ? {
        id: current.id,
        key: current.key,
        label: current.label,
        enabled: current.enabled,
        isDefault: current.isDefault,
        clearApiKey: Boolean(current.hasApiKey),
        savedHeaderKeys: current.savedHeaderKeys || [],
        removedHeaderKeys: current.savedHeaderKeys || [],
        clearHeaders: Boolean(current.savedHeaderKeys?.length),
      }
    : {}
  return {
    ...emptyProvider(),
    ...carry,
    presetId: 'custom',
    key: current.id ? current.key : String(key || '').trim(),
    label: current.id ? current.label : String(label || '').trim(),
    isDefault: current.id ? current.isDefault : isDefault,
  }
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
