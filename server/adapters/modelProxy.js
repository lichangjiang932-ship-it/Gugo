import { prepareToolLoopVision } from './modelToolLoopVision.js'
import { logWarn } from '../utils/logger.js'
import { withRetry } from '../utils/modelRetry.js'
import { buildUserModelEnv } from '../services/modelProviderStore.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { fetchWithEnvProxy } from './proxyFetch.js'
import { getEffectiveModelProviderProvenance } from './nativeModelProviders.js'
import {
  parseModelProviderResponse,
  stripEmbeddedReasoning,
} from './modelProviderResponse.js'
import { createTextToolCallDeltaFilter, extractTextToolCalls } from '../utils/textToolCalls.js'
import { calculateModelCostUsd, recordUsage } from './modelUsage.js'
import {
  assertModelConfigured,
  withRedactedModelErrors,
} from './modelProxyErrors.js'
import {
  modelRequestOutcomeUnknown,
  throwIfModelRequestAbortedBeforeSend,
} from './modelRequestOutcome.js'
import {
  profileForConfig,
} from './modelEndpoint.js'
import { createModelProviderAttempt } from './modelRequestAttempt.js'
import {
  buildModelProviderRequest,
} from './modelRequestBuilder.js'
import { fetchWithTimeout } from './modelRequestTransport.js'
import { streamOpenAICompatible } from './modelProxyResponseCoordinator.js'
import {
  loadModelConfig,
  resolveModelFailoverConfigs,
} from './modelProviderConfig.js'
import { runWithProviderFailover, streamWithProviderFailover } from './modelFailover.js'
import {
  hasVisionContent,
  pickAllowedModel,
} from './modelRuntimeCatalog.js'
import { createModelProxyHttpAdapter } from './modelProxyHttp.js'

export { extractUsage, parseModelProviderResponse, parseOpenAICompatibleResponse, stripEmbeddedReasoning } from './modelProviderResponse.js'
export { getUsageStats, recordUsage, resetUsageStats } from './modelUsage.js'
export { createModelConfigMissingError, MODEL_CONFIG_MISSING_CODE, MODEL_CONFIG_MISSING_MESSAGE } from './modelProxyErrors.js'
export { formatProxyError, isContextLengthError } from './modelProxyErrors.js'
export { fetchModelOutbound, isLocalModelEndpoint, modelTimeoutError, profileForConfig } from './modelEndpoint.js'
export {
  buildModelProviderRequest,
  buildOpenAICompatibleRequest,
  normalizeOpenAICompatibleUrl,
  supportsStreamUsage,
} from './modelRequestBuilder.js'
export {
  getModelProviders,
  loadModelConfig,
  resolveModelConfigForModel,
  resolveModelFailoverConfigs,
} from './modelProviderConfig.js'
export { isProviderFailoverError, runWithProviderFailover, streamWithProviderFailover } from './modelFailover.js'
export { shouldScheduleStreamAutoMemory, streamOpenAICompatible } from './modelProxyResponseCoordinator.js'
export {
  getModelContextWindow,
  getModelStatus,
  getSystemDiagnostics,
  getToolMaxRounds,
  getVisibleModels,
  hasVisionContent,
  supportsToolsModel,
  supportsVisionModel,
} from './modelRuntimeCatalog.js'

export { getRuntimeEnv } from '../utils/runtimeEnv.js'

function createProviderAttemptTracker(candidates, onProviderAttempt) {
  if (typeof onProviderAttempt !== 'function') return null
  const providerAttempts = new Map()
  let physicalAttempt = 0
  return async ({ config, profile, requestUrl }) => {
    physicalAttempt += 1
    const providerAttempt = (providerAttempts.get(config) || 0) + 1
    providerAttempts.set(config, providerAttempt)
    const failoverIndex = Math.max(0, candidates.indexOf(config))
    const attempt = createModelProviderAttempt({
      config,
      profile,
      requestUrl,
      providerCapability: getEffectiveModelProviderProvenance(profile?.kind),
      physicalAttempt,
      providerAttempt,
      failoverIndex,
    })
    try {
      await onProviderAttempt(attempt)
    } catch (error) {
      // The host checkpoint is the write-ahead record for this network side
      // effect. If it cannot be persisted, no retry/failover may bypass it.
      try { error.unsafeToReplay = true } catch { /* immutable error */ }
      throw error
    }
  }
}

