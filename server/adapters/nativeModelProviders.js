import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import {
  getBoundRuntimeProvider,
  getBoundRuntimeProviderProvenance,
} from '../core/runtimeCapabilityState.js'
import { prepareOutboundMessages, retainReasoningForEnv } from './outboundMessagePipeline.js'
import { buildBuiltInNativeProviderRequest } from './nativeModelProviderRequests.js'
import {
  getModelProviderAdapter,
  hasModelProviderAdapter,
  listModelProviderAdapterKinds,
  registerModelProviderAdapter,
  unregisterModelProviderAdapter,
} from './modelProviderRegistry.js'

export const NATIVE_PROVIDER_KINDS = new Set(['anthropic', 'gemini'])
export const MODEL_PROVIDER_STOP_REASON_ERROR_CODE = 'MODEL_PROVIDER_STOP_REASON_ERROR'
const CUSTOM_STREAM_ADAPTER = Symbol('customModelProviderStreamAdapter')
const customRequestAdapters = new WeakMap()

function boundProviderSelection(kind = '') {
  const normalized = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  if (!normalized) return { bound: false, adapter: null }
  const implementation = getBoundRuntimeProvider(normalized)
  if (!implementation) return { bound: false, adapter: null }
  return {
    bound: true,
    adapter: implementation.builtin === true ? null : implementation,
  }
}

export function getEffectiveModelProviderAdapter(kind = '') {
  const selection = boundProviderSelection(kind)
  return selection.bound ? selection.adapter : getModelProviderAdapter(kind)
}

export function getEffectiveModelProviderProvenance(kind = '') {
  const selection = boundProviderSelection(kind)
  return selection.bound ? getBoundRuntimeProviderProvenance(kind) : null
}

export {
  registerModelProviderAdapter,
  unregisterModelProviderAdapter,
}

export function listNativeProviderKinds() {
  return [...new Set([...NATIVE_PROVIDER_KINDS, ...listModelProviderAdapterKinds()])]
    .filter((kind) => isNativeProviderKind(kind))
    .sort()
}

export function isNativeProviderKind(kind = '') {
  if (typeof kind !== 'string') return false
  const normalized = kind.trim().toLowerCase()
  const selection = boundProviderSelection(normalized)
  if (selection.bound) return Boolean(selection.adapter) || NATIVE_PROVIDER_KINDS.has(normalized)
  return NATIVE_PROVIDER_KINDS.has(normalized) || hasModelProviderAdapter(normalized)
}

export function getNativeProviderRequestAdapter(request) {
  return request && typeof request === 'object'
    ? customRequestAdapters.get(request) || null
    : null
}

function captureRequestAdapter(request, adapter) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('native provider buildRequest must return a request object')
  }
  customRequestAdapters.set(request, adapter)
  return request
}

export function buildNativeProviderRequest(args = {}) {
  if (Array.isArray(args.tools) && args.tools.length > 0 && args.profile?.supportsTools !== true) {
    const error = new Error('当前模型端点未启用 function calling，无法执行需要工具的任务。请启用工具调用支持或选择兼容模型。')
    error.code = 'MODEL_TOOLS_UNSUPPORTED'
    error.type = 'configuration_error'
    error.retryable = false
    throw error
  }
  const messages = prepareOutboundMessages({
    messages: args.messages,
    profile: args.profile,
    modelName: args.config?.modelName,
    providerKind: args.profile?.kind,
    providerId: args.config?.providerId,
    ephemeralContext: args.ephemeralContext,
    retainReasoning: retainReasoningForEnv(args.env, { providerKind: args.profile?.kind }),
  })
  if (messages.length === 0) throw new Error('消息不能为空。')
  const prepared = { ...args, messages }
  const adapter = getEffectiveModelProviderAdapter(args.profile?.kind)
  if (adapter) return captureRequestAdapter(adapter.buildRequest(prepared), adapter)
  return buildBuiltInNativeProviderRequest(prepared)
}

function commonUsage({ prompt, completion, total, cached } = {}, { allowPartial = false } = {}) {
  const promptTokens = normalizeOptionalUsageNumber(prompt)
  const completionTokens = normalizeOptionalUsageNumber(completion)
  const totalTokens = normalizeOptionalUsageNumber(total)
  const cacheHitTokens = normalizeOptionalUsageNumber(cached)
  if (promptTokens === null && !allowPartial) return null
  if (
    promptTokens === null
    && completionTokens === null
    && totalTokens === null
    && cacheHitTokens === null
  ) return null

  const normalized = {}
  if (promptTokens !== null) normalized.promptTokens = Math.floor(promptTokens)
  if (completionTokens !== null) normalized.completionTokens = Math.floor(completionTokens)
  else if (promptTokens !== null) normalized.completionTokens = 0
  if (totalTokens !== null) normalized.totalTokens = Math.floor(totalTokens)
  else if (promptTokens !== null) {
    normalized.totalTokens = Math.floor(promptTokens + (completionTokens ?? 0))
  }
  if (cacheHitTokens !== null) normalized.cacheHitTokens = Math.floor(cacheHitTokens)
  else if (promptTokens !== null) normalized.cacheHitTokens = 0
  if (promptTokens !== null) {
    normalized.cacheMissTokens = Math.max(0, Math.floor(promptTokens - (cacheHitTokens ?? 0)))
  }
  return normalized
}

