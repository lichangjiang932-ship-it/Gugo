import { createHash } from 'node:crypto'

export const PROVIDER_REPLAY_LIMITS = Object.freeze({ parts: 128, bytes: 512 * 1024, signatureChars: 128 * 1024, streamUpdates: 4096 })
const requestContexts = new WeakMap()

function invalid(reason) {
  throw Object.assign(new Error(`Provider-native replay state is invalid: ${reason}`), {
    code: 'MODEL_PROVIDER_REPLAY_INVALID', type: 'provider_error', retryable: false, fromUpstream: true,
  })
}

export function providerReplayContext({ config = {}, profile = {} } = {}) {
  if (profile.kind !== 'gemini' || typeof config.modelName !== 'string' || !config.modelName) return null
  let endpoint
  try {
    const url = new URL(config.baseUrl)
    endpoint = url.origin + url.pathname.replace(/\/+$/u, '')
  } catch { return null }
  const modelName = config.modelName
  const binding = createHash('sha256').update(JSON.stringify({
    kind: profile.kind, providerId: String(config.providerId || ''), endpoint, modelName,
  })).digest('hex')
  return Object.freeze({ kind: 'gemini', modelName, binding })
}

export function bindProviderReplayContext(request, args) {
  const context = providerReplayContext(args)
  if (context && request && typeof request === 'object') requestContexts.set(request, context)
  return request
}

export function getProviderReplayContext(request) {
  return request && typeof request === 'object' ? requestContexts.get(request) || null : null
}

function boundedJson(value) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { invalid('non-JSON or recursive metadata') }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > PROVIDER_REPLAY_LIMITS.bytes) invalid('metadata byte limit exceeded')
  return JSON.parse(encoded)
}

function copyPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) invalid('part must be an object')
  let result
  if (part.functionCall) {
    const call = part.functionCall
    if (typeof call.name !== 'string' || !call.name || call.name.length > 256) invalid('invalid function name')
    const args = boundedJson(call.args ?? {})
    if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('function arguments must be an object')
    const id = call.id
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 512)) invalid('invalid native call id')
    result = { functionCall: { ...(id !== undefined ? { id } : {}), name: call.name, args } }
  } else if (typeof part.text === 'string' && part.text.length <= PROVIDER_REPLAY_LIMITS.bytes) {
    result = { text: part.text }
  } else invalid('unsupported signed part')
  if (part.thought === true) result.thought = true
  if (Object.hasOwn(part, 'thoughtSignature')) {
    const signature = part.thoughtSignature
    if (typeof signature !== 'string' || !signature || signature.length > PROVIDER_REPLAY_LIMITS.signatureChars) invalid('invalid thought signature')
    result.thoughtSignature = signature
  }
  return result
}

export function cloneProviderReplay(value) {
  if (value == null) return null
  if (value.version !== 1 || value.kind !== 'gemini'
    || typeof value.modelName !== 'string' || !value.modelName || value.modelName.length > 512
    || !/^[a-f0-9]{64}$/u.test(value.binding || '')
    || !Array.isArray(value.parts) || value.parts.length > PROVIDER_REPLAY_LIMITS.parts) invalid('invalid envelope')
  return boundedJson({ version: 1, kind: 'gemini', modelName: value.modelName, binding: value.binding, parts: value.parts.map(copyPart) })
}

function requiresReplay(part) {
  return Boolean(part && (Object.hasOwn(part, 'thoughtSignature') || part.functionCall?.id !== undefined))
}

export function captureGeminiReplay(parts, context) {
  if (!Array.isArray(parts) || !parts.some(requiresReplay)) return null
  if (!context) {
    if (parts.some((part) => part && Object.hasOwn(part, 'thoughtSignature'))) invalid('signed response requires its request context')
    return null // Legacy standalone parsers can still read an id without claiming reusable native state.
  }
  return cloneProviderReplay({ version: 1, ...context, parts })
}

