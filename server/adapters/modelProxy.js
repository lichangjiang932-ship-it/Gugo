import { z } from 'zod'
import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { getMailDiagnostics, getPublicAccount } from './authAccount.js'
import { checkRateLimit, getSessionByToken } from '../db.js'
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
  buildSafetyBlock,
  buildSkillsBlock,
  buildSessionsBlock,
  getPromptCompilerStats,
} from '../services/promptCompiler.js'
import { attachVisionDescriptions, hasVisionAssistConfigured, replaceUnsupportedVisionContent } from './visionAssist.js'
import { prepareToolLoopVision } from './modelToolLoopVision.js'
import { logWarn } from '../utils/logger.js'
import { withRetry } from '../utils/modelRetry.js'
import { isLocalEndpoint, resolveEndpointProfile } from '../utils/endpointProfile.js'
import { buildUserModelEnv } from '../services/modelProviderStore.js'
import { scheduleAutoMemoryExtraction } from '../services/autoMemoryService.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { bindSseClientDisconnect, createEmptyModelResponseError } from './sseLifecycle.js'
import { fetchWithEnvProxy } from './proxyFetch.js'
import { normalizeModelContentForEndpoint } from '../utils/modelContentCapabilities.js'
import {
  buildNativeProviderRequest,
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  finishNativeProviderStream,
  isNativeProviderKind,
} from './nativeModelProviders.js'
import {
  extractModelResponseError,
  extractUsage,
  parseModelProviderResponse,
  stripEmbeddedReasoning,
} from './modelProviderResponse.js'
import { createTextToolCallDeltaFilter, extractTextToolCalls } from '../utils/textToolCalls.js'
import { calculateModelCostUsd, getUsageStats, recordUsage } from './modelUsage.js'
import { requestNonStreamingAsEvents } from './modelNonStreaming.js'
import {
  createCompatibleModelStreamState,
  decodeModelStreamLine,
  normalizeCompatibleModelStreamPayload,
  readJsonModelResponseEvents,
  readModelSseLines,
} from './modelResponseStream.js'
import { buildVisibleModelCatalog, parseRemoteModelCatalog } from '../utils/modelCatalog.js'

export { extractUsage, parseModelProviderResponse, parseOpenAICompatibleResponse, stripEmbeddedReasoning } from './modelProviderResponse.js'
export { getUsageStats, recordUsage, resetUsageStats } from './modelUsage.js'

export { getRuntimeEnv } from '../utils/runtimeEnv.js'

// ★ #18: 消息格式 schema — 拒绝畸形 messages 入参,避免无效上游请求
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

export function getModelProviders(env = process.env) {
  const ids = parseCsv(env.MODEL_PROVIDERS)
  return ids.map((id) => {
    const prefix = providerEnvPrefix(id)
    return {
      id,
      label: env[`${prefix}_LABEL`]?.trim() || '',
      baseUrl: env[`${prefix}_BASE_URL`]?.trim() || '',
      apiKey: env[`${prefix}_API_KEY`]?.trim() || '',
      models: parseCsv(env[`${prefix}_MODELS`]),
      headers: parseHeaders(env[`${prefix}_HEADERS`]),
      // ★ v28:per-provider 能力/超时覆盖(见 modelProviderStore.buildProviderOverrides)
      profileOverrides: parseProfileOverrides(env[`${prefix}_PROFILE`]),
    }
  })
}

function parseProfileOverrides(raw) {
  if (!raw) return {}
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
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

/** 解析输出 token 上限；0 表示不发送 max_tokens，使用模型自身上限。 */
function parseMaxTokens(raw) {
  const text = String(raw ?? '').trim()
  // 未设置 → 默认不限制
  if (!text) return 0
  // 显式写 0 / unlimited / none → 不限制
  if (['0', 'unlimited', 'none', 'inf', 'infinite'].includes(text.toLowerCase())) return 0
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function loadModelConfig(env = process.env) {
  const providers = getModelProviders(env)
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim())
  const temperature = Number(env.MODEL_TEMPERATURE ?? 0.7)
  const maxTokens = parseMaxTokens(env.MODEL_MAX_TOKENS)

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
      ...(Object.keys(provider?.profileOverrides || {}).length
        ? { profileOverrides: provider.profileOverrides }
        : {}),
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      maxTokens,
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
    maxTokens,
  }
}

export function resolveModelConfigForModel({ modelName, env = process.env } = {}) {
  const base = loadModelConfig(env)
  const selectedModel = modelName?.trim() || base.modelName
  const provider = findProviderForModel(selectedModel, env)
  if (!provider) {
    const conservative = { ...base, modelName: selectedModel }
    delete conservative.profileOverrides
    delete conservative.modelProfiles
    return conservative
  }

  const missing = providerMissingFields(provider)
  const baseWithoutHeaders = { ...base }
  delete baseWithoutHeaders.headers
  delete baseWithoutHeaders.profileOverrides
  return {
    ...baseWithoutHeaders,
    configured: missing.length === 0,
    missing,
    baseUrl: provider.baseUrl,
    modelName: selectedModel,
    apiKey: provider.apiKey,
    ...(Object.keys(provider.headers || {}).length ? { headers: provider.headers } : {}),
    // 和 headers 同样的口径:没有内容就不带这个 key,
    // 免得给每个 config 都挂一个空对象(也会打乱调用方的 deepEqual)。
    ...(Object.keys(provider.profileOverrides || {}).length
      ? { profileOverrides: provider.profileOverrides }
      : {}),
  }
}

// 故障转移分类/执行逻辑已抽到 ./modelFailover.js(单一来源,也压 modelProxy 行数)。
import { runWithProviderFailover, streamWithProviderFailover } from './modelFailover.js'
export { isProviderFailoverError, runWithProviderFailover, streamWithProviderFailover } from './modelFailover.js'

