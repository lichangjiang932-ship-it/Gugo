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
  cloud('amazon-bedrock', 'Amazon Bedrock', 'anthropic-messages', 'https://bedrock-runtime.us-east-1.amazonaws.com', 'AWS_ACCESS_KEY_ID', ['anthropic.claude-sonnet-4-6', 'meta.llama4-70b', 'amazon.nova-pro']),
  cloud('google-vertex', 'Google Vertex AI', 'anthropic-messages', 'https://us-central1-aiplatform.googleapis.com/v1', 'GOOGLE_APPLICATION_CREDENTIALS', ['claude-sonnet-4-6@vertex', 'gemini-3-pro@vertex']),
  cloud('azure-openai', 'Azure OpenAI', 'openai-completions', 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', 'AZURE_OPENAI_API_KEY', ['gpt-5.1', 'gpt-4.1']),
  cloud('cloudflare', 'Cloudflare Workers AI', 'openai-completions', 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT/ai/v1', 'CLOUDFLARE_API_TOKEN', ['@cf/meta/llama-4-70b', '@cf/qwen/qwen3-32b']),
  cloud('together', 'Together AI', 'openai-completions', 'https://api.together.xyz/v1', 'TOGETHER_API_KEY', ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-72B', 'meta-llama/Llama-4-70B']),
  cloud('fireworks', 'Fireworks AI', 'openai-completions', 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY', ['accounts/fireworks/models/deepseek-v3p2', 'accounts/fireworks/models/llama4-70b']),
  cloud('perplexity', 'Perplexity', 'openai-completions', 'https://api.perplexity.ai', 'PERPLEXITY_API_KEY', ['sonar-pro', 'sonar-reasoning', 'sonar']),
  cloud('deepinfra', 'DeepInfra', 'openai-completions', 'https://api.deepinfra.com/v1/openai', 'DEEPINFRA_API_KEY', ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-72B']),
  cloud('novita', 'Novita AI', 'openai-completions', 'https://api.novita.ai/v3/openai', 'NOVITA_API_KEY', ['deepseek/deepseek-v3.2', 'qwen/qwen3-32b']),
  cloud('hyperbolic', 'Hyperbolic', 'openai-completions', 'https://api.hyperbolic.xyz/v1', 'HYPERBOLIC_API_KEY', ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-72B']),
  cloud('cerebras', 'Cerebras', 'openai-completions', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', ['llama-4-scout-17b', 'qwen-3-32b']),
  cloud('nebius', 'Nebius AI Studio', 'openai-completions', 'https://api.studio.nebius.ai/v1', 'NEBIUS_API_KEY', ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.8-72B']),
  cloud('minimax', 'MiniMax', 'openai-completions', 'https://api.minimax.chat/v1', 'MINIMAX_API_KEY', ['MiniMax-M2', 'abab7-chat']),
  cloud('volcengine', '火山方舟（豆包）', 'openai-completions', 'https://ark.cn-beijing.volces.com/api/v3', 'ARK_API_KEY', ['doubao-seed-2.0', 'doubao-1.6-pro', 'deepseek-v3.2']),
  cloud('baidu-qianfan', '百度千帆', 'openai-completions', 'https://qianfan.baidubce.com/v2', 'QIANFAN_API_KEY', ['ernie-5.0', 'ernie-4.6', 'deepseek-v3.2']),
  cloud('tencent-hunyuan', '腾讯混元', 'openai-completions', 'https://api.hunyuan.cloud.tencent.com/v1', 'HUNYUAN_API_KEY', ['hunyuan-t1', 'hunyuan-turbos']),
  cloud('spark', '讯飞星火', 'openai-completions', 'https://spark-api-open.xf-yun.com/v1', 'SPARK_API_KEY', ['4.0-ultra', '4.0-pro', 'lite']),
  cloud('stepfun', '阶跃星辰', 'openai-completions', 'https://api.stepfun.com/v1', 'STEPFUN_API_KEY', ['step-3', 'step-2-16k']),
  cloud('z-ai', 'Z.AI（智谱国际）', 'openai-completions', 'https://api.z.ai/api/paas/v4', 'ZAI_API_KEY', ['glm-5', 'glm-4.6']),
])

/** Local runtimes: same shape, filled in by the user, usually keyless. */
export const LOCAL_PROVIDER_PRESETS = Object.freeze([
  Object.freeze({ id: 'ollama', displayName: 'Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'lmstudio', displayName: 'LM Studio', api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'llamacpp', displayName: 'llama.cpp', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'vllm', displayName: 'vLLM', api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'text-generation-webui', displayName: 'text-generation-webui', api: 'openai-completions', baseURL: 'http://127.0.0.1:5000/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'open-webui', displayName: 'Open WebUI', api: 'openai-completions', baseURL: 'http://127.0.0.1:3000/api', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'localai', displayName: 'LocalAI', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: '', autoProbe: true }),
  Object.freeze({ id: 'jan', displayName: 'Jan', api: 'openai-completions', baseURL: 'http://127.0.0.1:1337/v1', apiKeyEnv: '', autoProbe: true }),
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
