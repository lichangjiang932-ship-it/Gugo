import { normalizeModelUsage, normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'

export const MODEL_CONTEXT_LENGTH_EXCEEDED = 'MODEL_CONTEXT_LENGTH_EXCEEDED'
const evidence = new WeakMap()
const EXPLICIT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'context_length_error', 'prompt_too_long', 'input_too_long'])
const EXACT_MESSAGE = /^(?:the )?context (?:size|window|length) (?:has been |is )?exceeded[.!]?$/iu
const CHANNEL_ERROR = /^(?:Error:\s*)?Channel Error$/iu
const ENGINE_WRAPPER = /^(?:Error:\s*)?Engine protocol predict stream returned an error:\s*(\{[\s\S]*\})\.?$/u
const CHANNEL_WRAPPER = /^(?:Error:\s*)?Channel Error\r?\n-\s*Caused By:\s*(?:Error:\s*)?/u

function explicitContextFailure(value, depth = 0) {
  if (depth > 4 || value == null) return false
  if (typeof value === 'string') {
    if (value.length > 8192) return false
    const message = value.trim()
    if (EXACT_MESSAGE.test(message)) return true
    const wrapped = message.replace(CHANNEL_WRAPPER, '')
    const encoded = wrapped.match(ENGINE_WRAPPER)?.[1]
    if (!encoded) return false
    try { return explicitContextFailure(JSON.parse(encoded), depth + 1) } catch { return false }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false
  if (EXPLICIT_CODES.has(String(value.code || '').toLowerCase())) return true
  if (explicitContextFailure(value.message, depth + 1)) return true
  // Follow only a protocol error wrapper, never arbitrary nested model data.
  if (CHANNEL_ERROR.test(String(value.message || '').trim())) {
    return explicitContextFailure(value.cause ?? value.error, depth + 1)
  }
  return !value.message && Object.hasOwn(value, 'error') && explicitContextFailure(value.error, depth + 1)
}

function nonempty(value) {
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value) ? value.length > 0 : false
}

function carriesGeneration(data, usage) {
  const choices = Array.isArray(data.choices) ? data.choices : []
  const messages = [data.delta, typeof data.message === 'object' ? data.message : null,
    ...choices.flatMap((choice) => [choice?.delta, choice?.message])]
  if (messages.some((message) => typeof message === 'string' ? nonempty(message) : message && (
    ['content', 'text', 'reasoning', 'reasoning_content', 'tool_calls'].some((key) => nonempty(message[key]))
      || Boolean(message.function_call)))) return true
  const rawUsage = data.usage ?? data.response?.usage
  const reportedOutput = normalizeOptionalUsageNumber(rawUsage?.completion_tokens ?? rawUsage?.output_tokens ?? rawUsage?.completionTokens)
  const reportedReasoning = normalizeOptionalUsageNumber(rawUsage?.completion_tokens_details?.reasoning_tokens ?? rawUsage?.output_tokens_details?.reasoning_tokens)
  return ['content', 'output', 'output_text', 'candidates'].some((key) => nonempty(data[key]))
    || Number(usage?.completionTokens) > 0 || reportedOutput > 0 || reportedReasoning > 0
}

/** Failed responses do not prove that missing completion/cache counts are zero. */
export function providerFailureUsage(data) {
  const usage = data?.usage ?? data?.response?.usage
  return normalizeModelUsage({
    promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? data?.prompt_eval_count,
    completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? data?.eval_count,
    totalTokens: usage?.total_tokens,
    cacheHitTokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens,
    cacheMissTokens: usage?.prompt_cache_miss_tokens,
  })
}

/** Only the actual parsed provider error envelope can create this evidence. */
export function contextOverflowFromProviderPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const detail = Object.hasOwn(data, 'error') ? data.error
    : Object.hasOwn(data, 'type') && data.type === 'error' ? data : null
  if (!explicitContextFailure(detail)) return null
  const usage = providerFailureUsage(data)
  const error = Object.assign(new Error('The model provider reported that its context window was exceeded.'), {
    code: MODEL_CONTEXT_LENGTH_EXCEEDED, type: 'context_length_error', fromUpstream: true, retryable: false,
    ...(usage ? { usage } : {}),
  })
  evidence.set(error, { generationObserved: carriesGeneration(data, usage) })
  return error
}

export function isParsedContextOverflow(error) { return evidence.has(error) }

export function markContextOverflowGeneration(error) {
  const value = evidence.get(error)
  if (value) value.generationObserved = true
}

export function contextOverflowHasGeneration(error) {
  return evidence.get(error)?.generationObserved === true
}

export function isContextOverflowWithoutGeneration(error) {
  return evidence.get(error)?.generationObserved === false
}
