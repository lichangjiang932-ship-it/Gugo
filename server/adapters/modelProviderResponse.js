import {
  isNativeProviderKind,
  parseNativeProviderResponse,
} from './nativeModelProviders.js'

export function parseOpenAICompatibleResponse(data) {
  const reply = data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.text
    || data?.output?.text
    || data?.result
  if (!reply) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
  return reply
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
  if (isNativeProviderKind(profile.kind)) return parseNativeProviderResponse(data, profile.kind)
  const message = data?.choices?.[0]?.message || {}
  return {
    content: message.content || data?.choices?.[0]?.text || data?.output?.text || data?.result || '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: extractUsage(data),
    finishReason: data?.choices?.[0]?.finish_reason || null,
  }
}
