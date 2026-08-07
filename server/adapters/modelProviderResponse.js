import {
  isNativeProviderKind,
  parseNativeProviderResponse,
} from './nativeModelProviders.js'

export function stripEmbeddedReasoning(value) {
  const text = String(value || '')
  if (!text) return ''
  const closingTag = '</think>'
  const closeAt = text.toLowerCase().lastIndexOf(closingTag)
  if (closeAt >= 0) {
    const answer = text.slice(closeAt + closingTag.length).trimStart()
    if (answer) return answer
  }
  return text
}

export function extractModelContentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => extractModelContentText(item)).filter(Boolean).join('')
  }
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.value === 'string') return value.value
  if (typeof value.content === 'string' || Array.isArray(value.content)) {
    return extractModelContentText(value.content)
  }
  return ''
}

/**
 * Some OpenAI-compatible servers report request failures inside an HTTP 200
 * JSON/SSE payload. Surface that upstream error instead of later misreporting
 * the response as an empty successful completion.
 */
export function extractModelResponseError(data) {
  if (!data || typeof data !== 'object') return null
  const raw = data.error ?? (data.type === 'error' ? data : null)
  if (!raw) return null
  const detail = raw && typeof raw === 'object' ? raw : {}
  const message = typeof raw === 'string'
    ? raw
    : detail.message || detail.error?.message || data.message || 'Model provider returned an error.'
  const error = new Error(String(message))
  error.code = detail.code || data.code || 'MODEL_UPSTREAM_ERROR'
  error.type = detail.type || data.type || ''
  const status = Number(detail.status ?? detail.status_code ?? data.status ?? data.status_code)
  if (Number.isFinite(status) && status >= 400) error.status = status
  error.fromUpstream = true
  return error
}

/**
 * OpenAI-compatible servers agree on the request shape more often than they
 * agree on the response shape. Keep every text extraction path here so model
 * diagnostics, background jobs and chat all interpret a provider identically.
 */
export function extractModelResponseText(data) {
  const message = data?.choices?.[0]?.message
  const candidates = [
    message?.content,
    message?.text,
    data?.choices?.[0]?.text,
    data?.output_text,
    data?.output?.text,
    data?.output,
    data?.content,
    data?.response,
    data?.generated_text,
    data?.answer,
    data?.result,
    data?.raw,
  ]
  for (const candidate of candidates) {
    const text = extractModelContentText(candidate)
    if (text) return text
  }
  return ''
}

export function parseOpenAICompatibleResponse(data) {
  const responseError = extractModelResponseError(data)
  if (responseError) throw responseError
  const reply = extractModelResponseText(data)
  if (!reply) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
  return stripEmbeddedReasoning(reply)
}

export function extractUsage(data) {
  const usage = data?.usage
  if (!usage || typeof usage !== 'object') return null
  const promptTokens = Number(usage.prompt_tokens) || 0
  const cacheHitTokens = Number(
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
  ) || 0
  return {
    promptTokens,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    cacheHitTokens,
    cacheMissTokens: Number(
      usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens),
    ) || 0,
  }
}

export function parseModelProviderResponse(data, profile = {}) {
  const responseError = extractModelResponseError(data)
  if (responseError) throw responseError
  if (isNativeProviderKind(profile.kind)) {
    const parsed = parseNativeProviderResponse(data, profile.kind)
    return { ...parsed, content: stripEmbeddedReasoning(parsed?.content) }
  }
  const message = data?.choices?.[0]?.message || {}
  return {
    content: stripEmbeddedReasoning(extractModelResponseText(data)),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: extractUsage(data),
    finishReason: data?.choices?.[0]?.finish_reason || null,
  }
}
