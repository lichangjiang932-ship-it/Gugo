import { getOfficialModelProfile } from '../../shared/modelCapabilityCatalog.js'

/**
 * 端点能力画像 —— 「这个模型端点是什么、能干什么、该给它多少耐心」。
 *
 * ★ 背景:整个项目的超时/上下文窗口/工具下发全是按云端 API 的速度和能力写死的:
 *   - 流式 120s 整请求超时 → 本地 CPU 模型正在正常吐字也会被砍断
 *   - 上下文窗口默认 1,000,000 → 对 4k/8k 的本地模型,主动压缩永远不触发
 *   - tools 无脑下发 → 不支持 function calling 的小模型直接 400
 *   - 超时被伪装成 504 → 触发 provider failover → 本地慢一下就偷偷切到云端并扣钱
 *
 * 这些判断散落在 modelProxy / jobTools / contextCompactionRuntime 各处,
 * 每处都在用不同的方式猜。这个模块把「猜」收敛成一个纯函数,
 * 让所有调用方拿同一份画像。
 *
 * ⚠ 纯函数,无 IO,无 DB(server/utils/ 的分层红线)。真正的探测(/api/tags、
 * /api/show)在 adapters 层做,探测结果作为 overrides 传进来。
 */

/** 回环地址。保持和 modelProxy.js 原 LOCAL_HOSTS 一致,不删任何一项。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** 端点类型 → 默认端口。用于从 URL 反推 kind。 */
const KIND_BY_PORT = new Map([
  ['11434', 'ollama'],
  ['1234', 'lmstudio'],
  ['8080', 'llamacpp'],
  ['8000', 'vllm'],
])

export const ENDPOINT_KINDS = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'anthropic', 'gemini', 'openai-compatible']
const CUSTOM_ENDPOINT_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const CUSTOM_ENDPOINT_KINDS = new Set()

export function registerEndpointKind(kind) {
  const normalized = String(kind || '').trim().toLowerCase()
  if (!CUSTOM_ENDPOINT_KIND_RE.test(normalized)) {
    throw new TypeError('endpoint kind must match [a-z0-9][a-z0-9_-]{0,63}')
  }
  if (ENDPOINT_KINDS.includes(normalized)) return () => false
  if (CUSTOM_ENDPOINT_KINDS.has(normalized)) {
    throw new Error(`endpoint kind already registered: ${normalized}`)
  }
  CUSTOM_ENDPOINT_KINDS.add(normalized)
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    return CUSTOM_ENDPOINT_KINDS.delete(normalized)
  }
}

/**
 * 云端默认超时 —— 沿用改造前的既有值,不动云端行为。
 * requestMs 60s / firstTokenMs 120s 是原 modelProxy.js:1372 和 :859 的值。
 */
const CLOUD_TIMEOUTS = {
  probeMs: 8_000,
  firstTokenMs: 120_000,
  idleMs: 60_000,
  requestMs: 60_000,
  backgroundMs: 300_000,
}

/**
 * 本地默认超时 —— 慷慨得多。
 *
 * 本地推理的两种慢是完全不同的:
 *   1. 首 token 慢:模型权重要从磁盘加载进显存/内存,7B q4 在机械硬盘上要几十秒,
 *      70B 可能几分钟。这段时间一个字节都不会来,但它是健康的。→ firstTokenMs 给 10 分钟。
 *   2. 吐字慢:CPU 推理 1-3 tok/s 很正常。只要还在吐,就不该有任何上限。
 *      → 用 idleMs(两个 chunk 之间的间隔)而不是整请求超时。
 *
 * idleMs 120s 的含义是「两分钟一个 token 都没有 = 真挂了」,对 CPU 推理也足够宽。
 */
const LOCAL_TIMEOUTS = {
  probeMs: 30_000,
  firstTokenMs: 600_000,
  idleMs: 120_000,
  requestMs: 900_000,
  backgroundMs: 600_000,
}