function anthropicUsage(usage, { allowPartial = false } = {}) {
  const uncachedInputTokens = normalizeOptionalUsageNumber(usage?.input_tokens)
  const cacheHitTokens = normalizeOptionalUsageNumber(usage?.cache_read_input_tokens)
  const cacheCreationTokens = normalizeOptionalUsageNumber(usage?.cache_creation_input_tokens)
  const completionTokens = normalizeOptionalUsageNumber(usage?.output_tokens)
  const hasPromptUsage = uncachedInputTokens !== null
    || cacheHitTokens !== null
    || cacheCreationTokens !== null
  if (!hasPromptUsage && !allowPartial) return null
  if (!hasPromptUsage && completionTokens === null) return null

  const normalized = {}
  if (hasPromptUsage) {
    const uncached = Math.floor(uncachedInputTokens ?? 0)
    const cached = Math.floor(cacheHitTokens ?? 0)
    const created = Math.floor(cacheCreationTokens ?? 0)
    normalized.promptTokens = uncached + cached + created
    normalized.cacheHitTokens = cached
    normalized.cacheCreationTokens = created
    normalized.uncachedInputTokens = uncached
    normalized.cacheMissTokens = uncached + created
  }
  if (completionTokens !== null) normalized.completionTokens = Math.floor(completionTokens)
  else if (hasPromptUsage) normalized.completionTokens = 0
  if (hasPromptUsage) {
    normalized.totalTokens = normalized.promptTokens + (normalized.completionTokens ?? 0)
  }
  return normalized
}

export function extractNativeProviderUsage(data, kind = '', options = {}, adapterSnapshot = null) {
  const adapter = adapterSnapshot || getEffectiveModelProviderAdapter(kind)
  if (adapter?.extractUsage) return adapter.extractUsage(data, options)
  if (kind === 'anthropic') {
    const usage = data?.usage
    if (!usage) return null
    return anthropicUsage(usage, options)
  }
  if (kind === 'gemini') {
    const usage = data?.usageMetadata
    if (!usage) return null
    return commonUsage({
      prompt: usage.promptTokenCount,
      completion: usage.candidatesTokenCount,
      total: usage.totalTokenCount,
      cached: usage.cachedContentTokenCount,
    }, options)
  }
  return null
}

function normalizedToolCall({ id, name, args }, index = 0) {
  return {
    id: String(id || `tool-${index}-${name || 'call'}`),
    type: 'function',
    function: { name: String(name || ''), arguments: JSON.stringify(args || {}) },
  }
}

function safeStopReason(value) {
  const raw = Array.from(String(value ?? ''), (character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  }).join('').trim()
  return raw.slice(0, 120)
}

function providerStopReasonError(kind, value) {
  const providerKind = String(kind || 'unknown').trim().toLowerCase() || 'unknown'
  const stopReason = safeStopReason(value) || 'missing'
  const error = new Error(`模型提供商 ${providerKind} 返回了非成功终止原因：${stopReason}。`)
  error.code = MODEL_PROVIDER_STOP_REASON_ERROR_CODE
  error.type = 'provider_error'
  error.providerKind = providerKind
  error.stopReason = stopReason
  error.fromUpstream = true
  error.retryable = false
  error.modelRequestOutcome = 'failed'
  return error
}

export function normalizeNativeProviderFinishReason(kind, value, {
  hasToolCalls = false,
  allowMissing = false,
} = {}) {
  const providerKind = String(kind || '').trim().toLowerCase()
  const raw = safeStopReason(value)
  if (!raw) {
    if (allowMissing) return hasToolCalls ? 'tool_calls' : null
    throw providerStopReasonError(providerKind, value)
  }

  if (providerKind === 'anthropic') {
    switch (raw.toLowerCase()) {
      case 'end_turn':
      case 'stop_sequence':
        if (hasToolCalls) throw providerStopReasonError(providerKind, raw)
        return 'stop'
      case 'max_tokens':
        return 'length'
      case 'tool_use':
        if (!hasToolCalls) throw providerStopReasonError(providerKind, raw)
        return 'tool_calls'
      default:
        throw providerStopReasonError(providerKind, raw)
    }
  }

  if (providerKind === 'gemini') {
    switch (raw.toUpperCase()) {
      case 'STOP':
        return hasToolCalls ? 'tool_calls' : 'stop'
      case 'MAX_TOKENS':
        return 'length'
      default:
        throw providerStopReasonError(providerKind, raw)
    }
  }

  throw providerStopReasonError(providerKind, raw)
}

