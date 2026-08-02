/**
 * Ollama 原生 API 适配。
 *
 * ★ 为什么需要它:项目原本只走 OpenAI 兼容层(`/v1/chat/completions`),
 * 那条路聊天是能用的,但有两件事兼容层给不了:
 *
 *   1. **上下文窗口**。兼容层的 `/v1/models` 只回模型名,不回 context_length。
 *      于是用户必须自己猜「我这个模型窗口多大」并手填 —— 猜错了(或者干脆不填,
 *      用了 1,000,000 的默认值)压缩就永远不触发,每个长对话必然撞 400。
 *      Ollama 原生的 `/api/show` 直接给出真实的 context_length。
 *
 *   2. **keep_alive**。Ollama 默认 5 分钟就把模型从显存里卸载,下一次请求
 *      要重新加载几个 G 的权重 —— 这正是「本地模型延迟太大」最常见的来源。
 *      聊天请求带上 keep_alive 就能让它常驻。
 *
 * 聊天本身仍然走 OpenAI 兼容层(已经跑通、且和其它 provider 同一条代码路径),
 * 这里只补发现和探测。
 */

import { isLocalEndpoint } from '../utils/endpointProfile.js'

/**
 * 把任意形态的 Ollama Base URL 归一成 origin。
 *
 * 用户可能填 `http://localhost:11434`、`.../v1`、`.../v1/`、
 * 甚至 `.../v1/chat/completions` —— 原生 API 挂在 origin 下的 `/api/*`,
 * 所以统一剥掉路径。
 */
export function ollamaOrigin(baseUrl = '') {
  const trimmed = String(baseUrl || '').trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed).origin
  } catch {
    return ''
  }
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 30_000, method = 'GET', body = null } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const init = { method, signal: controller.signal }
    if (body) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await fetchImpl(url, init)
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!response.ok) {
      const error = new Error(data?.error || response.statusText || `HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 列出 Ollama 本地已拉取的模型(`GET /api/tags`)。
 *
 * ★ 原来的模型发现硬编码 OpenAI 的 `data[].id` 形状,Ollama 兼容层虽然
 * 也实现了 `/v1/models`,但拿不到大小/量化/家族这些对选型有用的信息。
 *
 * @returns {Promise<Array<{name:string, size:number|null, family:string|null, parameterSize:string|null, quantization:string|null}>>}
 */
export async function listOllamaModels({ baseUrl, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const origin = ollamaOrigin(baseUrl)
  if (!origin) return []
  const data = await fetchJson(`${origin}/api/tags`, { fetchImpl, timeoutMs })
  const models = Array.isArray(data?.models) ? data.models : []
  return models.map((model) => ({
    name: model?.name || model?.model || '',
    size: Number.isFinite(Number(model?.size)) ? Number(model.size) : null,
    family: model?.details?.family || null,
    parameterSize: model?.details?.parameter_size || null,
    quantization: model?.details?.quantization_level || null,
  })).filter((model) => model.name)
}

/**
 * 从 `model_info` 里找出上下文长度。
 *
 * Ollama 的键名带家族前缀,如 `llama.context_length`、`qwen2.context_length`、
 * `gemma2.context_length` —— 不能写死,只能按后缀匹配。
 */
export function extractContextLength(showResponse) {
  const info = showResponse?.model_info
  if (!info || typeof info !== 'object') return null
  for (const [key, value] of Object.entries(info)) {
    if (!/\.context_length$/.test(key)) continue
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return Math.floor(num)
  }
  return null
}

/** 这个模型支不支持 function calling —— Ollama 的 template 里会引用 .Tools。 */
export function extractSupportsTools(showResponse) {
  const capabilities = showResponse?.capabilities
  if (Array.isArray(capabilities)) {
    if (capabilities.includes('tools')) return true
    if (capabilities.length) return false
  }
  const template = String(showResponse?.template || '')
  if (template) return /\.Tools\b/.test(template)
  return null
}

/** 这个模型支不支持图片输入。 */
export function extractSupportsVision(showResponse) {
  const capabilities = showResponse?.capabilities
  if (Array.isArray(capabilities) && capabilities.length) return capabilities.includes('vision')
  const families = showResponse?.details?.families
  if (Array.isArray(families)) return families.some((f) => /clip|mllama|vision/i.test(String(f)))
  return null
}

/**
 * 探测单个模型的真实能力(`POST /api/show`)。
 *
 * 返回的东西直接就是 endpointProfile 的 overrides 形状,
 * 可以原样存进 model_providers 的 v28 列。
 *
 * @returns {Promise<{contextWindow:number|null, supportsTools:boolean|null, supportsVision:boolean|null}>}
 */
export async function probeOllamaModel({ baseUrl, modelName, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const origin = ollamaOrigin(baseUrl)
  const name = String(modelName || '').trim()
  if (!origin || !name) return { contextWindow: null, supportsTools: null, supportsVision: null }
  const data = await fetchJson(`${origin}/api/show`, {
    fetchImpl,
    timeoutMs,
    method: 'POST',
    body: { model: name },
  })
  return {
    contextWindow: extractContextLength(data),
    supportsTools: extractSupportsTools(data),
    supportsVision: extractSupportsVision(data),
  }
}

/**
 * 这个 Base URL 看起来是不是 Ollama。
 * 用于「用户填了个地址,我们要不要试原生 API」这个判断 —— 只对本地端点尝试,
 * 免得把探测请求打到公网上某个无关服务。
 */
export function looksLikeOllama(baseUrl = '') {
  if (!isLocalEndpoint(baseUrl)) return false
  try {
    const url = new URL(String(baseUrl).trim())
    return url.port === '11434' || /ollama/i.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * 一次性把 Ollama 端点探明白:有哪些模型 + 目标模型的真实能力。
 * 失败不抛 —— 这是「锦上添花」的探测,拿不到就回落到推断值。
 */
export async function discoverOllamaEndpoint({ baseUrl, modelName, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const result = { ok: false, models: [], profile: null, error: null }
  try {
    result.models = await listOllamaModels({ baseUrl, fetchImpl, timeoutMs })
    result.ok = true
  } catch (error) {
    result.error = error?.message || String(error)
    return result
  }
  const target = String(modelName || '').trim() || result.models[0]?.name || ''
  if (!target) return result
  try {
    result.profile = await probeOllamaModel({ baseUrl, modelName: target, fetchImpl, timeoutMs })
  } catch {
    // /api/show 拿不到不影响模型列表本身
  }
  return result
}