/** 本地模型默认上下文窗口。8192 是当下本地模型最常见的实际值。 */
export const DEFAULT_LOCAL_CONTEXT_WINDOW = 8192
/** 云端默认上下文窗口。 */
export const DEFAULT_CLOUD_CONTEXT_WINDOW = 128_000
/**
 * 上下文窗口下限。原来是 4096 —— 但真有 2048/4096 窗口的小模型,
 * 被下限顶掉之后压缩阈值算出来是错的,请求必然溢出。
 */
export const MIN_CONTEXT_WINDOW = 1024

function toHostname(baseUrl) {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

/**
 * IPv4 私网段判定(RFC1918) + 链路本地 + CGNAT。
 *
 * ★ 原 isLocalModelEndpoint 只认回环,于是这些全部漏判:
 *   - 局域网另一台机器上的 Ollama(192.168.x.x)—— 家用最常见的部署
 *   - Docker 容器互访(172.17-31.x.x)
 *   - Tailscale / ZeroTier 组网(100.64.0.0/10)
 * 漏判的后果是:按云端超时砍流,并可能错误地 failover 到云端。
 */
function isPrivateIPv4(hostname) {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = nums
  if (a === 10) return true                              // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true       // 172.16.0.0/12
  if (a === 192 && b === 168) return true                // 192.168.0.0/16
  if (a === 169 && b === 254) return true                // 169.254.0.0/16 链路本地
  if (a === 100 && b >= 64 && b <= 127) return true      // 100.64.0.0/10 CGNAT / Tailscale
  return false
}

/** IPv6 唯一本地地址(fc00::/7)与链路本地(fe80::/10)。 */
function isPrivateIPv6(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare.includes(':')) return false
  return /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)
}

/**
 * 这个端点是不是「自己人」—— 本机、局域网、或私有组网。
 * 是的话:给更宽松的超时,且不允许静默 failover 到云端。
 */
export function isLocalEndpoint(baseUrl = '') {
  const url = toHostname(baseUrl)
  if (!url) return false
  const hostname = String(url.hostname || '').toLowerCase()
  if (!hostname) return false
  if (LOOPBACK_HOSTS.has(hostname)) return true
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) return true
  if (isPrivateIPv4(hostname)) return true
  if (isPrivateIPv6(hostname)) return true
  return false
}

/**
 * 从 URL 推断端点类型。端口是最可靠的信号(各家默认端口固定且互不冲突),
 * 主机名次之。推不出来就是通用 openai-compatible —— 那也完全能用,
 * 只是拿不到 kind 特有的优化(比如 Ollama 的 keep_alive)。
 */
export function inferEndpointKind(baseUrl = '') {
  const url = toHostname(baseUrl)
  if (!url) return 'openai-compatible'
  const host = String(url.hostname || '').toLowerCase()
  const path = String(url.pathname || '').toLowerCase()

  if (host.includes('ollama') || path.startsWith('/api/tags') || path.startsWith('/api/chat')) return 'ollama'
  if (host.includes('lmstudio') || host.includes('lm-studio')) return 'lmstudio'
  if (host.includes('vllm')) return 'vllm'
  if (host.includes('llamacpp') || host.includes('llama-cpp')) return 'llamacpp'
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic'
  if (host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')) return 'gemini'

  const byPort = KIND_BY_PORT.get(String(url.port || ''))
  if (byPort) return byPort

  return 'openai-compatible'
}

/**
 * 各 kind 的能力默认值。
 *
 * supportsTools 的取值是有意保守的:
 *   - ollama / lmstudio / vllm 的 OpenAI 兼容层都实现了 function calling,
 *     但**具体模型**支不支持是另一回事(qwen2.5 支持、llama2 不支持)。
 *     这里给 true,由用户在 provider 设置里按模型关掉。
 *   - llamacpp 的 server 对 tools 的支持依赖启动参数和 chat template,
 *     默认给 false 更安全 —— 发了不支持的 tools 直接 400,整轮报废。
 */
const KIND_CAPABILITIES = {
  ollama: { supportsTools: true, supportsStreaming: true, supportsVision: false, supportsPdf: false, supportsParallelTools: false },
  lmstudio: { supportsTools: true, supportsStreaming: true, supportsVision: false, supportsPdf: false, supportsParallelTools: false },
  vllm: { supportsTools: true, supportsStreaming: true, supportsVision: false, supportsPdf: false, supportsParallelTools: false },
  llamacpp: { supportsTools: false, supportsStreaming: true, supportsVision: false, supportsPdf: false, supportsParallelTools: false },
  anthropic: { supportsTools: true, supportsStreaming: true, supportsVision: true, supportsPdf: true, supportsParallelTools: true },
  gemini: { supportsTools: true, supportsStreaming: true, supportsVision: true, supportsPdf: true, supportsParallelTools: true },
  'openai-compatible': { supportsTools: true, supportsStreaming: true, supportsVision: true, supportsPdf: false, supportsParallelTools: false },
}

function isNativeOpenAIEndpoint(baseUrl = '') {
  const url = toHostname(baseUrl)
  const hostname = String(url?.hostname || '').toLowerCase()
  return hostname === 'api.openai.com'
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )
}

