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
  if (typeof value.output_text === 'string') return value.output_text
  if (value.message && typeof value.message === 'object') return extractModelContentText(value.message)
  return ''
}

export function stringifyToolArguments(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item)
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
  } catch {
    return '{}'
  }
}

export function normalizeCompatibleToolCall(call, index = 0) {
  const fn = call?.function && typeof call.function === 'object' ? call.function : call || {}
  const name = String(fn.name || call?.name || '')
  const id = String(call?.call_id || call?.id || `call-${index}-${name || 'tool'}`)
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: stringifyToolArguments(fn.arguments ?? call?.arguments),
    },
  }
}

export function extractCompatibleToolCalls(data) {
  const calls = []
  const message = data?.choices?.[0]?.message
  const append = (items) => {
    if (!Array.isArray(items)) return
    for (const item of items) calls.push(item)
  }
  append(message?.tool_calls)
  if (message?.function_call) calls.push(message.function_call)
  append(data?.message?.tool_calls)
  if (data?.message?.function_call) calls.push(data.message.function_call)
  append(data?.tool_calls)
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'function_call') calls.push(item)
  }
  return calls.map(normalizeCompatibleToolCall)
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
    data?.message?.content,
    data?.message?.text,
    data?.output_text,
    data?.output?.text,
    data?.output,
    data?.content,
    data?.response,
    data?.generated_text,
    data?.answer,
    data?.result,
    data?.raw,
    data?.token,
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
  const usageSource = data?.usage ?? data?.response?.usage
  const usage = usageSource && typeof usageSource === 'object' ? usageSource : null
  const hasOllamaUsage = Number.isFinite(Number(data?.prompt_eval_count)) || Number.isFinite(Number(data?.eval_count))
  if (!usage && !hasOllamaUsage) return null
  const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? data?.prompt_eval_count) || 0
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? data?.eval_count) || 0
  const cacheHitTokens = Number(
    usage?.prompt_cache_hit_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? 0,
  ) || 0
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage?.total_tokens) || promptTokens + completionTokens,
    cacheHitTokens,
    cacheMissTokens: Number(
      usage?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens),
    ) || 0,
  }
}

function normalizeCompatibleFinishReason(value, hasToolCalls = false) {
  const raw = String(value || '').trim()
  const normalized = raw.toLowerCase()
  // Responses JSON uses status="incomplete" plus
  // incomplete_details.reason="max_output_tokens" instead of a Chat
  // Completions finish_reason. Treat an incomplete response without details as
  // truncated too: executing an otherwise valid-looking partial tool call is
  // less safe than asking the model to regenerate it.
  if (['length', 'max_tokens', 'max_output_tokens', 'incomplete'].includes(normalized)) return 'length'
  if (hasToolCalls || normalized === 'function_call' || normalized === 'tool_calls') return 'tool_calls'
  return raw || null
}

export function parseModelProviderResponse(data, profile = {}) {
  const responseError = extractModelResponseError(data)
  if (responseError) throw responseError
  if (isNativeProviderKind(profile.kind)) {
    const parsed = parseNativeProviderResponse(data, profile.kind)
    return { ...parsed, content: stripEmbeddedReasoning(parsed?.content) }
  }
  const toolCalls = extractCompatibleToolCalls(data)
  const responseStatus = data?.status || data?.response?.status
  const incompleteReason = data?.incomplete_details?.reason
    || data?.response?.incomplete_details?.reason
  const rawFinishReason = incompleteReason
    || data?.choices?.[0]?.finish_reason
    || data?.done_reason
    || data?.stop_reason
    || (String(responseStatus || '').toLowerCase() === 'incomplete' ? 'incomplete' : null)
    || null
  return {
    content: stripEmbeddedReasoning(extractModelResponseText(data)),
    toolCalls,
    usage: extractUsage(data),
    finishReason: normalizeCompatibleFinishReason(rawFinishReason, toolCalls.length > 0),
  }
}
