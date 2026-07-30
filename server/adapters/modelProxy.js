import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  chargeForModelUse,
  estimateChatCost,
  getBillingDiagnostics,
  getMailDiagnostics,
  getPublicAccount,
  loadBillingConfig,
} from './billingAuth.js'
import { getSessionByToken } from '../db.js'
import {
  selectActiveMemoriesForInjection,
  buildMemorySystemBlock,
  touchMemoryUsage,
} from '../services/memoryStore.js'
import { dispatchHooks } from '../services/hooksService.js'
import { ensureDefaultAgent, getAgent } from '../services/agentStore.js'
import {
  buildIdentityBlock,
  buildIshikiBlock,
  buildSkillsBlock,
  buildSessionsBlock,
  getPromptCompilerStats,
} from '../services/promptCompiler.js'
import { attachVisionDescriptions, hasVisionAssistConfigured } from './visionAssist.js'
import { logWarn } from '../utils/logger.js'
import { withRetry } from '../utils/modelRetry.js'
import { buildUserModelEnv } from '../services/modelProviderStore.js'

// ★ #18: 消息格式 schema — 拒绝畸形 messages 入参,防 OpenAI 上游报 400 / 计费爆零
const MESSAGE_SCHEMA = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  // content 可以是 string、null (assistant tool_calls 时)、或 multimodal array
  content: z.union([z.string(), z.null(), z.array(z.any())]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
}).passthrough()
const MESSAGES_SCHEMA = z.array(MESSAGE_SCHEMA).min(1, 'messages 不能为空')

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const REQUIRED_ENV = ['MODEL_BASE_URL', 'MODEL_NAME']