export function parseNativeProviderResponse(data, kind = '', adapterSnapshot = null) {
  const adapter = adapterSnapshot || getEffectiveModelProviderAdapter(kind)
  if (adapter) return adapter.parseResponse(data, { kind })
  if (kind === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : []
    const toolCalls = blocks.filter((part) => part?.type === 'tool_use').map((part, index) => normalizedToolCall({
      id: part.id, name: part.name, args: part.input,
    }, index))
    return {
      content: blocks.filter((part) => part?.type === 'text').map((part) => part.text || '').join(''),
      toolCalls,
      usage: extractNativeProviderUsage(data, kind),
      finishReason: normalizeNativeProviderFinishReason(kind, data?.stop_reason, {
        hasToolCalls: toolCalls.length > 0,
      }),
    }
  }
  if (kind !== 'gemini') throw new Error(`Unsupported native provider kind: ${kind || 'unknown'}`)
  const candidate = data?.candidates?.[0]
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const toolCalls = parts.filter((part) => part?.functionCall).map((part, index) => normalizedToolCall({
    id: part.functionCall.id, name: part.functionCall.name, args: part.functionCall.args,
  }, index))
  return {
    content: parts.filter((part) => typeof part?.text === 'string' && !part.thought).map((part) => part.text).join(''),
    toolCalls,
    usage: extractNativeProviderUsage(data, kind),
    finishReason: normalizeNativeProviderFinishReason(
      kind,
      data?.promptFeedback?.blockReason ?? candidate?.finishReason,
      { hasToolCalls: toolCalls.length > 0 },
    ),
  }
}

export function createNativeProviderStreamState(kind = '', adapterSnapshot = null) {
  const adapter = adapterSnapshot || getEffectiveModelProviderAdapter(kind)
  if (adapter) {
    if (typeof adapter.createStreamState !== 'function') {
      throw new Error(`Native provider does not support streaming: ${kind}`)
    }
    const state = adapter.createStreamState(kind)
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError(`Native provider stream state must be an object: ${kind}`)
    }
    if (!Object.hasOwn(state, 'kind')) state.kind = String(kind || '')
    Object.defineProperty(state, CUSTOM_STREAM_ADAPTER, { value: adapter })
    return state
  }
  const state = { kind, toolCalls: new Map(), usage: null, finishReason: null, finished: false }
  Object.defineProperty(state, CUSTOM_STREAM_ADAPTER, { value: null })
  return state
}

function mergeUsage(previous, current) {
  if (!previous) return current
  if (!current) return previous
  const promptTokens = current.promptTokens ?? previous.promptTokens
  const completionTokens = current.completionTokens ?? previous.completionTokens
  const cacheHitTokens = current.cacheHitTokens ?? previous.cacheHitTokens
  const cacheCreationTokens = current.cacheCreationTokens ?? previous.cacheCreationTokens
  const uncachedInputTokens = current.uncachedInputTokens ?? previous.uncachedInputTokens
  const cacheMissTokens = current.cacheMissTokens ?? previous.cacheMissTokens
  const merged = {}
  if (promptTokens !== undefined) merged.promptTokens = promptTokens
  if (completionTokens !== undefined) merged.completionTokens = completionTokens
  if (promptTokens !== undefined && completionTokens !== undefined) {
    merged.totalTokens = promptTokens + completionTokens
  } else if (current.totalTokens !== undefined || previous.totalTokens !== undefined) {
    merged.totalTokens = current.totalTokens ?? previous.totalTokens
  }
  if (cacheHitTokens !== undefined) merged.cacheHitTokens = cacheHitTokens
  if (cacheCreationTokens !== undefined) merged.cacheCreationTokens = cacheCreationTokens
  if (uncachedInputTokens !== undefined) merged.uncachedInputTokens = uncachedInputTokens
  if (cacheMissTokens !== undefined) merged.cacheMissTokens = cacheMissTokens
  else if (promptTokens !== undefined) merged.cacheMissTokens = Math.max(0, promptTokens - (cacheHitTokens ?? 0))
  return merged
}