function positiveInt(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

/** overrides 里的三态布尔:true / false / 未设置(null)。DB 里存的是 0/1/NULL。 */
function tribool(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return null
}

/**
 * 解析上下文窗口。优先级:
 *   精确模型画像(overrides.models / modelProfiles)
 *   > MODEL_CONTEXT_WINDOWS 里按模型名配的
 *   > legacy provider contextWindow
 *   > MODEL_CONTEXT_WINDOW 全局
 *   > kind/isLocal 默认值
 *
 * ★ 不再有 1,000,000 这个默认值 —— 那是「压缩永不触发」的根源。
 */
function parseContextWindowMap(raw = '') {
  const text = String(raw || '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // 也接受 env 友好的 "model=8192,other=128000" 形式
  }
  return Object.fromEntries(
    text
      .split(',')
      .map((entry) => {
        const index = entry.lastIndexOf('=')
        if (index <= 0) return null
        return [entry.slice(0, index).trim(), entry.slice(index + 1).trim()]
      })
      .filter(Boolean)
  )
}

function modelProfileEntry(collection, modelName = '') {
  const selectedModel = String(modelName || '').trim()
  if (!selectedModel || !collection) return null
  if (Array.isArray(collection)) {
    const matched = collection.find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const name = entry.modelName ?? entry.name ?? entry.id
      return String(name || '').trim() === selectedModel
    })
    return matched && typeof matched === 'object' ? matched : null
  }
  if (typeof collection !== 'object') return null
  const matched = collection[selectedModel]
  if (matched && typeof matched === 'object' && !Array.isArray(matched)) return matched
  const contextWindow = positiveInt(matched)
  return contextWindow ? { contextWindow } : null
}

function exactModelProfile({ modelName = '', overrides = {}, modelProfiles = null } = {}) {
  for (const source of [modelProfiles, overrides?.modelProfiles, overrides?.models]) {
    const matched = modelProfileEntry(source, modelName)
    if (matched) return matched
  }
  return null
}

function resolveTimeouts({ isLocal, env, overrides }) {
  const base = isLocal ? { ...LOCAL_TIMEOUTS } : { ...CLOUD_TIMEOUTS }

  // env 级覆盖(所有端点通用)
  const envMap = {
    probeMs: env.MODEL_PROBE_TIMEOUT_MS,
    firstTokenMs: env.MODEL_FIRST_TOKEN_TIMEOUT_MS,
    idleMs: env.MODEL_IDLE_TIMEOUT_MS,
    requestMs: env.MODEL_REQUEST_TIMEOUT_MS,
    backgroundMs: env.MODEL_BACKGROUND_TIMEOUT_MS,
  }
  for (const [key, raw] of Object.entries(envMap)) {
    const value = positiveInt(raw)
    if (value) base[key] = value
  }

  // provider 级覆盖优先级最高
  const firstToken = positiveInt(overrides.firstTokenTimeoutMs)
  if (firstToken) base.firstTokenMs = firstToken
  const idle = positiveInt(overrides.idleTimeoutMs)
  if (idle) base.idleMs = idle

  return base
}

