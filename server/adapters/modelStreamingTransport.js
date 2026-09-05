import {
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  finishNativeProviderStream,
  getNativeProviderRequestAdapter,
  isNativeProviderKind,
} from './nativeModelProviders.js'
import {
  extractModelResponseError,
  extractUsage,
} from './modelProviderResponse.js'
import { requestNonStreamingAsEvents } from './modelNonStreaming.js'
import {
  createCompatibleModelStreamState,
  decodeModelStreamLine,
  normalizeCompatibleModelStreamPayload,
  readJsonModelResponseEvents,
  readModelSseLines,
} from './modelResponseStream.js'
import {
  fetchModelOutbound,
  modelTimeoutError,
  profileForConfig,
} from './modelEndpoint.js'
import { redactModelError } from './modelProxyErrors.js'
import {
  modelRequestOutcomeUnknown,
  throwIfModelRequestAbortedBeforeSend,
} from './modelRequestOutcome.js'
import { fetchWithEnvProxy } from './proxyFetch.js'

function reasoningLimitFor({ env, tools, toolChoice }) {
  const executionWithTools = Array.isArray(tools)
    && tools.length > 0
    && String(toolChoice || '').toLowerCase() !== 'none'
  const configured = executionWithTools
    ? (env?.MODEL_EXECUTION_REASONING_MAX_CHARS ?? env?.MODEL_REASONING_MAX_CHARS)
    : env?.MODEL_REASONING_MAX_CHARS
  const raw = Number(configured)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
}

function reasoningLimitError(limit, { native = false } = {}) {
  const suffix = native
    ? ''
    : '通常是信息不足导致模型反复兜圈子（例如工具持续失败）。可以换一个非推理模型，或把任务拆小后重试。'
  const error = new Error(
    `模型思考超过 ${Math.round(limit / 1000)}k 字仍未给出正文，已中止以避免继续消耗资源。${suffix}`,
  )
  error.code = 'REASONING_RUNAWAY'
  return error
}

async function abortRunawayReasoning({ reader, controller, limit, native }) {
  const error = reasoningLimitError(limit, { native })
  try { await reader.cancel(error) } catch { /* best effort */ }
  controller.abort(error)
  throw error
}

async function* consumeStreamingResponse({
  response,
  profile,
  providerRequest,
  providerAdapter,
  onFirstByte,
  env,
  tools,
  toolChoice,
  controller,
  armTimer,
}) {
  const jsonEvents = await readJsonModelResponseEvents(response, profile, {
    onFirstByte,
    providerRequest,
  })
  if (jsonEvents) {
    yield* jsonEvents
    return
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取流式响应')
  const toolCallAcc = new Map()
  const readyToolCallIndexes = new Set()
  const nativeStreamState = providerAdapter || isNativeProviderKind(profile.kind)
    ? createNativeProviderStreamState(profile.kind, providerAdapter)
    : null
  const compatibleStreamState = createCompatibleModelStreamState()
  const reasoningCharLimit = reasoningLimitFor({ env, tools, toolChoice })
  let finishReason = null
  let reasoningChars = 0
  let lastUsage = null
  let sawProviderEvent = false
  let sawTerminal = false
  for await (const line of readModelSseLines(reader, {
    onFirstByte,
    onChunk: () => armTimer('idle', profile.timeouts.idleMs),
  })) {
    const decoded = decodeModelStreamLine(line)
    if (!decoded) continue
    sawProviderEvent = true
    if (decoded.done) {
      if (nativeStreamState) {
        yield* finishNativeProviderStream(nativeStreamState, { requireFinishReason: true })
        return
      }
      if (toolCallAcc.size > 0) {
        const calls = [...toolCallAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, value]) => value)
        yield {
          type: 'tool_calls', toolCalls: calls,
          finishReason: finishReason || 'tool_calls', usage: lastUsage,
        }
      } else {
        yield { type: 'finish', finishReason: finishReason || 'stop', usage: lastUsage }
      }
      return
    }
    const chunk = decoded.data
    const responseError = extractModelResponseError(chunk)
    if (responseError) throw responseError
    if (nativeStreamState) {
      const nativeEvents = consumeNativeProviderStreamPayload(chunk, nativeStreamState)
      for (const event of nativeEvents) {
        if (event.type === 'reasoning' && event.delta) {
          reasoningChars += event.delta.length
          if (reasoningCharLimit > 0 && reasoningChars > reasoningCharLimit) {
            await abortRunawayReasoning({
              reader, controller, limit: reasoningCharLimit, native: true,
            })
          }
        }
        yield event
      }
      if (nativeStreamState.finished) return
      continue
    }
    const frame = normalizeCompatibleModelStreamPayload(chunk, compatibleStreamState)
    const chunkUsage = extractUsage(chunk)
    if (chunkUsage) {
      lastUsage = chunkUsage
      yield { type: 'usage', usage: chunkUsage }
    }
    if (frame.finishReason) finishReason = frame.finishReason
    if (frame.reasoning) {
      reasoningChars += frame.reasoning.length
      if (reasoningCharLimit > 0 && reasoningChars > reasoningCharLimit) {
        await abortRunawayReasoning({
          reader, controller, limit: reasoningCharLimit, native: false,
        })
      }
      yield { type: 'reasoning', delta: frame.reasoning }
    }
    if (frame.text) yield { type: 'text', delta: frame.text }
    for (const delta of frame.toolCallDeltas) {
      const index = delta.index ?? 0
      const existing = toolCallAcc.get(index) || { id: '', name: '', arguments: '' }
      if (delta.id) existing.id = delta.id
      if (delta.name) existing.name = delta.name
      if (delta.argumentsMode === 'replace') existing.arguments = delta.arguments
      else if (delta.arguments) existing.arguments += delta.arguments
      if (!existing.id && existing.name) existing.id = `call-${index}-${existing.name}`
      toolCallAcc.set(index, existing)
      if (!readyToolCallIndexes.has(index) && existing.name && existing.arguments.trim()) {
        try {
          JSON.parse(existing.arguments)
          readyToolCallIndexes.add(index)
          yield { type: 'tool_call_ready', toolCall: { ...existing }, index }
        } catch { /* arguments are still partial */ }
      }
    }
    if (frame.terminal) {
      sawTerminal = true
      break
    }
  }
  if (!sawProviderEvent) {
    const error = new Error('模型流在返回任何有效事件前已结束。')
    error.code = 'MODEL_STREAM_TRUNCATED'
    throw error
  }
  if (nativeStreamState) {
    for (const event of finishNativeProviderStream(nativeStreamState)) {
      yield sawTerminal || !['tool_calls', 'finish'].includes(event?.type)
        ? event
        : { ...event, finishReason: 'truncated' }
    }
    return
  }
  if (toolCallAcc.size > 0) {
    const calls = [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value)
    yield {
      type: 'tool_calls', toolCalls: calls,
      finishReason: sawTerminal ? finishReason || 'tool_calls' : 'truncated',
      usage: lastUsage,
    }
    return
  }
  yield {
    type: 'finish',
    finishReason: sawTerminal ? finishReason || 'stop' : 'truncated',
    usage: lastUsage,
  }
}