function finishEvents(state, { requireFinishReason = false } = {}) {
  if (state.finished) return []
  if (requireFinishReason && !state.finishReason) {
    throw providerStopReasonError(state.kind)
  }
  state.finished = true
  const toolCalls = [...state.toolCalls.values()]
  return toolCalls.length
    ? [{
        type: 'tool_calls',
        toolCalls,
        finishReason: state.finishReason === 'length' ? 'length' : 'tool_calls',
        usage: state.usage,
      }]
    : [{ type: 'finish', finishReason: state.finishReason || 'stop', usage: state.usage }]
}

export function consumeNativeProviderStreamPayload(data, state) {
  const customAdapter = state && Object.hasOwn(state, CUSTOM_STREAM_ADAPTER)
    ? state[CUSTOM_STREAM_ADAPTER]
    : getEffectiveModelProviderAdapter(state?.kind)
  if (customAdapter) {
    if (typeof customAdapter.consumeStreamPayload !== 'function') {
      throw new Error(`Native provider does not support streaming: ${state?.kind || 'unknown'}`)
    }
    const events = customAdapter.consumeStreamPayload(data, state)
    if (!Array.isArray(events)) throw new TypeError('native provider stream adapter must return an event array')
    return events
  }
  const events = []
  if (state.kind === 'anthropic') {
    const usage = extractNativeProviderUsage(
      { usage: data?.message?.usage || data?.usage },
      'anthropic',
      { allowPartial: true },
    )
    if (usage) {
      state.usage = mergeUsage(state.usage, usage)
      events.push({ type: 'usage', usage: state.usage })
    }
    if (data?.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      state.toolCalls.set(data.index ?? state.toolCalls.size, {
        id: data.content_block.id,
        type: 'function',
        function: { name: data.content_block.name, arguments: '' },
      })
    }
    if (data?.type === 'content_block_delta') {
      if (data.delta?.type === 'text_delta') events.push({ type: 'text', delta: data.delta.text || '' })
      if (data.delta?.type === 'thinking_delta') events.push({ type: 'reasoning', delta: data.delta.thinking || '' })
      if (data.delta?.type === 'input_json_delta') {
        const call = state.toolCalls.get(data.index)
        if (call) call.function.arguments += data.delta.partial_json || ''
      }
    }
    if (data?.type === 'message_delta') {
      if (data.delta && Object.hasOwn(data.delta, 'stop_reason')) {
        state.finishReason = normalizeNativeProviderFinishReason('anthropic', data.delta.stop_reason, {
          hasToolCalls: state.toolCalls.size > 0,
        })
      }
    }
    if (data?.type === 'content_block_stop') {
      const call = state.toolCalls.get(data.index)
      if (call && call.function.arguments) events.push({ type: 'tool_call_ready', toolCall: { ...call, function: { ...call.function } }, index: data.index })
    }
    if (data?.type === 'message_stop') {
      events.push(...finishEvents(state, { requireFinishReason: true }))
    }
    return events
  }

  const streamedUsage = extractNativeProviderUsage(data, 'gemini', { allowPartial: true })
  if (streamedUsage) {
    state.usage = mergeUsage(state.usage, streamedUsage)
    events.push({ type: 'usage', usage: state.usage })
  }
  const parts = data?.candidates?.[0]?.content?.parts || []
  for (const part of parts) {
    if (part.thought && part.text) events.push({ type: 'reasoning', delta: part.text })
    else if (part.text) events.push({ type: 'text', delta: part.text })
  }
  const toolCalls = parts.filter((part) => part?.functionCall).map((part, index) => normalizedToolCall({
    id: part.functionCall.id, name: part.functionCall.name, args: part.functionCall.args,
  }, index))
  for (const call of toolCalls) {
    const index = state.toolCalls.size
    state.toolCalls.set(index, call)
    events.push({ type: 'tool_call_ready', toolCall: call, index })
  }
  const candidate = data?.candidates?.[0]
  const hasFinishReason = candidate && Object.hasOwn(candidate, 'finishReason')
  const promptBlockReason = data?.promptFeedback?.blockReason
  if (hasFinishReason || promptBlockReason) {
    state.finishReason = normalizeNativeProviderFinishReason(
      'gemini',
      promptBlockReason || candidate.finishReason,
      { hasToolCalls: state.toolCalls.size > 0 },
    )
    events.push(...finishEvents(state))
  }
  return events
}

export function finishNativeProviderStream(state, options = {}) {
  const customAdapter = state && Object.hasOwn(state, CUSTOM_STREAM_ADAPTER)
    ? state[CUSTOM_STREAM_ADAPTER]
    : getEffectiveModelProviderAdapter(state?.kind)
  if (customAdapter) {
    const events = customAdapter.finishStream(state)
    if (!Array.isArray(events)) throw new TypeError('native provider stream adapter must return an event array')
    return events
  }
  return finishEvents(state, options)
}