export function resolveModelFailoverConfigs({ modelName, env = process.env } = {}) {
  const base = loadModelConfig(env)
  const selectedModel = modelName?.trim() || base.modelName
  const primary = resolveModelConfigForModel({ modelName: selectedModel, env })
  const configs = [{ ...primary, providerId: findProviderForModel(selectedModel, env)?.id || 'default' }]

  // ★ 是否允许「转移到一个**不同名**的模型」。默认 **不允许**。
  //
  // 事故:用户在 UI 里选了 deepseek-v4-flash,deepseek 那边
  // 一个网络抖动就触发转移,而 mimo provider 不提供这个模型名,
  // 于是回落到 provider.models[0] = mimo-v2.5 —— 换了个**厂商的另一个模型**
  // 跑完。用户看到的是「我选的 flash,实际执行的却不是 flash」。
  //
  // 跨模型转移会改变输出与成本边界,必须显式开启。
  // 同名模型在多个 provider 之间转移(镜像/中转站)是安全的,默认保留。
  //
  // 两种显式开启方式,任一即可:
  //   - 全局 env MODEL_FAILOVER_CROSS_MODEL=1
  //   - 在主 provider 的设置里**显式勾选** failoverEnabled
  //     —— 用户在 UI 上主动打开,就是明确知道并接受会换模型。
  //
  // ⚠ 这里必须看 override 本身,而不是 profile.failoverEligible ——
  // 后者对云端 provider **默认就是 true**(那只是"允许同名转移"的默认值,
  // 不代表用户同意换模型)。用它判断等于这道防线对所有云端 provider 失效,
  // 也就完全没修到事故本身。
  const primaryOverrides = configs[0]?.profileOverrides || {}
  // 默认严格粘滞：UI/调用方请求哪个模型，实际执行就只能使用同名模型。
  // 即使某个 provider 遗留了 failoverEnabled=true，也不能越权换成另一个模型。
  const strictSelection = String(env.MODEL_STRICT_SELECTION ?? '1').trim() !== '0'
  const crossModelOptIn = primaryOverrides.failoverEnabled === true
    || primaryOverrides.failoverEnabled === 1
  const allowCrossModel = !strictSelection && (
    String(env.MODEL_FAILOVER_CROSS_MODEL || '').trim() === '1' || crossModelOptIn
  )

  for (const provider of getModelProviders(env)) {
    if (providerMissingFields(provider).length) continue
    const hasSameModel = provider.models.includes(selectedModel)
    if (!hasSameModel && !allowCrossModel) continue
    const candidateModel = hasSameModel ? selectedModel : provider.models[0]
    if (!candidateModel) continue
    configs.push({
      ...base,
      configured: true,
      missing: [],
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      modelName: candidateModel,
      apiKey: provider.apiKey,
      ...(Object.keys(provider.headers || {}).length ? { headers: provider.headers } : {}),
      ...(Object.keys(provider.profileOverrides || {}).length
        ? { profileOverrides: provider.profileOverrides }
        : {}),
    })
  }
  const seen = new Set()
  const deduped = configs.filter((config) => {
    if (!config.configured) return false
    const key = `${config.baseUrl}\u0000${config.modelName}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // ★ 主 provider 是本地端点时,**不返回任何备选**。
  //
  // 本地推理慢是常态(加载权重几十秒、CPU 1-3 tok/s),而慢会走到失败路径,
  // 失败路径又会挨个尝试后面的 provider —— 结果就是「我明明选了本地模型,
  // 却在用云端资源」。用户不知道模型已经切换,输出风格也会突然变化。
  //
  // 想要这个行为的人可以在 provider 设置里显式打开 failover_enabled。
  const primaryProfile = deduped.length ? profileForConfig(deduped[0], env) : null
  if (primaryProfile && !primaryProfile.failoverEligible) return deduped.slice(0, 1)

  return deduped
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
    message.content.some((part) => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url)
  )
}

// ★ DEFAULT_MODEL_CONTEXT_WINDOW / parseContextWindowMap 已移入
// server/utils/endpointProfile.js —— 上下文窗口的解析(含按模型映射、
// 本地/云端默认值、下限)现在只有那一处实现,避免两边漂移。

export function getModelContextWindow({ modelName, userId, env = getRuntimeEnv() } = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const selectedModel = String(modelName || runtimeEnv.MODEL_NAME || '').trim()
  const config = resolveModelConfigForModel({ modelName: selectedModel, env: runtimeEnv })
  // ★ 交给端点画像统一解析。
  //
  // 原来默认值是 1_000_000 —— 用户没配 MODEL_CONTEXT_WINDOWS 时,压缩阈值
  // 被算成 80 万 token,对着一个 8k 窗口的本地模型**主动压缩永远不会触发**,
  // 直接一头撞进上游的 400。而且原来还有 `>= 4096` 的硬下限,
  // 真有 2k/4k 窗口的小模型也配不下去。
  // 现在本地默认 8192、云端默认 128k,且允许配到 1024。
  return resolveEndpointProfile({
    baseUrl: config.baseUrl,
    modelName: selectedModel,
    env: runtimeEnv,
    overrides: config.profileOverrides || {},
  }).contextWindow
}

export function supportsVisionModel(modelName = '', env = process.env, baseUrl = '', overrides = {}) {
  return resolveEndpointProfile({ baseUrl, modelName, env, overrides }).supportsVision
}

/**
 * 这个模型能不能用 function calling。
 * 口径和 supportsVisionModel 对齐:白名单一旦设置就是精确名单,
 * 没设置则回落到端点画像的推断(见 endpointProfile.js 的 KIND_CAPABILITIES)。
 */
export function supportsToolsModel(modelName = '', env = process.env, baseUrl = '') {
  return resolveEndpointProfile({ baseUrl, modelName, env }).supportsTools
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
  if (models.length) {
    status.models = models
    const activeModel = models.find((model) => model.active) || models[0]
    status.contextWindow = activeModel.contextWindow
    status.contextWindowSource = activeModel.contextWindowSource
    status.contextWindowEstimated = activeModel.contextWindowEstimated
    if (activeModel.contextWindowSourceUrl) status.contextWindowSourceUrl = activeModel.contextWindowSourceUrl
    if (activeModel.contextWindowVerifiedAt) status.contextWindowVerifiedAt = activeModel.contextWindowVerifiedAt
    if (activeModel.maxOutputTokens) status.maxOutputTokens = activeModel.maxOutputTokens
  }
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
 * ★ 本地模型跑在用户自己的电脑上,其超时和故障转移策略应区别于云端 API。
 */
export function isLocalModelEndpoint(baseUrl = '') {
  // ★ 判定逻辑已收敛到 server/utils/endpointProfile.js。
  // 原来只认回环地址,于是局域网(192.168.x)/ Docker(172.17.x)/ Tailscale(100.64.x)
  // 上的 Ollama 全部漏判 —— 会按云端超时砍流,还可能错误地 failover 到云端。
  return isLocalEndpoint(baseUrl)
}

/**
 * 拿一个 config 的端点画像。config 上带的 profileOverrides(来自 provider 设置 /
 * 端点探测)优先级最高。所有超时/能力判断都该走这里,不要再各处硬编码常量。
 */
export function profileForConfig(config = {}, env = process.env) {
  return resolveEndpointProfile({
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    env,
    overrides: config.profileOverrides || {},
    modelProfiles: config.modelProfiles || null,
  })
}

/**
 * 造一个「我们自己的超时」错误。
 *
 * ★ 关键:**不设 status**。原来超时被伪装成 `status: 504`,而
 * isProviderFailoverError 判定 `status >= 500` 可故障转移,于是
 * 「本地模型慢一点」→ 静默切到云端 provider 会改变隐私与成本边界。
 * 同时 504 在 RETRYABLE_STATUS 里,导致对着单槽推理服务器重试 3 次,越重试越慢。
 */
export function modelTimeoutError(message, { phase = 'request', timeoutMs = 0 } = {}) {
  const error = new Error(message)
  error.code = 'MODEL_TIMEOUT'
  error.timeoutPhase = phase
  error.timeoutMs = timeoutMs
  return error
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

async function checkModelsEndpoint({ config, fetchImpl = fetchWithEnvProxy, env = process.env }) {
  if (!config.configured) {
    return { checked: false, ok: false, reason: `缺少 ${config.missing.join(', ')}` }
  }

  const profile = profileForConfig(config, env)
  const url = normalizeModelsUrl(config.baseUrl)
  const controller = new AbortController()
  const started = Date.now()
  // ★ 原来固定 8s。Ollama 冷启动 / 正在加载模型时必然超时,
  // 用户看到的是「端点不可达」—— 其实服务好好的,只是慢。
  const timeout = setTimeout(() => controller.abort(), profile.timeouts.probeMs)
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
    const { remoteModels, remoteModelProfiles } = parseRemoteModelCatalog(data)
    return {
      checked: true,
      ok: true,
      url,
      latency: Date.now() - started,
      remoteModels,
      remoteModelProfiles,
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

export async function getSystemDiagnostics({ env = process.env, fetchImpl = fetchWithEnvProxy, checkEndpoint = false } = {}) {
  const config = loadModelConfig(env)
  const modelStatus = getModelStatus(env)
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
  const providerModelEntries = providers.flatMap((provider) => provider.models.map((name) => ({
    name,
    provider: provider.id,
    providerLabel: provider.label,
  })))
  const names = providerModelEntries.length ? providerModelEntries.map((entry) => entry.name) : parseCsv(env.MODEL_NAMES || defaultModel)
  return buildVisibleModelCatalog({
    names, defaultModel, providerModelEntries, resolveProfile: (name) => profileForConfig(resolveModelConfigForModel({ modelName: name, env }), env),
  })
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

/**
 * 合并开头连续的 system 消息。
 *
 * ★ 本项目把前置上下文拆成多个独立 system block(identity / ishiki / skills /
 * sessions / memory),这在云端 API 上没问题,但 LM Studio 会直接崩:
 *   Engine protocol predict request returned 400:
 *   Unable to generate parser for this template.
 * 实测 1 个 system 正常、2 个及以上必炸、合并回 1 个又正常 —— 它的 chat
 * template 只处理单个 system,多个就生成不出 parser。
 *
 * 现象很迷惑:HTTP 200 + text/event-stream,但流里只有一个 error 事件就断了,
 * 用户看到的是「不到 2 秒就结束、没有任何回复」。
 *
 * 合并是无损的 —— 拼接后语义完全一致,而且本来就都是发给模型的前置指令。
 * 只合并开头连续的那一段,中间穿插的 system(比如工具循环里插的收尾指令)
 * 不动,避免打乱对话结构。
 */
function mergeLeadingSystemMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length < 2) return messages
  let end = 0
  while (end < messages.length && messages[end]?.role === 'system') end += 1
  if (end < 2) return messages

  const merged = messages
    .slice(0, end)
    // ★ 原来这里是 `typeof m.content === 'string' ? m.content : ''` + filter(Boolean),
    // 于是 content 是数组形式(multimodal)的 system 消息会被**静默丢掉** ——
    // 内容凭空消失,模型看不到那段指令,而且没有任何报错。
    // 现在把数组里的文本段落提取出来,不丢内容。
    .map((m) => systemContentToText(m?.content))
    .filter(Boolean)
    .join('\n\n')

  return [{ role: 'system', content: merged }, ...messages.slice(end)]
}

/** 把 system 消息的 content 归一成纯文本。字符串原样返回;数组提取其中的 text 段。 */
function systemContentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (typeof part?.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeMessagesForOpenAI(messages = []) {
  return mergeLeadingSystemMessages(messages).map((message) => {
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

export function buildOpenAICompatibleRequest({
  config,
  messages,
  stream = false,
  tools,
  toolChoice,
  env = process.env,
  profile = null,
}) {
  const endpoint = profile || profileForConfig(config || {}, env)
  const model = config?.modelName
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
    messages: normalizeModelContentForEndpoint(normalizeMessagesForOpenAI(messages), endpoint),
    temperature: config?.temperature ?? 0.7,
    stream,
  }
  // ★ max_tokens 为 0/未设置 = 不限制 → **不发这个字段**,让模型用自己的上限。
  // 发一个大数字不如不发:各家真实上限不同,填超了有些 provider 直接 400。
  const outputCap = Number(config?.maxTokens)
  if (Number.isFinite(outputCap) && outputCap > 0) {
    body.max_tokens = outputCap
  }
  // ★ 工具调用:仅当上游提供 tools 字段时才透传,避免不支持工具的模型报 400
  //
  // 增加能力门控:端点画像说不支持 function calling 时(比如 llama.cpp 默认、
  // 或用户在 provider 里显式关掉),**直接不发 tools**。原来无脑下发,
  // 不支持的小模型直接 400,整轮报废且错误信息完全看不懂。
  if (Array.isArray(tools) && tools.length > 0 && endpoint.supportsTools) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
    if (endpoint.supportsParallelTools) body.parallel_tool_calls = true
  }
  // ★ Ollama keep_alive:不设的话默认 5 分钟就卸载模型,下次请求重新加载权重。
  // 「本地模型延迟太大」有很大一部分就是反复冷加载 —— 常驻内存后首 token 从
  // 几十秒降到亚秒级。非 Ollama 端点 keepAlive 为 null,不会带上这个字段。
  if (endpoint.keepAlive) {
    body.keep_alive = endpoint.keepAlive
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

export function buildModelProviderRequest(args = {}) {
  const profile = args.profile || profileForConfig(args.config || {}, args.env)
  if (isNativeProviderKind(profile.kind)) {
    return buildNativeProviderRequest({ ...args, profile })
  }
  return buildOpenAICompatibleRequest({ ...args, profile })
}

/**
 * 给一次非流式上游请求套一个超时。
 *
 * ★ 两个要点:
 *   1. 计时器必须在**每次尝试内部**起 —— 原来非流式 chat 的 timer 起在
 *      withRetry 外面,3 次重试共用同一个 60s 预算,第 2 次尝试往往一开始
 *      就已经没时间了。
 *   2. 外部 signal(用户取消 / 客户端断开)和超时要能同时生效,
 *      且要能区分:用户取消是 AbortError,超时是 MODEL_TIMEOUT。
 */
async function fetchWithTimeout(fetchImpl, url, init, { timeoutMs, externalSignal, phase = 'request' }) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let onExternalAbort = null
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else {
      onExternalAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      const err = modelTimeoutError(
        `模型 ${Math.round(timeoutMs / 1000)} 秒内没有响应。本地模型可尝试调大 MODEL_BACKGROUND_TIMEOUT_MS，或确认服务未卡死。`,
        { phase, timeoutMs },
      )
      err.cause = error
      throw err
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

export async function callBackgroundModel({
  messages,
  modelName,
  userId,
  env = getRuntimeEnv(),
  fetchImpl = fetchWithEnvProxy,
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
  const candidates = resolveModelFailoverConfigs({ modelName: selectedModel, env: runtimeEnv })
  return runWithProviderFailover(candidates, async (candidate) => {
    const profile = profileForConfig(candidate, runtimeEnv)
    const { url, init } = buildModelProviderRequest({
      config: candidate,
      messages,
      stream: false,
      env: runtimeEnv,
      profile,
    })
    return withRetry(async () => {
      // ★ 原来这里完全没有超时 —— 一个挂死的本地端点会让 job 永远卡在
      // running,不发事件、不发通知,只能重启进程。
      const response = await fetchWithTimeout(fetchImpl, url, init, {
        timeoutMs: profile.timeouts.backgroundMs,
        externalSignal: signal,
        phase: 'background',
      })
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
        error.fromUpstream = true
        error.retryAfter = response.headers?.get?.('retry-after') ?? null
        throw error
      }
      const parsed = parseModelProviderResponse(data, profile)
      recordUsage(candidate.modelName, parsed.usage)
      if (!parsed.content) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
      return parsed.content
    }, {
      signal,
      onRetry: ({ attempt, delayMs, error }) => {
        logWarn('model.retry', error, { attempt, delayMs, model: candidate.modelName, provider: candidate.providerId })
      },
    })
  }, { signal })
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
  fetchImpl = fetchWithEnvProxy,
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
  const candidates = resolveModelFailoverConfigs({ modelName: selectedModel, env: runtimeEnv })
  return runWithProviderFailover(candidates, async (candidate) => {
    const profile = profileForConfig(candidate, runtimeEnv)
    const { url, init } = buildModelProviderRequest({
      config: candidate,
      messages,
      stream: false,
      tools,
      toolChoice,
      env: runtimeEnv,
      profile,
    })
    return withRetry(async () => {
      const response = await fetchWithTimeout(fetchImpl, url, init, {
        timeoutMs: profile.timeouts.backgroundMs,
        externalSignal: signal,
        phase: 'background',
      })
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
        error.code = data?.error?.code || data?.code || ''
        error.type = data?.error?.type || data?.type || ''
        error.fromUpstream = true
        error.retryAfter = response.headers?.get?.('retry-after') ?? null
        throw error
      }
      const parsed = parseModelProviderResponse(data, profile)
      const compatibilityCall = parsed.toolCalls?.length ? null : extractTextToolCalls(parsed.content)
      const usage = parsed.usage
      recordUsage(candidate.modelName, usage)
      return {
        content: compatibilityCall?.detected ? compatibilityCall.content : parsed.content,
        toolCalls: compatibilityCall?.toolCalls?.length ? compatibilityCall.toolCalls : parsed.toolCalls,
        usage,
        modelName: candidate.modelName,
        costUsd: calculateModelCostUsd({ modelName: candidate.modelName, usage, env: runtimeEnv }),
      }
    }, {
      signal,
      onRetry: ({ attempt, delayMs, error }) => {
        logWarn('model.retry', error, { attempt, delayMs, model: candidate.modelName, provider: candidate.providerId })
      },
    })
  }, { signal })
}

function canonicalStreamToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => {
    const fn = call?.function && typeof call.function === 'object' ? call.function : {}
    const rawArguments = fn.arguments ?? call?.arguments ?? '{}'
    let argumentsText
    if (typeof rawArguments === 'string') argumentsText = rawArguments
    else {
      try { argumentsText = JSON.stringify(rawArguments ?? {}) } catch { argumentsText = '{}' }
    }
    return {
      ...(call?.id ? { id: call.id } : {}),
      type: call?.type || 'function',
      function: {
        name: String(fn.name || call?.name || ''),
        arguments: argumentsText,
      },
    }
  })
}

/**
 * Chat tool-loop model call with the same stable result shape as
 * callBackgroundModelWithTools, but backed by the provider streaming adapter.
 *
 * Text and reasoning are delivered while the provider is still generating;
 * the canonical tool_calls batch is retained until the stream finishes so the
 * durable tool-loop checkpoint remains identical to the non-streaming path.
 */
export async function callStreamingModelWithTools({
  messages,
  tools,
  toolChoice,
  modelName,
  userId,
  env = getRuntimeEnv(),
  fetchImpl = fetchWithEnvProxy,
  signal,
  onTextDelta,
  onReasoningDelta,
  onToolCallReady,
  onFailover,
  onRetry,
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
  const { messages: preparedMessages, candidates } = await prepareToolLoopVision({
    messages,
    candidates: resolveModelFailoverConfigs({ modelName: selectedModel, env: runtimeEnv }),
    requiresVision: hasVisionContent(messages),
    supportsVision: (candidate) => profileForConfig(candidate, runtimeEnv).supportsVision,
    userId, env: runtimeEnv, fetchImpl, modelName: selectedModel,
    onAssistError: (error) => logWarn('vision.assist.tool_loop', error, { userId, modelName: selectedModel }),
  })
  let activeConfig = candidates[0] || null
  let content = ''
  let reasoningChars = 0
  let toolCalls = []
  let usage = null
  let finishReason = null
  const textToolCallFilter = createTextToolCallDeltaFilter()

  for await (const streamed of streamWithProviderFailover(
    candidates,
    (candidate) => streamOpenAICompatible({
      config: candidate,
      messages: preparedMessages,
      fetchImpl,
      tools,
      toolChoice,
      externalSignal: signal,
      env: runtimeEnv,
    }),
    { signal, onFailover, onRetry },
  )) {
    activeConfig = streamed.config
    const event = streamed.event
    if (event?.usage) usage = event.usage
    if (event?.finishReason) finishReason = event.finishReason

    if (event?.type === 'text' && event.delta) {
      const delta = String(event.delta)
      content += delta
      if (typeof onTextDelta === 'function') {
        const visibleDelta = textToolCallFilter.push(delta)
        if (visibleDelta) await onTextDelta(visibleDelta, { modelName: activeConfig.modelName })
      }
    } else if (event?.type === 'reasoning' && event.delta) {
      const delta = String(event.delta)
      reasoningChars += delta.length
      if (typeof onReasoningDelta === 'function') {
        await onReasoningDelta(delta, { modelName: activeConfig.modelName })
      }
    } else if (event?.type === 'tool_call_ready') {
      // This is activity evidence only. The canonical tool_calls batch remains
      // buffered until the provider finishes, so checkpointing and execution
      // still happen exactly once through the normal tool-loop path.
      const readyCall = canonicalStreamToolCalls([event.toolCall])[0]
      if (readyCall?.function?.name && typeof onToolCallReady === 'function') {
        await onToolCallReady(readyCall, {
          index: event.index,
          modelName: activeConfig.modelName,
        })
      }
    } else if (event?.type === 'tool_calls') {
      toolCalls = canonicalStreamToolCalls(event.toolCalls)
    }
  }

  const resolvedConfig = activeConfig || config
  const cleanedContent = stripEmbeddedReasoning(content)
  const compatibilityCall = toolCalls.length ? null : extractTextToolCalls(cleanedContent)
  const filteredContent = compatibilityCall?.detected ? compatibilityCall.content : cleanedContent
  const filteredToolCalls = compatibilityCall?.toolCalls?.length ? compatibilityCall.toolCalls : toolCalls
  if (typeof onTextDelta === 'function') {
    const tail = textToolCallFilter.finish({ discardProtocol: Boolean(compatibilityCall?.detected) })
    if (tail) await onTextDelta(tail, { modelName: resolvedConfig.modelName })
  }
  recordUsage(resolvedConfig.modelName, usage)
  return {
    content: filteredContent,
    toolCalls: filteredToolCalls,
    usage,
    finishReason,
    modelName: resolvedConfig.modelName,
    costUsd: calculateModelCostUsd({ modelName: resolvedConfig.modelName, usage, env: runtimeEnv }),
    streamed: true,
    reasoningChars,
  }
}

/**
 * 这个错误是不是「上下文塞不下了」。
 *
 * ★ 原实现只认 status 400 + OpenAI 的错误文案。但本地推理服务器各说各话:
 *   llama.cpp : "the request exceeds the available context size"
 *   Ollama    : 各种泛化文案,有时还带 n_ctx
 *   vLLM      : "This model's maximum context length is ..."
 *   有些实现直接返 413(Payload Too Large)甚至 500,压根不是 400。
 *
 * 认不出来的后果很严重:contextCompactionRuntime 的三级恢复
 * (主动压缩 → 强制压缩 → 裁剪最旧)**每一级都以这个判定为门**,
 * 认不出就一级都不走,错误直接冒上去把 job 判 failed。
 * 用户看到的是一句莫名其妙的 "Bad Request"。
 */
export function isContextLengthError(error) {
  const detail = [error?.message, error?.code, error?.type].filter(Boolean).join(' ')
  if (!detail) return false
  const status = Number(error?.status)
  // 413 一定是「请求体太大」;400/500 要看文案
  const statusLooksRight = status === 400 || status === 413 || status === 500 || !Number.isFinite(status)
  if (!statusLooksRight) return false
  return /context_length|context window|context size|token.?limit|maximum context|reduce the length|too many tokens|exceeds?\s+the\s+(available\s+)?context|n_ctx|prompt is too long|kv cache|input is too long|too long for the model/i
    .test(detail)
}

export function formatProxyError(error) {
  const msg = error?.message || ''

  // ★ 我们自己判定的超时。消息里已经带了阶段和建议(见 modelTimeoutError 调用点),
  // 直接透出去比套一层泛化文案有用得多。
  if (error?.code === 'MODEL_TIMEOUT') return msg || '模型请求超时。'

  // ★ 诊断增强: 400 错误可能是 token 溢出或参数真的无效
  if (error?.status === 400) {
    if (isContextLengthError(error)) {
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

/**
 * 流式调用上游。
 *
 * ★ 超时策略从「整请求 120s」改成「首 token + idle 双轨」。
 *
 * 原来一个 setTimeout(120s) 管整个请求 —— 意味着一个健康的、正在稳定吐字的
 * 本地模型,会在第 120 秒被拦腰砍断,用户看到半句话。CPU 推理 1-3 tok/s 时
 * 两分钟连一段话都写不完,基本必然触发。
 *
 * 现在分两个计时器:
 *   - 首 token 计时器:从发请求到第一个 chunk。本地默认 10 分钟(加载权重可能很久)。
 *     收到第一个 chunk 后**立即清掉**,之后不再有任何整体上限。
 *   - idle 计时器:每收到一个 chunk 就重置。含义是「N 秒一个字节都没有 = 真挂了」。
 *     只要还在吐字,想吐多久吐多久。
 */
export async function* streamOpenAICompatible({
  config,
  messages,
  fetchImpl = fetchWithEnvProxy,
  tools,
  toolChoice,
  externalSignal,
  env = process.env,
  onFirstByte = null,
}) {
  const profile = profileForConfig(config, env)
  if (!profile.supportsStreaming) {
    yield* requestNonStreamingAsEvents({
      config,
      messages,
      fetchImpl,
      tools,
      toolChoice,
      externalSignal,
      env,
      profile,
      onFirstByte,
      buildRequest: buildModelProviderRequest,
      createTimeoutError: modelTimeoutError,
    })
    return
  }
  const { url, init } = buildModelProviderRequest({ config, messages, stream: true, tools, toolChoice, profile })
  const controller = new AbortController()

  let timedOutPhase = null
  let timeoutMs = 0
  let timer = null

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const armTimer = (phase, ms) => {
    clearTimer()
    timeoutMs = ms
    timer = setTimeout(() => {
      timedOutPhase = phase
      controller.abort()
    }, ms)
  }

  // 阶段 1:等首个字节
  armTimer('first_token', profile.timeouts.firstTokenMs)

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
      error.fromUpstream = true
      throw error
    }

    const jsonEvents = await readJsonModelResponseEvents(response, profile, { onFirstByte })
    if (jsonEvents) { yield* jsonEvents; return }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('无法读取流式响应')

    // ★ tool_call 增量合并:OpenAI 流式协议每个 chunk 给 tool_calls[i].function.arguments 的片段,需要按 index 累加
    const toolCallAcc = new Map() // index -> { id, name, arguments }
    const readyToolCallIndexes = new Set()
    const nativeStreamState = isNativeProviderKind(profile.kind)
      ? createNativeProviderStreamState(profile.kind)
      : null
    const compatibleStreamState = createCompatibleModelStreamState()
    let finishReason = null
    // 思考累计字数 + 上限(0 = 不限)。见下面 REASONING_RUNAWAY 的注释。
    let reasoningChars = 0
    const reasoningCharLimit = (() => {
      const executionWithTools = Array.isArray(tools)
        && tools.length > 0
        && String(toolChoice || '').toLowerCase() !== 'none'
      const configured = executionWithTools
        ? (env?.MODEL_EXECUTION_REASONING_MAX_CHARS ?? env?.MODEL_REASONING_MAX_CHARS)
        : env?.MODEL_REASONING_MAX_CHARS
      const raw = Number(configured)
      if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
      // Execution turns should act before they spend an entire response
      // re-deriving plans or layout arithmetic. The tool loop can recover this
      // bounded abort with a direct-action prompt; ordinary answer turns keep
      // the larger ceiling for genuinely long reasoning.
      return executionWithTools ? 20_000 : 60_000
    })()
    let lastUsage = null
    for await (const line of readModelSseLines(reader, {
      onFirstByte,
      onChunk: () => armTimer('idle', profile.timeouts.idleMs),
    })) {
        const decoded = decodeModelStreamLine(line)
        if (!decoded) continue
        if (decoded.done) {
          if (nativeStreamState) {
            for (const event of finishNativeProviderStream(nativeStreamState)) yield event
            return
          }
          // 流末尾:把累积的 tool_calls 一次性吐出
          if (toolCallAcc.size > 0) {
            const calls = [...toolCallAcc.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => v)
            yield { type: 'tool_calls', toolCalls: calls, finishReason: finishReason || 'tool_calls', usage: lastUsage }
          } else {
            // 纯文本流:把 finish_reason 交出去(见下面 finish 帧的注释)
            yield { type: 'finish', finishReason: finishReason || 'stop', usage: lastUsage }
          }
          return
        }
        const chunk = decoded.data
        const responseError = extractModelResponseError(chunk)
        if (responseError) throw responseError
        if (nativeStreamState) {
          const nativeEvents = consumeNativeProviderStreamPayload(chunk, nativeStreamState)
          for (const event of nativeEvents) {
            if (event.type === 'reasoning' && event.delta) {
              reasoningChars += event.delta.length
              if (reasoningCharLimit > 0 && reasoningChars > reasoningCharLimit) {
                const error = new Error(`模型思考超过 ${Math.round(reasoningCharLimit / 1000)}k 字仍未给出正文，已中止以避免继续消耗资源。`)
                error.code = 'REASONING_RUNAWAY'
                try { await reader.cancel(error) } catch { /* best effort */ }
                controller.abort(error)
                throw error
              }
            }
            yield event
          }
          if (nativeStreamState.finished) return
          continue
        }

        // 所有 OpenAI-compatible 变体统一归一化。除了标准 choices，还覆盖
        // Ollama NDJSON、Responses API、LM Studio/llama.cpp 裸 message/token。
        const frame = normalizeCompatibleModelStreamPayload(chunk, compatibleStreamState)
        const chunkUsage = extractUsage(chunk)
        if (chunkUsage) {
          lastUsage = chunkUsage
          yield { type: 'usage', usage: chunkUsage }
        }
        if (frame.finishReason) finishReason = frame.finishReason
        if (frame.reasoning) {
          reasoningChars += frame.reasoning.length
          if (reasoningCharLimit > 0 && reasoningChars > reasoningCharLimit) {
            const error = new Error(
              `模型思考超过 ${Math.round(reasoningCharLimit / 1000)}k 字仍未给出正文，已中止以避免继续消耗资源。`
              + '通常是信息不足导致模型反复兜圈子（例如工具持续失败）。'
              + '可以换一个非推理模型，或把任务拆小后重试。',
            )
            error.code = 'REASONING_RUNAWAY'
            try { await reader.cancel(error) } catch { /* best effort */ }
            controller.abort(error)
            throw error
          }
          yield { type: 'reasoning', delta: frame.reasoning }
        }
        if (frame.text) yield { type: 'text', delta: frame.text }
        for (const delta of frame.toolCallDeltas) {
          const idx = delta.index ?? 0
          const existing = toolCallAcc.get(idx) || { id: '', name: '', arguments: '' }
          if (delta.id) existing.id = delta.id
          if (delta.name) existing.name = delta.name
          if (delta.argumentsMode === 'replace') existing.arguments = delta.arguments
          else if (delta.arguments) existing.arguments += delta.arguments
          if (!existing.id && existing.name) existing.id = `call-${idx}-${existing.name}`
          toolCallAcc.set(idx, existing)
          if (!readyToolCallIndexes.has(idx) && existing.name && existing.arguments.trim()) {
            try {
              JSON.parse(existing.arguments)
              readyToolCallIndexes.add(idx)
              yield { type: 'tool_call_ready', toolCall: { ...existing }, index: idx }
            } catch {
              // 参数仍是分片，继续累积。
            }
          }
        }
        if (frame.terminal) break
    }
    if (nativeStreamState) {
      for (const event of finishNativeProviderStream(nativeStreamState)) yield event
      return
    }
    // 兜底:某些后端不发 [DONE]
    if (toolCallAcc.size > 0) {
      const calls = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v)
      yield { type: 'tool_calls', toolCalls: calls, finishReason: finishReason || 'tool_calls', usage: lastUsage }
      return
    }
    // ★ 纯文本流也要把 finish_reason 交出去。
    //
    // 原来 finishReason 只挂在 tool_calls 帧上 —— 一个**被 token 上限截断**的
    // 文本流(finish_reason: 'length')和一个正常说完的流在前端完全无法区分。
    // 推理模型尤其致命:思考就能吃掉几万 token,正文一个字都没生成就到顶了,
    // 前端只看到「流正常结束但没有正文」,于是打出「模型未返回详细文字总结」。
    // 真相是「输出预算被思考吃光了」,和「模型不想说」完全是两回事。
    yield { type: 'finish', finishReason: finishReason || 'stop', usage: lastUsage }
  } catch (error) {
    if (error?.name === 'AbortError' && !externalSignal?.aborted) {
      // ★ 不再伪装成 status 504 —— 见 modelTimeoutError 的注释。
      // 504 会被 isProviderFailoverError 判定为可转移(静默切云端 + 扣钱),
      // 也会被 modelRetry 判定为可重试(对着单槽推理服务器再打 3 次)。
      const phase = timedOutPhase || 'request'
      const hint = phase === 'first_token'
        ? `模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回第一个字。本地模型首次加载权重较慢，可尝试调大超时或先用 ollama run 预热模型。`
        : `模型输出中断超过 ${Math.round(timeoutMs / 1000)} 秒，判定为连接已失效。`
      const timeoutError = modelTimeoutError(hint, { phase, timeoutMs })
      timeoutError.cause = error
      throw timeoutError
    }
    throw error
  } finally {
    clearTimer()
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
    const testMode = req.url?.startsWith('/api/model/test')
    const requestUserId = authenticateRequest(req)
    if (testMode && !requestUserId) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' })
      return
    }
    if (testMode) {
      const maxRequests = Math.max(1, Math.min(60, Number(process.env.MODEL_TEST_RATE_MAX) || 10))
      const rate = checkRateLimit({
        key: `model_test:${requestUserId}`,
        windowMs: 60 * 1000,
        maxRequests,
      })
      res.setHeader('X-RateLimit-Limit', String(maxRequests))
      res.setHeader('X-RateLimit-Remaining', String(rate.remaining))
      if (!rate.allowed) {
        sendJson(res, 429, { ok: false, error: 'Too many model test requests' })
        return
      }
    }
    const body = await readJson(req)
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

    const useStream = body.stream === true
    let messages = testMode
      ? [{ role: 'user', content: 'Reply with only: pong' }]
      : body.messages
    let autoMemorySourceMessages = []

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
    const requestConfig = resolveModelConfigForModel({ modelName: selectedModel, env: runtimeEnv })
    const requestProfile = profileForConfig(requestConfig, runtimeEnv)
    if (!testMode && hasVisionContent(messages) && !requestProfile.supportsVision) {
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
          logWarn('vision.assist', assistErr, { userId: userIdForAssist, modelName: selectedModel })
          const fallback = replaceUnsupportedVisionContent({ messages, modelName: selectedModel })
          messages = fallback.messages
          res.setHeader('X-Vision-Fallback-Count', String(fallback.replacementCount))
          res.setHeader('X-Vision-Fallback-Reason', 'assist_failed')
        }
      } else {
        const fallback = replaceUnsupportedVisionContent({ messages, modelName: selectedModel })
        messages = fallback.messages
        res.setHeader('X-Vision-Fallback-Count', String(fallback.replacementCount))
        res.setHeader('X-Vision-Fallback-Reason', 'assist_unavailable')
      }
    }
    let token = ''
    let injectedMemoryIds = []
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
      getPublicAccount({ token })
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
      autoMemorySourceMessages = Array.isArray(messages)
        ? messages.map((message) => ({ ...message }))
        : []
    }

    // FreshCompact 风格：identity / ishiki / skills / sessions 分块编译为独立 system message。
    if (session?.user_id) {
      const compiledSystemMessages = []
      const safety = buildSafetyBlock()
      compiledSystemMessages.push({ role: 'system', content: safety.text })
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

    }

    const requiresVision = hasVisionContent(messages)
    const resolvedCandidates = resolveModelFailoverConfigs({ modelName: selectedModel, env: runtimeEnv })
    const requestCandidates = resolvedCandidates.filter((candidate) =>
      !requiresVision || profileForConfig(candidate, runtimeEnv).supportsVision
    )
    if (!requestCandidates.length) requestCandidates.push(requestConfig)

    // ★ 收尾调用需要独立、更大的输出预算。
    //
    // 默认情况下 max_tokens 已经不限制了(见 parseMaxTokens),这段只在
    // 用户**显式配了**一个上限时起作用 —— 那种情况下收尾仍可能被
    // 推理模型的「思考」吃光额度,所以给它临时抬高。
    // (背景:实测有一次思考 93778 字,而当时 MODEL_MAX_TOKENS=4096。)
    const boost = Number(body.maxTokensBoost)
    if (Number.isFinite(boost) && boost > 0) {
      for (const candidate of requestCandidates) {
        const current = Number(candidate.maxTokens) || 0
        // 已经是「不限制」(0)就别退化成一个有限值
        if (current > 0) {
          candidate.maxTokens = Math.max(current, Math.min(Math.floor(boost), 32_000))
        }
      }
    }

    if (useStream && !testMode) {
      // SSE 流式响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // ★ nginx 之类的反代默认会缓冲上游响应,导致 SSE 攒够一块才下发 ——
        // 表现为「等很久然后一次性刷出一大段」。这个头告诉 nginx 别缓冲。
        'X-Accel-Buffering': 'no',
      })
      // ★ 立刻把响应头刷出去。不刷的话 Node 会等到第一次 write 才发,
      // 而首 token 可能要几十秒才来 —— 中间任何一层(反代 / 浏览器 / 公司网关)
      // 看到一个几十秒没有任何字节的连接,都可能直接掐掉。
      if (typeof res.flushHeaders === 'function') res.flushHeaders()

      // 客户端真正断开时取消上游推理，避免本地模型继续占用 GPU。
      const sseAbort = new AbortController()
      let clientGone = false
      const disposeDisconnectListener = bindSseClientDisconnect(req, res, () => {
        clientGone = true
        sseAbort.abort()
      })

      const safeWrite = (payload) => {
        if (clientGone || res.writableEnded || res.destroyed) return false
        return res.write(payload)
      }

      // ★ 心跳:每 15 秒发一个 SSE 注释帧。
      //
      // 注释帧(以 ':' 开头)按 SSE 规范会被客户端静默忽略,不会污染数据流,
      // 但它是**真实字节**,足以让所有中间层认为连接是活的。
      // 本地模型加载权重时可能几十秒没有任何输出,没有心跳的话这段静默期
      // 就是「连接看起来死了」—— nginx 默认 60s 就断。
      const heartbeat = setInterval(() => {
        safeWrite(': keepalive\n\n')
      }, 15_000)
      // Node 的 timer 会拖住事件循环;心跳不该阻止进程退出
      if (typeof heartbeat.unref === 'function') heartbeat.unref()

      // ★ 先告诉前端「已连上,正在等模型」。
      // 本地模型冷启动要几十秒才有第一个字,没有这一帧的话用户面对的是
      // 完全空白的界面,只会以为卡死了。前端收到 phase 帧显示「模型加载中…」。
      safeWrite(`data: ${JSON.stringify({ ok: true, phase: 'connecting' })}\n\n`)

      const started = Date.now()
      let streamUsage = null
      let activeStreamModel = selectedModel
      let activeProviderResolved = false
      let assistantText = ''
      let streamHadToolCalls = false
      let streamFinishReason = null
      let firstByteAt = 0
      try {
        for await (const { event, config: activeConfig } of streamWithProviderFailover(
          requestCandidates,
          (candidate) => streamOpenAICompatible({
            config: candidate,
            messages,
            tools: body.tools,
            toolChoice: body.tool_choice,
            externalSignal: sseAbort.signal,
            env: runtimeEnv,
            onFirstByte: () => {
              if (firstByteAt) return
              firstByteAt = Date.now()
              // 首字节到了 → 通知前端结束「模型加载中」状态,
              // 顺带把首 token 延迟报上去(本地模型调优时这个数字最有用)。
              safeWrite(`data: ${JSON.stringify({
                ok: true,
                phase: 'streaming',
                firstTokenLatency: firstByteAt - started,
              })}\n\n`)
            },
          }),
          { signal: sseAbort.signal },
        )) {
          if (clientGone) break
          if (!activeProviderResolved) {
            activeStreamModel = activeConfig.modelName
            activeProviderResolved = true
          }
          if (event.type === 'text') {
            assistantText = `${assistantText}${event.delta || ''}`.slice(0, 24_000)
            safeWrite(`data: ${JSON.stringify({ ok: true, delta: event.delta, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'reasoning') {
            // 思考过程单独一种帧型,前端折叠显示,不混进正文
            safeWrite(`data: ${JSON.stringify({ ok: true, reasoning: event.delta, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'tool_calls') {
            streamHadToolCalls = true
            // 工具调用轮:usage 帧若已单独到达就不重复记,否则用终止帧带的兜底
            if (event.usage && !streamUsage) {
              streamUsage = event.usage
              recordUsage(activeStreamModel, event.usage)
            }
            safeWrite(`data: ${JSON.stringify({ ok: true, toolCalls: event.toolCalls, finishReason: event.finishReason, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'tool_call_ready') {
            safeWrite(`data: ${JSON.stringify({ ok: true, toolCallReady: event.toolCall, toolCallIndex: event.index, latency: Date.now() - started })}\n\n`)
          } else if (event.type === 'finish') {
            // 纯文本轮的终止原因。不单独下发,记下来攒到 done 帧一起给,
            // 让前端能区分「说完了」和「被 max_tokens 截断」。
            streamFinishReason = event.finishReason || null
            if (event.usage && !streamUsage) {
              streamUsage = event.usage
              recordUsage(activeStreamModel, event.usage)
            }
          } else if (event.type === 'usage') {
            // 不单独下发,攒到 done 帧一起给,避免前端多处理一种帧型
            streamUsage = event.usage
            recordUsage(activeStreamModel, event.usage)
          }
        }
        // HTTP/SSE 正常收尾不等于模型真的给了答复。部分本地 OpenAI 兼容层会
        // 很快返回 finish_reason=stop，但 content 为空；旧逻辑仍发送 done，前端
        // 就把空白消息标成「已完成」。工具调用是合法输出，纯 reasoning 不是给
        // 用户的最终答复，因此只有正文或工具调用才能算本轮成功。
        if (!clientGone && !assistantText.trim() && !streamHadToolCalls) {
          throw createEmptyModelResponseError(streamFinishReason)
        }
        if (!clientGone) {
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
          safeWrite(`data: ${JSON.stringify({
            ok: true,
            done: true,
            latency: Date.now() - started,
            injectedMemoryIds,
            usage: streamUsage,
            // ★ 'length' = 被 max_tokens 截断,不是模型说完了。
            // 前端据此给出「输出预算用尽」而不是「模型不肯说话」。
            finishReason: streamFinishReason,
          })}\n\n`)
        }
      } catch (err) {
        // AbortError 来自客户端断开,不当成错误回写
        if (!clientGone && err?.name !== 'AbortError') {
          safeWrite(`data: ${JSON.stringify({
            ok: false,
            error: formatProxyError(err),
            // 前端据此区分「我们判定超时」和「上游拒绝」,给不同的补救提示
            code: err?.code || null,
            timeoutPhase: err?.timeoutPhase || null,
            // 已经吐出来的部分不该白丢 —— 前端可以据此显示「继续生成」
            partial: assistantText ? true : false,
          })}\n\n`)
        }
      } finally {
        clearInterval(heartbeat)
        disposeDisconnectListener()
      }
      if (!res.writableEnded) res.end()
      const autoMemorySessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (!clientGone && !streamHadToolCalls && assistantText && session?.user_id && autoMemorySessionId) {
        scheduleAutoMemoryExtraction({
          userId: session.user_id,
          sessionId: autoMemorySessionId,
          agentId: injectedAgentId,
          messages: autoMemorySourceMessages,
          assistantText,
          callModel: ({ messages: memoryMessages }) => callBackgroundModel({
            messages: memoryMessages,
            userId: session.user_id,
          }),
        })
      }
      return
    }

    // 非流式响应（测试模式或前端未启用 stream）
    const started = Date.now()
    const completion = await runWithProviderFailover(requestCandidates, async (candidate) => {
      const candidateProfile = profileForConfig(candidate, runtimeEnv)
      const { url, init } = buildModelProviderRequest({
        config: candidate,
        messages,
        env: runtimeEnv,
        profile: candidateProfile,
      })
      // ★ 计时器移到 withRetry **内部**(fetchWithTimeout 里每次尝试各起一个)。
      // 原来 timer 起在外面,3 次重试共享同一个 60s 预算 —— 第 1 次尝试耗掉 55s,
      // 后两次尝试根本没机会跑完就被同一个 controller 掐了。
      const data = await withRetry(async () => {
        const response = await fetchWithTimeout(fetchWithEnvProxy, url, init, {
          timeoutMs: candidateProfile.timeouts.requestMs,
          externalSignal: null,
          phase: 'request',
        })
        const text = await response.text()
        let parsed
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
        if (!response.ok) {
          const message = parsed?.error?.message || parsed?.message || text.slice(0, 240) || response.statusText
          const error = new Error(message)
          error.status = response.status
          error.fromUpstream = true
          error.retryAfter = response.headers?.get?.('retry-after') ?? null
          throw error
        }
        return parsed
      })
      const parsed = parseModelProviderResponse(data, candidateProfile)
      const usage = parsed.usage
      recordUsage(candidate.modelName, usage)
      if (!parsed.content) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
      return { reply: parsed.content, modelName: candidate.modelName }
    })
    const reply = completion.reply
    if (!testMode && session?.user_id) {
        dispatchHooks({
          userId: session.user_id,
          event: 'stop',
          tool: 'chat',
          args: { latency: Date.now() - started, stream: false },
        }).catch((err) => {
          console.warn('[hooks] stop hook 失败 (non-stream):', err?.message || err)
        })
    }
    sendJson(res, 200, {
      ok: true,
      reply,
      latency: Date.now() - started,
      injectedMemoryIds,
      ...(testMode ? { compilerFingerprints } : {}),
    })
    const autoMemorySessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!testMode && session?.user_id && reply && autoMemorySessionId) {
      scheduleAutoMemoryExtraction({
        userId: session.user_id,
        sessionId: autoMemorySessionId,
        agentId: injectedAgentId,
        messages: autoMemorySourceMessages,
        assistantText: reply,
        callModel: ({ messages: memoryMessages }) => callBackgroundModel({
          messages: memoryMessages,
          userId: session.user_id,
        }),
      })
    }
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