/**
 * Provider transport boundary for streaming model events.
 *
 * It owns outbound streaming, first-byte/idle deadlines, provider frame
 * normalization, and incremental tool-call assembly. Session, prompt, memory,
 * upstream Provider cost estimation and HTTP response concerns deliberately
 * stay outside this adapter.
 */
export async function* streamModelProviderEvents({
  config,
  messages,
  buildRequest,
  fetchImpl = fetchWithEnvProxy,
  tools,
  toolChoice,
  externalSignal,
  env = process.env,
  onFirstByte = null,
  onProviderAttempt = null,
  modelRequestId = null,
}) {
  if (typeof buildRequest !== 'function') {
    throw new TypeError('streamModelProviderEvents requires buildRequest')
  }

  const profile = profileForConfig(config, env)
  let requestStarted = false
  const guardedFetch = (url, init) => fetchModelOutbound(url, init, {
    config,
    fetchImpl,
    onRequestStart: () => {
      throwIfModelRequestAbortedBeforeSend(externalSignal)
      requestStarted = true
    },
  })
  if (!profile.supportsStreaming) {
    yield* requestNonStreamingAsEvents({
      config,
      messages,
      fetchImpl: guardedFetch,
      tools,
      toolChoice,
      externalSignal,
      env,
      profile,
      onFirstByte,
      onProviderAttempt,
      modelRequestId,
      getRequestStarted: () => requestStarted,
      buildRequest,
      createTimeoutError: modelTimeoutError,
    })
    return
  }

  const providerRequest = buildRequest({
    config,
    messages,
    stream: true,
    tools,
    toolChoice,
    profile,
    modelRequestId,
  })
  const { url, init } = providerRequest
  const providerAdapter = getNativeProviderRequestAdapter(providerRequest)
  throwIfModelRequestAbortedBeforeSend(externalSignal)
  if (typeof onProviderAttempt === 'function') {
    await onProviderAttempt({ config, profile, requestUrl: url })
  }
  const controller = new AbortController()

  let timedOutPhase = null
  let timeoutMs = 0
  let timer = null
  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }
  const armTimer = (phase, ms) => {
    clearTimer()
    timeoutMs = ms
    timer = setTimeout(() => {
      timedOutPhase = phase
      controller.abort()
    }, ms)
  }

  armTimer('first_token', profile.timeouts.firstTokenMs)

  let onExternalAbort = null
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else {
      onExternalAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  let responseReceived = false
  try {
    const response = await guardedFetch(url, { ...init, signal: controller.signal })
    responseReceived = true
    if (!response.ok) {
      const text = await response.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
      const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
      const error = new Error(message)
      error.status = response.status
      error.fromUpstream = true
      throw error
    }

    yield* consumeStreamingResponse({
      response,
      profile,
      providerRequest,
      providerAdapter,
      onFirstByte,
      env,
      tools,
      toolChoice,
      controller,
      armTimer,
    })
  } catch (error) {
    if (error?.name === 'AbortError' && !externalSignal?.aborted) {
      const phase = timedOutPhase || 'request'
      const hint = phase === 'first_token'
        ? `模型 ${Math.round(timeoutMs / 1000)} 秒内没有返回第一个字。本地模型首次加载权重较慢，可尝试调大超时或先用 ollama run 预热模型。`
        : `模型输出中断超过 ${Math.round(timeoutMs / 1000)} 秒，判定为连接已失效。`
      const timeoutError = modelTimeoutError(hint, { phase, timeoutMs })
      timeoutError.cause = error
      throw modelRequestOutcomeUnknown(timeoutError, {
        modelRequestId,
        phase,
        responseReceived,
        requestStarted,
      })
    }
    throw modelRequestOutcomeUnknown(redactModelError(error, config), {
      modelRequestId,
      phase: timedOutPhase || (responseReceived ? 'response' : 'request'),
      responseReceived,
      externalAborted: externalSignal?.aborted === true,
      requestStarted,
    })
  } finally {
    clearTimer()
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}