export async function callBackgroundModel({
  messages,
  modelName,
  modelProviderId = '',
  userId,
  usageOwnerId = userId,
  env = getRuntimeEnv(),
  fetchImpl = fetchWithEnvProxy,
  signal,
  modelRequestId,
  onProviderAttempt,
} = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const config = assertModelConfigured(loadModelConfig(runtimeEnv))
  const selectedModel = pickAllowedModel({
    requestedModel: modelName,
    requestedProviderId: modelProviderId,
    config,
    env: runtimeEnv,
  })
  const candidates = resolveModelFailoverConfigs({
    modelName: selectedModel,
    providerId: modelProviderId,
    env: runtimeEnv,
  })
  const trackProviderAttempt = createProviderAttemptTracker(candidates, onProviderAttempt)
  return runWithProviderFailover(candidates, async (candidate) => {
    const profile = profileForConfig(candidate, runtimeEnv)
    const providerRequest = buildModelProviderRequest({
      config: candidate,
      messages,
      stream: false,
      env: runtimeEnv,
      profile,
      modelRequestId,
    })
    const { url, init } = providerRequest
    return withRetry(() => withRedactedModelErrors(candidate, async () => {
      throwIfModelRequestAbortedBeforeSend(signal)
      await trackProviderAttempt?.({ config: candidate, profile, requestUrl: url })
      // ★ 原来这里完全没有超时 —— 一个挂死的本地端点会让 job 永远卡在
      // running,不发事件、不发通知,只能重启进程。
      let response
      let text
      let requestStarted = false
      let responseReceived = false
      try {
        ({ response, consumed: text } = await fetchWithTimeout(fetchImpl, url, init, {
          timeoutMs: profile.timeouts.backgroundMs,
          externalSignal: signal,
          phase: 'background',
          config: candidate,
          onRequestStart: () => {
            throwIfModelRequestAbortedBeforeSend(signal)
            requestStarted = true
          },
          onResponse: () => { responseReceived = true },
          consumeResponse: (received) => received.text(),
        }))
      } catch (error) {
        throw modelRequestOutcomeUnknown(error, {
          modelRequestId,
          phase: responseReceived ? 'response' : 'request',
          responseReceived,
          externalAborted: signal?.aborted === true,
          requestStarted,
        })
      }
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
        throw modelRequestOutcomeUnknown(error, {
          modelRequestId,
          phase: 'response',
          responseReceived: true,
        })
      }
      const parsed = parseModelProviderResponse(data, profile, { providerRequest })
      recordUsage(candidate.modelName, parsed.usage, { ownerId: usageOwnerId })
      if (!parsed.content) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
      return parsed.content
    }), {
      signal,
      onRetry: ({ attempt, delayMs, error }) => {
        logWarn('model.retry', error, { attempt, delayMs, model: candidate.modelName, provider: candidate.providerId })
      },
    })
  }, { signal })
}

/**
 * Bind follow-up background work to the exact Provider + model that produced
 * the parent result. The environment snapshot is intentionally kept in memory
 * only; callers must never persist or serialize it because it may contain
 * credentials.
 */
