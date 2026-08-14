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
  { id: 'openai', key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'anthropic', key: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], kind: 'anthropic', contextWindow: 200000, caps: CAPS.toolsVision },
  { id: 'gemini', key: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro'], kind: 'gemini', contextWindow: 1000000, caps: CAPS.toolsVision },
  { id: 'deepseek', key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.toolsText },
  { id: 'openrouter', key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5.6-sol', 'anthropic/claude-opus-4.8', 'google/gemini-3.1-pro'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'qwen', key: 'qwen', labelKey: 'providerQwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'siliconflow', key: 'siliconflow', labelKey: 'providerSiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-Next-80B-A3B-Instruct', 'moonshotai/Kimi-K2.5'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'moonshot', key: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2.5', 'kimi-k2-thinking', 'moonshot-v1-128k'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.toolsText },
  { id: 'zhipu', key: 'zhipu', labelKey: 'providerZhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5', 'glm-5-flash', 'glm-4.6v'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'xai', key: 'xai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', models: ['grok-4.1', 'grok-4.1-fast', 'grok-4-fast'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.tools },
  { id: 'groq', key: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'llama-3.3-70b-versatile'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.toolsText },
  { id: 'mistral', key: 'mistral', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'magistral-medium-latest', 'codestral-latest'], kind: 'openai-compatible', contextWindow: 128000, caps: CAPS.toolsVision },
])

export const PROVIDER_PRESETS = Object.freeze([...CLOUD_PRESETS, ...LOCAL_PRESETS])
export const KIND_OPTIONS = ['', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'anthropic', 'gemini', 'openai-compatible']
export const TRIBOOL_VALUES = ['', '1', '0']

export function emptyProvider() {
  return {
    id: '', key: '', label: '', baseUrl: '', apiKey: '', modelsText: '', defaultModel: '', presetId: '',
    headersText: '', enabled: true, isDefault: false, kind: '', contextWindow: '', supportsTools: '',
    supportsStreaming: '', supportsVision: '', supportsPdf: '', firstTokenTimeoutMs: '', idleTimeoutMs: '',
    failoverEnabled: '', keepAlive: '', modelProfiles: {},
  }
}

export function selectToTribool(value) {
  if (value === '') return null
  return value === '1'
}

export function numberOrNull(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const num = Number(text)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
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
  const matchedPreset = PROVIDER_PRESETS.find((preset) => preset.baseUrl === provider.baseUrl)
  return {
    ...provider, presetId: matchedPreset?.id || 'custom', apiKey: '', modelsText: (provider.models || []).join('\n'),
    headersText: '', kind: provider.kind || '', contextWindow: provider.contextWindow ?? '',
    supportsTools: triboolToSelect(provider.supportsTools), supportsStreaming: triboolToSelect(provider.supportsStreaming),
    supportsVision: triboolToSelect(provider.supportsVision), supportsPdf: triboolToSelect(provider.supportsPdf),
    firstTokenTimeoutMs: provider.firstTokenTimeoutMs ?? '', idleTimeoutMs: provider.idleTimeoutMs ?? '',
    failoverEnabled: triboolToSelect(provider.failoverEnabled), keepAlive: provider.keepAlive || '',
  }
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