/**
 * 解析一个端点的完整画像。
 *
 * @param {object} params
 * @param {string} params.baseUrl 端点 Base URL
 * @param {string} [params.modelName] 模型名(用于按模型查上下文窗口 / 能力白名单)
 * @param {object} [params.env] 运行时环境变量
 * @param {object} [params.overrides] provider 设置里的显式配置(DB v28 字段 / 探测结果)
 * @param {object|Array} [params.modelProfiles] 按模型名精确匹配的画像映射
 * @returns {{
 *   kind: string, baseUrl: string, modelName: string, isLocal: boolean,
 *   timeouts: {probeMs:number, firstTokenMs:number, idleMs:number, requestMs:number, backgroundMs:number},
 *   contextWindow: number, contextWindowSource: string,
 *   supportsTools: boolean, supportsStreaming: boolean,
 *   supportsVision: boolean, supportsPdf: boolean, supportsParallelTools: boolean,
 *   failoverEligible: boolean, keepAlive: string|null,
 * }}
 */
export function resolveEndpointProfile({
  baseUrl = '',
  modelName = '',
  env = process.env,
  overrides = {},
  modelProfiles = null,
} = {}) {
  const safeEnv = env || {}
  const safeOverrides = overrides || {}
  const isLocal = isLocalEndpoint(baseUrl)
  const requestedKind = String(safeOverrides.kind || '').trim().toLowerCase()
  const kind = (ENDPOINT_KINDS.includes(requestedKind) || CUSTOM_ENDPOINT_KINDS.has(requestedKind))
    ? requestedKind
    : inferEndpointKind(baseUrl)
  const caps = KIND_CAPABILITIES[kind] || KIND_CAPABILITIES['openai-compatible']
  const selectedModel = String(modelName || safeEnv.MODEL_NAME || '').trim()
  const selectedModelProfile = exactModelProfile({
    modelName: selectedModel,
    overrides: safeOverrides,
    modelProfiles,
  }) || {}
  const officialModelProfile = getOfficialModelProfile(selectedModel) || {}
  const effectiveOverrides = { ...safeOverrides, ...selectedModelProfile }

  // ---- 上下文窗口 ----
  let contextWindow = positiveInt(selectedModelProfile.contextWindow)
  let contextWindowSource = contextWindow
    ? (String(selectedModelProfile.source || '').trim() || 'model_profile')
    : ''
  let contextWindowSourceUrl = contextWindow ? String(selectedModelProfile.sourceUrl || '').trim() : ''
  let contextWindowVerifiedAt = contextWindow ? String(selectedModelProfile.verifiedAt || '').trim() : ''
  if (!contextWindow) {
    const perModel = parseContextWindowMap(safeEnv.MODEL_CONTEXT_WINDOWS)[selectedModel]
    contextWindow = positiveInt(perModel)
    if (contextWindow) contextWindowSource = 'model_context_windows'
  }
  if (!contextWindow) {
    contextWindow = positiveInt(officialModelProfile.contextWindow)
    if (contextWindow) {
      contextWindowSource = 'official_catalog'
      contextWindowSourceUrl = officialModelProfile.sourceUrl
      contextWindowVerifiedAt = officialModelProfile.verifiedAt
    }
  }
  if (!contextWindow) {
    contextWindow = positiveInt(safeOverrides.contextWindow)
    if (contextWindow) contextWindowSource = 'provider_override'
  }
  if (!contextWindow) {
    contextWindow = positiveInt(safeEnv.MODEL_CONTEXT_WINDOW)
    if (contextWindow) contextWindowSource = 'global'
  }
  if (!contextWindow) {
    contextWindow = isLocal ? DEFAULT_LOCAL_CONTEXT_WINDOW : DEFAULT_CLOUD_CONTEXT_WINDOW
    contextWindowSource = isLocal ? 'local_default' : 'cloud_default'
  }
  contextWindow = Math.max(MIN_CONTEXT_WINDOW, contextWindow)
  const contextWindowEstimated = contextWindowSource === 'local_default' || contextWindowSource === 'cloud_default'
  const maxOutputTokens = positiveInt(selectedModelProfile.maxOutputTokens)
    || positiveInt(officialModelProfile.maxOutputTokens)

  // ---- 能力 ----
  // env 白名单(MODEL_NAMES_TOOLS / MODEL_NAMES_VISION)一旦设置就是精确名单:
  // 名单里的模型支持,不在名单里的不支持。没设置则回落到 kind 默认。
  const toolsWhitelist = parseCsvSet(safeEnv.MODEL_NAMES_TOOLS)
  const visionWhitelist = parseCsvSet(safeEnv.MODEL_NAMES_VISION)
  const pdfWhitelist = parseCsvSet(safeEnv.MODEL_NAMES_PDF)
  const parallelToolsWhitelist = parseCsvSet(safeEnv.MODEL_NAMES_PARALLEL_TOOLS)

  let supportsTools = tribool(effectiveOverrides.supportsTools)
  if (supportsTools === null) {
    supportsTools = toolsWhitelist.size ? toolsWhitelist.has(selectedModel) : caps.supportsTools
  }

  let supportsVision = tribool(effectiveOverrides.supportsVision)
  if (supportsVision === null) {
    supportsVision = visionWhitelist.size ? visionWhitelist.has(selectedModel) : caps.supportsVision
  }

  let supportsStreaming = tribool(effectiveOverrides.supportsStreaming)
  if (supportsStreaming === null) supportsStreaming = caps.supportsStreaming

  let supportsPdf = tribool(effectiveOverrides.supportsPdf)
  if (supportsPdf === null) {
    supportsPdf = pdfWhitelist.size
      ? pdfWhitelist.has(selectedModel)
      : (caps.supportsPdf || isNativeOpenAIEndpoint(baseUrl))
  }

  let supportsParallelTools = tribool(effectiveOverrides.supportsParallelTools)
  if (supportsParallelTools === null) {
    supportsParallelTools = parallelToolsWhitelist.size
      ? parallelToolsWhitelist.has(selectedModel)
      : (caps.supportsParallelTools || isNativeOpenAIEndpoint(baseUrl))
  }
  supportsParallelTools = supportsTools && supportsParallelTools

  // ---- failover ----
  // ★ 本地端点默认永不 failover。原来「本地慢 → 超时 → 伪装成 504 →
  // 被判定为可故障转移 → 静默切到云端 provider,改变隐私与成本边界」,
  // 用户用自己的显卡却被扣钱,而且完全不知道换了模型。
  // 想要这个行为的人可以在 provider 设置里显式打开。
  const failoverOverride = tribool(effectiveOverrides.failoverEnabled)
  const failoverEligible = failoverOverride === null ? !isLocal : failoverOverride

  // ---- Ollama keep_alive ----
  // 不设的话 Ollama 默认 5 分钟卸载模型,下一次请求又要重新加载权重 ——
  // 这是「本地模型延迟太大」最直接的一个来源。
  const keepAlive = kind === 'ollama'
    ? String(effectiveOverrides.keepAlive || safeEnv.OLLAMA_KEEP_ALIVE || '30m').trim() || '30m'
    : null

  return {
    kind,
    baseUrl: String(baseUrl || '').trim(),
    modelName: selectedModel,
    isLocal,
    timeouts: resolveTimeouts({ isLocal, env: safeEnv, overrides: effectiveOverrides }),
    contextWindow,
    contextWindowSource,
    contextWindowEstimated,
    contextWindowSourceUrl: contextWindowSourceUrl || null,
    contextWindowVerifiedAt: contextWindowVerifiedAt || null,
    maxOutputTokens,
    supportsTools,
    supportsStreaming,
    supportsVision,
    supportsPdf,
    supportsParallelTools,
    failoverEligible,
    keepAlive,
  }
}