function parseCsv(raw = '') {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function providerEnvPrefix(id = '') {
  return `MODEL_PROVIDER_${String(id).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

function parseHeaders(raw = '') {
  if (!raw) return {}
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [String(key), String(val)]))
  } catch {
    return {}
  }
}

function readEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) return {}

  const entries = {}
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    entries[key] = value
  }
  return entries
}

export function getRuntimeEnv(env = process.env) {
  return { ...readEnvFile(), ...env }
}

export function getModelProviders(env = process.env) {
  const ids = parseCsv(env.MODEL_PROVIDERS)
  return ids.map((id) => {
    const prefix = providerEnvPrefix(id)
    return {
      id,
      baseUrl: env[`${prefix}_BASE_URL`]?.trim() || '',
      apiKey: env[`${prefix}_API_KEY`]?.trim() || '',
      models: parseCsv(env[`${prefix}_MODELS`]),
      headers: parseHeaders(env[`${prefix}_HEADERS`]),
    }
  })
}

function findProviderForModel(modelName, env = process.env) {
  return getModelProviders(env).find((provider) => provider.models.includes(modelName)) || null
}

function providerMissingFields(provider) {
  const prefix = providerEnvPrefix(provider.id)
  const missing = []
  if (!provider.baseUrl) missing.push(`${prefix}_BASE_URL`)
  if (!provider.models.length) missing.push(`${prefix}_MODELS`)
  return missing
}

export function loadModelConfig(env = process.env) {
  const providers = getModelProviders(env)
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim())
  const temperature = Number(env.MODEL_TEMPERATURE ?? 0.7)
  const maxTokens = Number(env.MODEL_MAX_TOKENS ?? 4096)

  if (providers.length) {
    const modelName = env.MODEL_NAME?.trim() || providers.find((provider) => provider.models.length)?.models[0] || ''
    const provider = findProviderForModel(modelName, env) || providers[0]
    const providerMissing = provider ? providerMissingFields(provider) : ['MODEL_PROVIDERS']
    if (!modelName) providerMissing.unshift('MODEL_NAME')

    return {
      configured: providerMissing.length === 0,
      missing: providerMissing,
      baseUrl: provider?.baseUrl || '',
      modelName,
      apiKey: provider?.apiKey || '',
      ...(Object.keys(provider?.headers || {}).length ? { headers: provider.headers } : {}),
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
    }
  }

  return {
    configured: missing.length === 0,
    missing,
    baseUrl: env.MODEL_BASE_URL?.trim() || '',
    modelName: env.MODEL_NAME?.trim() || '',
    apiKey: env.MODEL_API_KEY?.trim() || '',
    ...(Object.keys(parseHeaders(env.MODEL_HEADERS)).length ? { headers: parseHeaders(env.MODEL_HEADERS) } : {}),
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
  }
}

export function resolveModelConfigForModel({ modelName, env = process.env } = {}) {
  const base = loadModelConfig(env)
  const selectedModel = modelName?.trim() || base.modelName
  const provider = findProviderForModel(selectedModel, env)
  if (!provider) return { ...base, modelName: selectedModel }

  const missing = providerMissingFields(provider)
  const baseWithoutHeaders = { ...base }
  delete baseWithoutHeaders.headers
  return {
    ...baseWithoutHeaders,
    configured: missing.length === 0,
    missing,
    baseUrl: provider.baseUrl,
    modelName: selectedModel,
    apiKey: provider.apiKey,
    ...(Object.keys(provider.headers || {}).length ? { headers: provider.headers } : {}),
  }
}

export function getToolMaxRounds(env = process.env) {
  // 工具调用轮数上限。★ 默认 0 = 不限制。
  //
  // 循环本来就会在模型停止调工具时自然退出,想让它停随时点「停止生成」。
  // 以前默认 5,读一个中等项目光探索就吃满,模型被硬切在半路只留一句
  // 「让我继续」—— 用户付了钱拿不到结论。Claude Code / Codex / openworker
  // 都不设这种硬顶。
  //
  // 仍然允许显式配一个正数(1..1000)来封顶,给受控/演示环境用;
  // 设 0 或不设 = 无限制。前端另有一个极高的死循环护栏。
  const raw = Number(env.TOOL_MAX_ROUNDS)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  if (raw > 1000) return 0
  return Math.floor(raw)
}

export function hasVisionContent(messages = []) {
  return messages.some((message) =>
    Array.isArray(message?.content) &&
    message.content.some((part) => part?.type === 'image_url' || part?.image_url)
  )
}

export function supportsVisionModel(modelName = '', env = process.env) {
  const configured = String(env.MODEL_NAMES_VISION || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!configured.length) return true
  return configured.includes(modelName)
}

export function getModelStatus(env = process.env) {
  const config = loadModelConfig(env)
  if (!config.configured) {
    return { ok: true, configured: false, missing: config.missing, toolMaxRounds: getToolMaxRounds(env) }
  }

  const status = {
    ok: true,
    configured: true,
    modelName: config.modelName,
    baseUrlMasked: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    toolMaxRounds: getToolMaxRounds(env),
  }

  const models = getVisibleModels(env, config.modelName)
  if (models.length > 1 || env.MODEL_NAMES) status.models = models
  return status
}

/**
 * 补齐本地模型端点缺失的 /v1 前缀。
 *
 * ★ 用户手填 Base URL 时经常漏掉 /v1(比如 LM Studio 填成 http://127.0.0.1:1234),
 * 于是请求打到 GET /models —— LM Studio 日志里那句
 * 「Unexpected endpoint or method. (GET /models)」就是这么来的,
 * 而且它还返回 200,前端只能报「端点可达,但没有返回模型列表」,
 * 用户根本猜不到是少了 /v1。
 *
 * ⚠ 只对本机地址做这个补全。云端 provider 的路径约定各家不同 ——
 * DeepSeek 官方 base 就是 https://api.deepseek.com(不带 /v1)且能正常工作,
 * 无条件补 /v1 会把已经配好的线上 provider 全部打挂。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/**
 * 这个端点是不是跑在本机(Ollama / LM Studio 之类)。
 *
 * ★ 本地模型跑在用户自己的电脑上,不产生任何上游 API 费用 —— 却照样扣积分,
 * 用户明明用的是自己的显卡还要付钱。积分体系是为了覆盖云端 API 成本,
 * 本地推理不该计入。
 */
export function isLocalModelEndpoint(baseUrl = '') {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return false
  try {
    return LOCAL_HOSTS.has(new URL(trimmed).hostname)
  } catch {
    return false
  }
}

function ensureApiVersionPath(trimmed) {
  try {
    const url = new URL(trimmed)
    if (!LOCAL_HOSTS.has(url.hostname)) return trimmed
    const path = url.pathname.replace(/\/+$/, '')
    // 只有「光秃秃的 host:port」才补;已经有任何路径就不猜
    if (path === '' || path === '/') {
      url.pathname = '/v1'
      return url.toString().replace(/\/+$/, '')
    }
    return trimmed
  } catch {
    // 不是合法 URL 就原样返回,让后续 fetch 自己报错
    return trimmed
  }
}

function normalizeModelsUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions$/i, '/models')
  }
  if (/\/models$/i.test(trimmed)) return trimmed
  return `${ensureApiVersionPath(trimmed)}/models`
}

function safeErrorMessage(error) {
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或权限不足'
  if (error?.status === 404) return '端点不支持 /models 或地址不存在'
  if (error?.name === 'AbortError') return '端点探测超时'
  return error?.message || '端点探测失败'
}

async function checkModelsEndpoint({ config, fetchImpl = fetch }) {
  if (!config.configured) {
    return { checked: false, ok: false, reason: `缺少 ${config.missing.join(', ')}` }
  }

  const url = normalizeModelsUrl(config.baseUrl)
  const controller = new AbortController()
  const started = Date.now()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const headers = { ...(config.headers || {}) }
    if (config.apiKey && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${config.apiKey}`
    }
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || response.statusText)
      error.status = response.status
      throw error
    }
    const remoteModels = Array.isArray(data?.data)
      ? data.data.map((item) => item.id || item.name).filter(Boolean).slice(0, 50)
      : []
    return {
      checked: true,
      ok: true,
      url,
      latency: Date.now() - started,
      remoteModels,
    }
  } catch (error) {
    return {
      checked: true,
      ok: false,
      url,
      latency: Date.now() - started,
      error: safeErrorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getSystemDiagnostics({ env = process.env, fetchImpl = fetch, checkEndpoint = false } = {}) {
  const config = loadModelConfig(env)
  const modelStatus = getModelStatus(env)
  const billing = getBillingDiagnostics(env)
  const mail = getMailDiagnostics(env)
  const endpoint = checkEndpoint
    ? await checkModelsEndpoint({ config, fetchImpl })
    : { checked: false, ok: null, reason: '未执行端点探测' }

  return {
    ok: true,
    generatedAt: Date.now(),
    model: {
      ...modelStatus,
      apiKeyConfigured: !!config.apiKey,
    },
    endpoint,
    billing,
    mail,
    // 缓存可观测性:上游 token 命中率 + 本地 prompt block LRU 命中率。
    // 以前这两个数字都拿不到,任何前缀优化都无法验证效果。
    cache: {
      upstream: getUsageStats(),
      promptBlocks: getPromptCompilerStats(),
      streamUsageEnabled: supportsStreamUsage(config, env),
    },
  }
}

export function getVisibleModels(env = process.env, defaultModel = '') {
  const providers = getModelProviders(env)
  const providerModelEntries = providers.flatMap((provider) =>
    provider.models.map((name) => ({ name, provider: provider.id }))
  )
  const names = providerModelEntries.length
    ? providerModelEntries.map((entry) => entry.name)
    : parseCsv(env.MODEL_NAMES || defaultModel)
  const uniqueNames = [...new Set(names.length ? names : [defaultModel].filter(Boolean))]
  const billingConfig = loadBillingConfig({ ...env, MODEL_NAME: defaultModel })
  const providerByModel = new Map(providerModelEntries.map((entry) => [entry.name, entry.provider]))
  return uniqueNames.map((name) => ({
    name,
    multiplier: billingConfig.multipliers[name] || 1,
    active: name === defaultModel,
    ...(providerByModel.has(name) ? { provider: providerByModel.get(name) } : {}),
  }))
}

function pickAllowedModel({ requestedModel, config, env }) {
  const models = getVisibleModels(env, config.modelName)
  const allowed = new Set(models.map((item) => item.name))
  if (!requestedModel) return config.modelName
  if (!allowed.has(requestedModel)) throw new Error(`模型 ${requestedModel} 不在后端允许列表中`)
  return requestedModel
}

export function normalizeOpenAICompatibleUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('请输入 Base URL。')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  // 同 normalizeModelsUrl:用户只填 host:port 时补 /v1,否则聊天也会 404
  return `${ensureApiVersionPath(trimmed)}/chat/completions`
}

function normalizeMessagesForOpenAI(messages = []) {
  return messages.map((message) => {
    if (
      message?.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0 &&
      message.content === ''
    ) {
      return { ...message, content: null }
    }
    return message
  })
}

/**
 * 该端点能不能吃 stream_options.include_usage。
 * 保守策略:已知支持的家族才开;其余保持关闭,除非用户显式 MODEL_STREAM_USAGE=1。
 * 关掉只是拿不到 usage(命中率显示为未知),不影响聊天本身。
 */
export function supportsStreamUsage(config, env = process.env) {
  const forced = String(env.MODEL_STREAM_USAGE || '').trim()
  if (forced === '1') return true
  if (forced === '0') return false
  const base = String(config?.baseUrl || '').toLowerCase()
  if (!base) return false
  return /(^|\/\/|\.)(api\.)?(deepseek|openai|siliconflow|moonshot|dashscope|bigmodel|xiaomimimo|together|fireworks|groq)\b/.test(base)
    || base.includes('openai.azure.com')
}

export function buildOpenAICompatibleRequest({ config, messages, stream = false, tools, toolChoice }) {  const model = config?.modelName
  if (!model) throw new Error('请输入模型名称。')
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('消息不能为空。')
  }

  const headers = { 'Content-Type': 'application/json', ...(config?.headers || {}) }
  if (config?.apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${config.apiKey}`
  }

  const body = {
    model,
    messages: normalizeMessagesForOpenAI(messages),
    temperature: config?.temperature ?? 0.7,
    max_tokens: config?.maxTokens || 4096,
    stream,
  }
  // ★ 工具调用:仅当上游提供 tools 字段时才透传,避免不支持工具的模型报 400
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }
  // ★ 流式 usage:拿到才能算缓存命中率。同 tools 的口径,默认只对已知支持的端点开,
  // 不认识的端点保持沉默(有些实现见到未知字段直接 400)。可用 MODEL_STREAM_USAGE 强制。
  if (stream && supportsStreamUsage(config)) {
    body.stream_options = { include_usage: true }
  }

  return {
    url: normalizeOpenAICompatibleUrl(config?.baseUrl),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  }
}

/**
 * 进程内 usage 聚合。用于回答「缓存命中率是多少」——改前改后能对比,
 * 否则任何前缀优化都是盲改。故意不落库:这是运维观测指标,不是业务数据。
 */
const usageTotals = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  byModel: new Map(),
}

export function recordUsage(modelName, usage) {
  if (!usage) return
  usageTotals.requests += 1
  usageTotals.promptTokens += usage.promptTokens || 0
  usageTotals.completionTokens += usage.completionTokens || 0
  usageTotals.cacheHitTokens += usage.cacheHitTokens || 0
  usageTotals.cacheMissTokens += usage.cacheMissTokens || 0
  const key = String(modelName || 'unknown')
  const m = usageTotals.byModel.get(key) || { requests: 0, promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  m.requests += 1
  m.promptTokens += usage.promptTokens || 0
  m.cacheHitTokens += usage.cacheHitTokens || 0
  m.cacheMissTokens += usage.cacheMissTokens || 0
  usageTotals.byModel.set(key, m)
}

function hitRate(hit, total) {
  return total > 0 ? Number(((hit / total) * 100).toFixed(2)) : null
}

export function getUsageStats() {
  const cacheable = usageTotals.cacheHitTokens + usageTotals.cacheMissTokens
  return {
    requests: usageTotals.requests,
    promptTokens: usageTotals.promptTokens,
    completionTokens: usageTotals.completionTokens,
    cacheHitTokens: usageTotals.cacheHitTokens,
    cacheMissTokens: usageTotals.cacheMissTokens,
    // null 表示上游没回 usage(端点不支持或未开 stream_options),不是 0%
    cacheHitRatePercent: hitRate(usageTotals.cacheHitTokens, cacheable),
    byModel: Object.fromEntries(
      [...usageTotals.byModel.entries()].map(([name, m]) => [
        name,
        { ...m, cacheHitRatePercent: hitRate(m.cacheHitTokens, m.cacheHitTokens + m.cacheMissTokens) },
      ]),
    ),
  }
}

export function resetUsageStats() {
  usageTotals.requests = 0
  usageTotals.promptTokens = 0
  usageTotals.completionTokens = 0
  usageTotals.cacheHitTokens = 0
  usageTotals.cacheMissTokens = 0
  usageTotals.byModel.clear()
}

export function parseOpenAICompatibleResponse(data) {
  const reply =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    data?.output?.text ||
    data?.result

  if (!reply) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
  return reply
}

/**
 * 从上游响应里抽 token usage,顺带归一化各家的缓存命中字段。
 *
 * 故意不并进 parseOpenAICompatibleResponse —— 那个函数返回裸字符串,
 * 有 3 处调用点直接当字符串用(含 HTTP response 序列化),改返回类型会渲染成
 * "[object Object]"。这里单独取,纯读、只用可选链、绝不 throw。
 *
 *   DeepSeek : prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   OpenAI   : prompt_tokens_details.cached_tokens
 */
export function extractUsage(data) {
  const u = data?.usage
  if (!u || typeof u !== 'object') return null
  const promptTokens = Number(u.prompt_tokens) || 0
  const cacheHitTokens = Number(
    u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  ) || 0
  // DeepSeek 直接给 miss;OpenAI 只给 cached,miss 由 prompt - cached 推出
  const cacheMissTokens = Number(
    u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens),
  ) || 0
  return {
    promptTokens,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0,
    cacheHitTokens,
    cacheMissTokens,
  }
}

export async function callBackgroundModel({
  messages,
  modelName,
  userId,
  env = getRuntimeEnv(),
  fetchImpl = fetch,
  signal,
} = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const config = loadModelConfig(runtimeEnv)
  if (!config.configured) {
    throw new Error(`后台任务缺少模型配置：${config.missing.join(', ')}`)
  }
  const selectedModel = pickAllowedModel({
    requestedModel: modelName,
    config,
    env: runtimeEnv,
  })
  const { url, init } = buildOpenAICompatibleRequest({
    config: resolveModelConfigForModel({ modelName: selectedModel, env: runtimeEnv }),
    messages,
    stream: false,
  })
  // ★ Harness: 同 callBackgroundModelWithTools —— 瞬时故障退避重试,不让一次抖动杀掉整个 job
  return withRetry(async () => {
  const response = await fetchImpl(url, { ...init, signal })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || response.statusText)
    error.status = response.status
    // 带上 Retry-After,withRetry 会优先尊重上游给的等待时长
    error.retryAfter = response.headers?.get?.('retry-after') ?? null
    throw error
  }
  recordUsage(selectedModel, extractUsage(data))
  return parseOpenAICompatibleResponse(data)
  }, {
    signal,
    onRetry: ({ attempt, delayMs, error }) => {
      logWarn('model.retry', error, { attempt, delayMs, model: selectedModel })
    },
  })
}

/**
 * 与 callBackgroundModel 同一条路径,但额外支持 tools 字段 + 返回 tool_calls。
 * jobRuntime 的 server-side tools loop 用这个入口。
 *
 * @returns {Promise<{content:string, toolCalls:Array}>}
 */
export async function callBackgroundModelWithTools({
  messages,
  tools,
  toolChoice,
  modelName,
  userId,
  env = getRuntimeEnv(),
  fetchImpl = fetch,
  signal,
} = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const config = loadModelConfig(runtimeEnv)
  if (!config.configured) {
    throw new Error(`后台任务缺少模型配置：${config.missing.join(', ')}`)
  }
  const selectedModel = pickAllowedModel({
    requestedModel: modelName,
    config,
    env: runtimeEnv,
  })
  const { url, init } = buildOpenAICompatibleRequest({
    config: resolveModelConfigForModel({ modelName: selectedModel, env: runtimeEnv }),
    messages,
    stream: false,
    tools,
    toolChoice,
  })
  // ★ Harness: 后台工具循环对上游只发一次的话,一个 429 就把整个 job 判死。
  // 限流/5xx/网络抖动退避重试;4xx 业务错误立即失败,重试无意义。
  return withRetry(async () => {
    const response = await fetchImpl(url, { ...init, signal })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || response.statusText)
      error.status = response.status
      error.retryAfter = response.headers?.get?.('retry-after') ?? null
      throw error
    }
    recordUsage(selectedModel, extractUsage(data))
    const msg = data?.choices?.[0]?.message || {}
    return {
      content: msg.content || '',
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    }
  }, {
    signal,
    onRetry: ({ attempt, delayMs, error }) => {
      logWarn('model.retry', error, { attempt, delayMs, model: selectedModel })
    },
  })
}

export function formatProxyError(error) {
  const msg = error?.message || ''
  const code = error?.code || ''

  // ★ 诊断增强: 400 错误可能是 token 溢出或参数真的无效
  if (error?.status === 400) {
    if (/context_length|token.?limit|maximum context|reduce the length/i.test(msg + code)) {
      return '内容超出模型最大上下文长度，请缩短消息或开启会话压缩。'
    }
    if (/invalid.*model|model.*not found/i.test(msg)) {
      return '模型名称无效，请检查 .env 中的 MODEL_NAME。'
    }
    if (/rate.?limit/i.test(msg)) {
      return 'API 调用频率超限，请稍后重试。'
    }
    return '请求参数无效：请检查消息内容、工具调用上下文或当前模型的 OpenAI 兼容性。'
  }
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或没有权限。'
  if (error?.status === 404) return '模型或端点不存在，请检查 Base URL 和模型名称。'
  if (error?.status === 408 || error?.name === 'AbortError') return '模型请求超时，请稍后重试或调小 Max Tokens。'
  if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
    return '端点不可达，请确认本地模型服务或代理已启动。'
  }
  if (error?.status) return `模型服务返回 HTTP ${error.status}：${msg || '请求失败'}`
  return msg || '模型代理调用失败。'
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function* streamOpenAICompatible({ config, messages, fetchImpl = fetch, tools, toolChoice, externalSignal }) {
  const { url, init } = buildOpenAICompatibleRequest({ config, messages, stream: true, tools, toolChoice })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)
  // ★ #38: 外部 (客户端断开) 触发 abort 时也立即放弃上游请求
  let onExternalAbort = null
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else {
      onExternalAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      const text = await response.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
      const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
      const error = new Error(message)
      error.status = response.status
      throw error
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取流式响应')

    const decoder = new TextDecoder()
    let buffer = ''
    // ★ tool_call 增量合并:OpenAI 流式协议每个 chunk 给 tool_calls[i].function.arguments 的片段,需要按 index 累加
    const toolCallAcc = new Map() // index -> { id, name, arguments }
    let finishReason = null
    let lastUsage = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        if (payload === '[DONE]') {
          // 流末尾:把累积的 tool_calls 一次性吐出
          if (toolCallAcc.size > 0) {
            const calls = [...toolCallAcc.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => v)
            yield { type: 'tool_calls', toolCalls: calls, finishReason: finishReason || 'tool_calls', usage: lastUsage }
          }
          return
        }
        try {
          const chunk = JSON.parse(payload)
          // ★ usage 帧的 choices 是空数组,必须在 !choice 守卫之前取,
          // 否则永远被 continue 跳过 —— 这正是以前命中率无法测量的原因。
          const chunkUsage = extractUsage(chunk)
          if (chunkUsage) {
            lastUsage = chunkUsage
            yield { type: 'usage', usage: chunkUsage }
          }
          const choice = chunk?.choices?.[0]
          if (!choice) continue
          const delta = choice.delta || {}
          if (choice.finish_reason) finishReason = choice.finish_reason
          // 文本增量
          const text = delta.content || choice.text || ''
          if (text) yield { type: 'text', delta: text }
          // 工具调用增量
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const existing = toolCallAcc.get(idx) || { id: '', name: '', arguments: '' }
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.arguments += tc.function.arguments
              toolCallAcc.set(idx, existing)
            }
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }
    // 兜底:某些后端不发 [DONE]
    if (toolCallAcc.size > 0) {
      const calls = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
      yield { type: 'tool_calls', toolCalls: calls, finishReason: finishReason || 'tool_calls', usage: lastUsage }
    }
  } finally {
    clearTimeout(timeout)
    // ★ #38: 清掉外部 signal 监听器,避免后续 abort 误触
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

function authToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

export async function handleModelProxyRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST 请求。' })
    return
  }

  try {
    const body = await readJson(req)
    const requestUserId = authenticateRequest(req)
    const runtimeEnv = buildUserModelEnv({ userId: requestUserId, env: getRuntimeEnv() })
    const config = loadModelConfig(runtimeEnv)
    if (!config.configured) {
      sendJson(res, 500, {
        ok: false,
        error: `后端模型未配置：缺少 ${config.missing.join(', ')}。请管理员检查 .env。`,
        missing: config.missing,
      })
      return
    }

    const testMode = req.url?.startsWith('/api/model/test')
    const useStream = body.stream === true
    let messages = testMode
      ? [{ role: 'user', content: 'Reply with only: pong' }]
      : body.messages

    // ★ #18: 校验 messages 形态;testMode 跳过 (内部硬编码)
    if (!testMode) {
      const validated = MESSAGES_SCHEMA.safeParse(messages)
      if (!validated.success) {
        const issues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: `messages 格式无效: ${issues}` }))
        return
      }
    }
    let session = null
    const selectedModel = pickAllowedModel({
      requestedModel: body.modelName,
      config,
      env: runtimeEnv,
    })
    if (!testMode && hasVisionContent(messages) && !supportsVisionModel(selectedModel, runtimeEnv)) {
      const sessionForAssist = session || (authToken(req) ? getSessionByToken(authToken(req)) : null)
      const userIdForAssist = sessionForAssist?.user_id || null
      if (hasVisionAssistConfigured({ userId: userIdForAssist, env: runtimeEnv })) {
        try {
          const assistResult = await attachVisionDescriptions({
            messages,
            userId: userIdForAssist,
            env: runtimeEnv,
          })
          messages = assistResult.messages
          res.setHeader('X-Vision-Assist-Count', String(assistResult.assistCount))
          if (assistResult.failures.length) {
            res.setHeader('X-Vision-Assist-Failures', String(assistResult.failures.length))
          }
        } catch (assistErr) {
          sendJson(res, 422, {
            ok: false,
            error: `视觉副驾调用失败，请检查配置：${assistErr.message || assistErr}`,
            modelName: selectedModel,
          })
          return
        }
      } else {
        sendJson(res, 422, {
          ok: false,
          error: `当前模型 ${selectedModel} 未启用视觉输入。请切换到支持图片的模型，或在「设置 → 集成」中配置「视觉辅助副驾」让无视觉模型也能间接理解图片。`,
          modelName: selectedModel,
          visionAssistAvailable: false,
        })
        return
      }
    }
    const requestConfig = resolveModelConfigForModel({ modelName: selectedModel, env: runtimeEnv })

    let token = ''
    let estimatedCost = 0
    let injectedMemoryIds = []
    let account = null
    let injectedAgentId = null
    let promptSystemBlockCount = 0
    const compilerFingerprints = {
      identity: 'empty',
      ishiki: 'empty',
      skills: 'empty',
      sessions: 'empty',
    }
    if (testMode) {
      token = authToken(req)
      session = token ? getSessionByToken(token) : null
    }
    if (!testMode) {
      token = authToken(req)
      account = getPublicAccount({ token })
      session = token ? getSessionByToken(token) : null

      if (session?.user_id) {
        const promptHook = await dispatchHooks({
          userId: session.user_id,
          event: 'user_prompt_submit',
          tool: 'chat',
          args: { messages },
        })
        if (!promptHook.allow) {
          sendJson(res, 403, { ok: false, error: promptHook.reason || 'hook rejected prompt' })
          return
        }
        if (Array.isArray(promptHook.replacementArgs?.messages)) {
          messages = promptHook.replacementArgs.messages
        }
      }
    }

    // FreshCompact 风格：identity / ishiki / skills / sessions 分块编译为独立 system message。
    if (session?.user_id) {
      const compiledSystemMessages = []
      try {
        if (session?.user_id && getRuntimeEnv().AGENT_INJECT_ENABLED !== '0') {
          let agent = null
          const requestedAgentId = typeof body.agentId === 'string' ? body.agentId : null
          if (requestedAgentId) {
            const found = getAgent({ userId: session.user_id, id: requestedAgentId })
            if (found) agent = found
          }
          if (!agent) agent = ensureDefaultAgent({ userId: session.user_id })
          const identity = buildIdentityBlock({ agent })
          const ishiki = buildIshikiBlock({ agent })
          compilerFingerprints.identity = identity.fingerprint
          compilerFingerprints.ishiki = ishiki.fingerprint
          if (identity.text) compiledSystemMessages.push({ role: 'system', content: identity.text })
          if (ishiki.text) compiledSystemMessages.push({ role: 'system', content: ishiki.text })
          if (identity.text || ishiki.text) {
            injectedAgentId = agent.id
          }
        }
      } catch (err) {
        // D4: inject 失败不阻断 chat,但生产也要有可观测信号(原来仅 dev warn)。
        logWarn('agent.inject', err, { userId: session?.user_id })
      }

      try {
        const skills = buildSkillsBlock({
          userId: session.user_id,
          agentId: injectedAgentId,
          skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
        })
        compilerFingerprints.skills = skills.fingerprint
        if (skills.text) compiledSystemMessages.push({ role: 'system', content: skills.text })
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[skills] prompt compile failed:', err?.message || err)
        }
      }

      try {
        const sessions = buildSessionsBlock({
          userId: session.user_id,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
          recentMessages: Array.isArray(body.recentMessages) ? body.recentMessages : [],
        })
        compilerFingerprints.sessions = sessions.fingerprint
        if (sessions.text) compiledSystemMessages.push({ role: 'system', content: sessions.text })
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[sessions] prompt compile failed:', err?.message || err)
        }
      }

      if (compiledSystemMessages.length) {
        messages = [...compiledSystemMessages, ...messages]
        promptSystemBlockCount = compiledSystemMessages.length
      }
    }

    // Feature 3: 注入用户长期记忆为 system block
    if (!testMode) {
      try {
        if (session?.user_id) {
          const cap = Number(getRuntimeEnv().MEMORY_INJECT_TOKEN_CAP || 800)
          const picked = selectActiveMemoriesForInjection({ userId: session.user_id, tokenCap: cap, agentId: injectedAgentId })
          if (picked.memories.length) {
            const block = buildMemorySystemBlock(picked.memories)
            // 插入在 agent block 之后（如果有），使 agent 始终为 messages[0]
            const insertAt = promptSystemBlockCount || (injectedAgentId ? 1 : 0)
            messages.splice(insertAt, 0, { role: 'system', content: block })
            injectedMemoryIds = picked.memories.map((m) => m.id)
            touchMemoryUsage(session.user_id, injectedMemoryIds)
          }
        }
      } catch (err) {
        // D4: 记忆注入失败不阻断 chat,但生产也要有可观测信号(原来仅 dev warn)。
        logWarn('memory.inject', err, { userId: session?.user_id })
      }

      const billingConfig = loadBillingConfig(getRuntimeEnv())
      // ★ 本地模型(Ollama / LM Studio)跑在用户自己电脑上,没有上游 API 成本,
      // 不该扣积分。以前一律按 token 估算收费 —— 用自己的显卡还要付钱。
      const localModel = isLocalModelEndpoint(requestConfig?.baseUrl)
      estimatedCost = localModel
        ? 0
        : estimateChatCost({
          modelName: selectedModel,
          messages,
          config: billingConfig,
        })
      if (account.credits < estimatedCost) {
        sendJson(res, 402, {
          ok: false,
          error: `积分不足，需要 ${estimatedCost} 积分，当前余额 ${account.credits}。请先充值。`,
          requiredCredits: estimatedCost,
          credits: account.credits,
        })
        return
      }
    }

    if (useStream && !testMode) {
      // SSE 流式响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      // ★ #38: 客户端断开 → abort 上游 fetch 避免空转烧 token
      const sseAbort = new AbortController()
      let clientGone = false
      const onClose = () => {
        clientGone = true
        sseAbort.abort()
      }
      req.on('close', onClose)

      const safeWrite = (payload) => {
        if (clientGone || res.writableEnded || res.destroyed) return false
        return res.write(payload)
      }

      const started = Date.now()
      let streamUsage = null
      try {
        for await (const event of streamOpenAICompatible({
          config: requestConfig,
          messages,
          tools: body.tools,
          toolChoice: body.tool_choice,
          externalSignal: sseAbort.signal,
        })) {
          if (clientGone) break
          if (event.type === 'text') {
            safeWrite(`data: ${JSON.stringify({ ok: true, delta: event.delta, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'tool_calls') {
            // 工具调用轮:usage 帧若已单独到达就不重复记,否则用终止帧带的兜底
            if (event.usage && !streamUsage) {
              streamUsage = event.usage
              recordUsage(selectedModel, event.usage)
            }
            safeWrite(`data: ${JSON.stringify({ ok: true, toolCalls: event.toolCalls, finishReason: event.finishReason, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'usage') {
            // 不单独下发,攒到 done 帧一起给,避免前端多处理一种帧型
            streamUsage = event.usage
            recordUsage(selectedModel, event.usage)
          }
        }
        // 扣费 — 客户端断了就跳过,不收钱
        if (!clientGone) {
          let chargedBilling = null
          let billingError = null
          try {
            chargedBilling = chargeForModelUse({ token, modelName: selectedModel, cost: estimatedCost })
          } catch (chargeErr) {
            // 扣费失败(余额不够等)不阻断已经流出去的内容,但要告诉前端
            billingError = chargeErr.message
          }
          if (session?.user_id) {
            dispatchHooks({
              userId: session.user_id,
              event: 'stop',
              tool: 'chat',
              args: { latency: Date.now() - started, stream: true },
            }).catch((err) => {
              console.warn('[hooks] stop hook 失败 (stream):', err?.message || err)
            })
          }
          // done 帧带上 billing,前端能在 stream 收尾时拿到本轮实际消耗,
          // 用于工具调用循环里"多轮累计计费"显示.放一起避免被 done 后的 return 截断.
          safeWrite(`data: ${JSON.stringify({
            ok: true,
            done: true,
            latency: Date.now() - started,
            injectedMemoryIds,
            usage: streamUsage,
            billing: {
              creditsCharged: estimatedCost,
              credits: chargedBilling?.user?.credits ?? null,
              error: billingError,
            },
          })}\n\n`)
        }
      } catch (err) {
        // AbortError 来自客户端断开,不当成错误回写
        if (!clientGone && err?.name !== 'AbortError') {
          safeWrite(`data: ${JSON.stringify({ ok: false, error: formatProxyError(err) })}\n\n`)
        }
      } finally {
        req.off('close', onClose)
      }
      if (!res.writableEnded) res.end()
      return
    }

    // 非流式响应（测试模式或前端未启用 stream）
    const started = Date.now()
    const reply = await (async () => {
      const { url, init } = buildOpenAICompatibleRequest({ config: requestConfig, messages })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        const text = await response.text()
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
        if (!response.ok) {
          const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
          const error = new Error(message)
          error.status = response.status
          throw error
        }
        // usage 只读不改返回类型 —— parseOpenAICompatibleResponse 返回裸字符串,
        // 多处调用点直接当字符串用,不能在这里改形状。
        recordUsage(selectedModel, extractUsage(data))
        return parseOpenAICompatibleResponse(data)
      } finally {
        clearTimeout(timeout)
      }
    })()

    let billing = null
    if (!testMode) {
      billing = chargeForModelUse({ token, modelName: selectedModel, cost: estimatedCost })
      if (session?.user_id) {
        dispatchHooks({
          userId: session.user_id,
          event: 'stop',
          tool: 'chat',
          args: { latency: Date.now() - started, stream: false },
        }).catch((err) => {
          console.warn('[hooks] stop hook 失败 (non-stream):', err?.message || err)
        })
      }
    }
    sendJson(res, 200, {
      ok: true,
      reply,
      latency: Date.now() - started,
      creditsCharged: estimatedCost,
      user: billing?.user,
      injectedMemoryIds,
      ...(testMode ? { compilerFingerprints } : {}),
    })
  } catch (error) {
    // ★ #36: 尊重 readJson 抛的 413 (request body too large)
    let status
    if (error?.statusCode) status = error.statusCode
    else if (/请先登录/.test(error?.message || '')) status = 401
    else status = 502
    sendJson(res, status, { ok: false, error: formatProxyError(error) })
  }
}

export async function handleModelStatusRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '仅支持 GET 请求。' })
    return
  }
  // 鉴权:匿名访问会泄露 baseUrl / MAIL_* 等内部基础设施信息.
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  sendJson(res, 200, getModelStatus(buildUserModelEnv({ userId, env: getRuntimeEnv() })))
}

export async function handleSystemDiagnosticsRequest(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '仅支持 GET 请求。' })
    return
  }
  // 鉴权:?check=1 会触发后端发出 outbound 探测请求,匿名暴露 = 任意来源都能让本服务去打上游模型端点.
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  const url = new URL(req.url, 'http://localhost')
  const checkEndpoint = url.searchParams.get('check') === '1'
  const env = buildUserModelEnv({ userId, env: getRuntimeEnv() })
  sendJson(res, 200, await getSystemDiagnostics({ env, checkEndpoint }))
}

export function modelProxyPlugin() {
  return {
    name: 'local-model-proxy',
    configureServer(server) {
      server.middlewares.use('/api/system/diagnostics', handleSystemDiagnosticsRequest)
      server.middlewares.use('/api/model/status', handleModelStatusRequest)
      server.middlewares.use('/api/model/test', handleModelProxyRequest)
      server.middlewares.use('/api/model/chat', handleModelProxyRequest)
    },
  }
}
