/**
 * The built-in provider catalogue: what the "选择模型服务" grid shows and what
 * a chosen entry pre-fills. One entry = display name + protocol + endpoint +
 * the environment variable a key may come from. No key ever lives here.
 */
export const LLM_PROTOCOLS = Object.freeze([
  Object.freeze({ id: 'openai-completions', label: 'OpenAI Chat Completions' }),
  Object.freeze({ id: 'openai-responses', label: 'OpenAI Responses' }),
  Object.freeze({ id: 'anthropic-messages', label: 'Anthropic Messages' }),
])

export const LLM_PROTOCOL_IDS = Object.freeze(LLM_PROTOCOLS.map((entry) => entry.id))

const cloud = (id, displayName, api, baseURL, apiKeyEnv, models) => Object.freeze({
  id, displayName, api, baseURL, apiKeyEnv, models: Object.freeze(models),
})

export const PROVIDER_CATALOG = Object.freeze([
  cloud('openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1', 'OPENAI_API_KEY', ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1']),
  cloud('anthropic', 'Anthropic Claude', 'anthropic-messages', 'https://api.anthropic.com/v1', 'ANTHROPIC_API_KEY', ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']),
  cloud('google', 'Google Gemini', 'openai-completions', 'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY', ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro']),
  cloud('deepseek', 'DeepSeek', 'openai-completions', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']),
  cloud('openrouter', 'OpenRouter', 'openai-completions', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', ['anthropic/claude-sonnet-4.6', 'google/gemini-3-pro', 'deepseek/deepseek-chat']),
  cloud('bailian', '阿里云通义千问', 'openai-completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-plus']),
  cloud('siliconflow', '硅基流动', 'openai-completions', 'https://api.siliconflow.cn/v1', 'SILICONFLOW_API_KEY', ['Qwen/Qwen3.8-72B', 'deepseek-ai/DeepSeek-V3.2', 'moonshotai/Kimi-K2']),
  cloud('moonshot', 'Moonshot Kimi', 'openai-completions', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY', ['kimi-k2-0905', 'kimi-k2-turbo', 'kimi-latest']),
  cloud('zhipu', '智谱 GLM', 'openai-completions', 'https://open.bigmodel.cn/api/paas/v4', 'ZHIPU_API_KEY', ['glm-5', 'glm-4.6', 'glm-4.5-air']),
  cloud('xai', 'xAI Grok', 'openai-completions', 'https://api.x.ai/v1', 'XAI_API_KEY', ['grok-5', 'grok-5-mini', 'grok-4']),
  cloud('groq', 'Groq', 'openai-completions', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', ['llama-4-70b', 'kimi-k2-instruct', 'qwen3-32b']),
  cloud('mistral', 'Mistral AI', 'openai-completions', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', ['mistral-large-3', 'magistral-medium', 'codestral']),
])

/** Local runtimes: same shape, filled in by the user, usually keyless. */
export const LOCAL_PROVIDER_PRESETS = Object.freeze([
  Object.freeze({ id: 'ollama', displayName: 'Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'lmstudio', displayName: 'LM Studio', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'llamacpp', displayName: 'llama.cpp', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'vllm', displayName: 'vLLM', api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', apiKeyEnv: '', autoProbe: true }),
])

export function catalogEntry(id) {
  const key = String(id || '').trim().toLowerCase()
  return PROVIDER_CATALOG.find((entry) => entry.id === key)
    || LOCAL_PROVIDER_PRESETS.find((entry) => entry.id === key)
    || null
}

/** Provider ids become credential names and request identities, so the shape is strict. */
export function isValidProviderId(id) {
  return /^[a-z][a-z0-9-]{0,39}$/u.test(String(id || ''))
}

export function isSupportedProtocol(api) {
  return LLM_PROTOCOL_IDS.includes(String(api || ''))
}

/** A catalogue entry, expanded into the settings shape the store persists. */
export function presetProviderConfig(id) {
  const entry = catalogEntry(id)
  if (!entry) return null
  return {
    displayName: entry.displayName,
    api: entry.api,
    baseURL: entry.baseURL,
    apiKeyEnv: entry.apiKeyEnv,
    ...(entry.autoProbe ? { autoProbe: true } : {}),
    models: (entry.models || []).map((modelId) => ({ id: modelId })),
  }
}