export function createBoundBackgroundModelCaller({
  callModel = callBackgroundModel,
  env,
  modelName,
  providerId,
  usageOwnerId = null,
} = {}) {
  const runtimeEnv = env && typeof env === 'object' ? { ...env } : {}
  const selectedModel = String(modelName || '').trim()
  const selectedProvider = String(providerId || '').trim()
  if (!selectedModel || !selectedProvider) {
    throw new TypeError('a resolved modelName and providerId are required')
  }
  return ({ messages, signal } = {}) => callModel({
    messages,
    signal,
    userId: null,
    usageOwnerId,
    env: runtimeEnv,
    modelName: selectedModel,
    modelProviderId: selectedProvider,
  })
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
  modelProviderId = '',
  userId,
  usageOwnerId = userId,
  env = getRuntimeEnv(),
  fetchImpl = fetchWithEnvProxy,
  signal,
  modelRequestId,
  onProviderAttempt,
} = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const config = assertModelConfigured(loadModelConfig(runtimeEnv))
  const selectedModel = pickAllowedModel({
    requestedModel: modelName,
    requestedProviderId: modelProviderId,
    config,
    env: runtimeEnv,
  })
  const candidates = resolveModelFailoverConfigs({
    modelName: selectedModel,
    providerId: modelProviderId,
    env: runtimeEnv,
  })
  const trackProviderAttempt = createProviderAttemptTracker(candidates, onProviderAttempt)
  return runWithProviderFailover(candidates, async (candidate) => {
    const profile = profileForConfig(candidate, runtimeEnv)
    const providerRequest = buildModelProviderRequest({
      config: candidate,
      messages,
      stream: false,
      tools,
      toolChoice,
      env: runtimeEnv,
      profile,
      modelRequestId,
    })
    const { url, init } = providerRequest
    return withRetry(() => withRedactedModelErrors(candidate, async () => {
      throwIfModelRequestAbortedBeforeSend(signal)
      await trackProviderAttempt?.({ config: candidate, profile, requestUrl: url })
      let response
      let text
      let requestStarted = false
      let responseReceived = false
      try {
        ({ response, consumed: text } = await fetchWithTimeout(fetchImpl, url, init, {
          timeoutMs: profile.timeouts.backgroundMs,
          externalSignal: signal,
          phase: 'background',
          config: candidate,
          onRequestStart: () => {
            throwIfModelRequestAbortedBeforeSend(signal)
            requestStarted = true
          },
          onResponse: () => { responseReceived = true },
          consumeResponse: (received) => received.text(),
        }))
      } catch (error) {
        throw modelRequestOutcomeUnknown(error, {
          modelRequestId,
          phase: responseReceived ? 'response' : 'request',
          responseReceived,
          externalAborted: signal?.aborted === true,
          requestStarted,
        })
      }
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
        throw modelRequestOutcomeUnknown(error, {
          modelRequestId,
          phase: 'response',
          responseReceived: true,
        })
      }
      const parsed = parseModelProviderResponse(data, profile, { providerRequest })
      const compatibilityCall = parsed.toolCalls?.length ? null : extractTextToolCalls(parsed.content)
      const usage = parsed.usage
      const costUsd = calculateModelCostUsd({
        providerId: candidate.providerId,
        modelName: candidate.modelName,
        endpointProfile: profile,
        usage,
        env: runtimeEnv,
      })
      recordUsage(candidate.modelName, usage, { ownerId: usageOwnerId })
      return {
        content: compatibilityCall?.detected ? compatibilityCall.content : parsed.content,
        toolCalls: compatibilityCall?.toolCalls?.length ? compatibilityCall.toolCalls : parsed.toolCalls,
        usage,
        finishReason: parsed.finishReason,
        modelName: candidate.modelName,
        providerId: candidate.providerId,
        ...(costUsd !== null ? { costUsd } : {}),
      }
    }), {
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
  modelProviderId = '',
  userId,
  usageOwnerId = userId,
  env = getRuntimeEnv(),
  fetchImpl = fetchWithEnvProxy,
  signal,
  onTextDelta,
  onReasoningDelta,
  onToolCallReady,
  onFailover,
  onRetry,
  modelRequestId,
  onProviderAttempt,
} = {}) {
  const runtimeEnv = buildUserModelEnv({ userId, env })
  const config = assertModelConfigured(loadModelConfig(runtimeEnv))
  const selectedModel = pickAllowedModel({
    requestedModel: modelName,
    requestedProviderId: modelProviderId,
    config,
    env: runtimeEnv,
  })
  const { messages: preparedMessages, candidates } = await prepareToolLoopVision({
    messages,
    candidates: resolveModelFailoverConfigs({
      modelName: selectedModel,
      providerId: modelProviderId,
      env: runtimeEnv,
    }),
    requiresVision: hasVisionContent(messages),
    supportsVision: (candidate) => profileForConfig(candidate, runtimeEnv).supportsVision,
    userId, env: runtimeEnv, fetchImpl, modelName: selectedModel,
    onAssistError: (error) => logWarn('vision.assist.tool_loop', error, { userId, modelName: selectedModel }),
  })
  let activeConfig = candidates[0] || null
  let content = ''
  let reasoningText = ''
  let reasoningChars = 0
  let toolCalls = []
  let usage = null
  let finishReason = null
  const textToolCallFilter = createTextToolCallDeltaFilter()
  const trackProviderAttempt = createProviderAttemptTracker(candidates, onProviderAttempt)

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
      modelRequestId,
      onProviderAttempt: trackProviderAttempt,
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
      reasoningText += delta
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
  const costUsd = calculateModelCostUsd({
    providerId: resolvedConfig.providerId,
    modelName: resolvedConfig.modelName,
    endpointProfile: profileForConfig(resolvedConfig, runtimeEnv),
    usage,
    env: runtimeEnv,
  })
  recordUsage(resolvedConfig.modelName, usage, { ownerId: usageOwnerId })
  return {
    content: filteredContent,
    toolCalls: filteredToolCalls,
    usage,
    finishReason,
    modelName: resolvedConfig.modelName,
    providerId: resolvedConfig.providerId,
    ...(costUsd !== null ? { costUsd } : {}),
    streamed: true,
    reasoningChars,
    // Retained chain-of-thought for the current turn. Outbound replay stays
    // gated behind MODEL_REASONING_RETENTION in the request preparation layer.
    ...(reasoningText ? { reasoning: reasoningText } : {}),
  }
}

const modelProxyHttpAdapter = createModelProxyHttpAdapter({
  createBackgroundModelCaller: createBoundBackgroundModelCaller,
})

export const handleModelProxyRequest = modelProxyHttpAdapter.handleModelProxyRequest
export const handleModelStatusRequest = modelProxyHttpAdapter.handleModelStatusRequest
export const handleSystemDiagnosticsRequest = modelProxyHttpAdapter.handleSystemDiagnosticsRequest
export const modelProxyPlugin = modelProxyHttpAdapter.modelProxyPlugin
