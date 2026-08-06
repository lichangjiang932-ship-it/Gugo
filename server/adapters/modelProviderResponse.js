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

export function parseOpenAICompatibleResponse(data) {
  const reply = data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.text
    || data?.output?.text
    || data?.result
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
  if (isNativeProviderKind(profile.kind)) {
    const parsed = parseNativeProviderResponse(data, profile.kind)
    return { ...parsed, content: stripEmbeddedReasoning(parsed?.content) }
  }
  const message = data?.choices?.[0]?.message || {}
  return {
    content: stripEmbeddedReasoning(message.content || data?.choices?.[0]?.text || data?.output?.text || data?.result || ''),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: extractUsage(data),
    finishReason: data?.choices?.[0]?.finish_reason || null,
  }
}