export function createGeminiReplayCollector(context) {
  return { context, parts: [], updates: 0, bytes: 0, required: false, overflow: false }
}

export function appendGeminiReplayParts(collector, parts) {
  if (!collector || !Array.isArray(parts)) return
  for (const part of parts) {
    collector.required ||= requiresReplay(part)
    collector.updates += 1
    let encoded
    try { encoded = JSON.stringify(part) } catch { invalid('non-JSON stream part') }
    collector.bytes += typeof encoded === 'string' ? Buffer.byteLength(encoded, 'utf8') : 0
    collector.overflow ||= collector.updates > PROVIDER_REPLAY_LIMITS.streamUpdates || collector.bytes > PROVIDER_REPLAY_LIMITS.bytes
    if (collector.overflow) {
      collector.parts = []
      if (collector.required) invalid('stream metadata limit exceeded')
      continue
    }
    const previous = collector.parts.at(-1)
    if (typeof previous?.text === 'string' && typeof part?.text === 'string'
      && Boolean(previous.thought) === Boolean(part.thought)
      && (!previous.thoughtSignature || !part.thoughtSignature || previous.thoughtSignature === part.thoughtSignature)) {
      collector.parts[collector.parts.length - 1] = { ...previous, text: previous.text + part.text,
        ...(Object.hasOwn(part, 'thoughtSignature') ? { thoughtSignature: part.thoughtSignature } : {}) }
    } else collector.parts.push(part)
    if (collector.parts.length > PROVIDER_REPLAY_LIMITS.parts) {
      collector.overflow = true
      collector.parts = []
      if (collector.required) invalid('stream part limit exceeded')
    }
  }
}

export function finishGeminiReplay(collector) {
  if (!collector?.required) return null
  if (collector.overflow) invalid('stream metadata limit exceeded')
  return captureGeminiReplay(collector.parts, collector.context)
}

export function matchingProviderReplay(value, context) {
  if (!value || !context || value.kind !== context.kind
    || value.modelName !== context.modelName || value.binding !== context.binding) return null
  return cloneProviderReplay(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]))
}

export function geminiReplayParts(message, context) {
  const replay = matchingProviderReplay(message?.providerReplay, context)
  if (!replay) return null
  const text = replay.parts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('')
  if (text !== String(message.content ?? '')) invalid('canonical assistant text changed')
  const sourceCalls = replay.parts.filter((part) => part.functionCall).map((part, index) => ({
    id: part.functionCall.id || `tool-${index}-${part.functionCall.name || 'call'}`,
    name: part.functionCall.name, args: part.functionCall.args,
  }))
  const calls = (message.tool_calls || []).map((call) => {
    let args
    try { args = JSON.parse(call.function?.arguments || '{}') } catch { invalid('canonical function arguments changed') }
    return { id: call.id, name: call.function?.name, args }
  })
  if (JSON.stringify(stableJson(sourceCalls)) !== JSON.stringify(stableJson(calls))) invalid('canonical function calls changed')
  return replay.parts
}

/** Explain host-normalized/approved arguments without altering signed history. */
export function withProviderExecutionArguments(messages, call, result) {
  const message = (Array.isArray(messages) ? messages : []).findLast((entry) => (
    entry?.role === 'assistant' && entry.providerReplay
    && entry.tool_calls?.some((candidate) => candidate.id === call?.id)
  ))
  if (!message) return result
  const original = message.tool_calls.find((candidate) => candidate.id === call.id)
  let args
  try { args = JSON.parse(original.function.arguments) } catch { invalid('canonical function arguments changed') }
  if (original.function.name === call.name
    && JSON.stringify(stableJson(args)) === JSON.stringify(stableJson(call.args))) return result
  return {
    ...result,
    runtimeArguments: {
      note: 'The signed model call is preserved unchanged. This tool result uses the following host-normalized or approved arguments.',
      name: call.name,
      arguments: call.args,
    },
  }
}
