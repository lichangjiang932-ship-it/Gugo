import { parseModelProviderResponse } from './modelProviderResponse.js'
import {
  modelRequestOutcomeUnknown,
  throwIfModelRequestAbortedBeforeSend,
} from './modelRequestOutcome.js'

export function* modelProviderResponseEvents(data, profile, options = {}) {
  const parsed = parseModelProviderResponse(data, profile, options)
  if (parsed.usage) yield { type: 'usage', usage: parsed.usage }
  if (parsed.content) yield { type: 'text', delta: parsed.content }
  if (parsed.toolCalls.length) {
    for (const [index, toolCall] of parsed.toolCalls.entries()) {
      yield { type: 'tool_call_ready', toolCall, index }
    }
    yield {
      type: 'tool_calls',
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason || 'tool_calls',
      usage: parsed.usage,
    }
    return
  }
  yield { type: 'finish', finishReason: parsed.finishReason || 'stop', usage: parsed.usage }
}

async function fetchTextWithTimeout(fetchImpl, url, init, {
  timeoutMs,
  externalSignal,
  phase = 'request',
  onResponse,
  createTimeoutError,
}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let onExternalAbort = null
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else {
      onExternalAbort = () => controller.abort()
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    if (typeof onResponse === 'function') onResponse()
    const text = await response.text()
    return { response, text }
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      const timeoutError = createTimeoutError(
        `Model did not finish responding within ${Math.round(timeoutMs / 1000)} seconds.`,
        { phase, timeoutMs },
      )
      timeoutError.cause = error
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

/** Adapt a non-streaming upstream response to the stable stream event contract. */
export async function* requestNonStreamingAsEvents({
  config,
  messages,
  fetchImpl,
  tools,
  toolChoice,
  externalSignal,
  env,
  profile,
  onFirstByte,
  onProviderAttempt = null,
  getRequestStarted = null,
  buildRequest,
  createTimeoutError,
  modelRequestId = null,
}) {
  const providerRequest = buildRequest({
    config,
    messages,
    stream: false,
    tools,
    toolChoice,
    env,
    profile,
    modelRequestId,
  })
  const { url, init } = providerRequest
  throwIfModelRequestAbortedBeforeSend(externalSignal)
  if (typeof onProviderAttempt === 'function') {
    await onProviderAttempt({ config, profile, requestUrl: url })
  }
  let responseReceived = false
  let response
  let text
  try {
    ({ response, text } = await fetchTextWithTimeout(fetchImpl, url, init, {
      timeoutMs: profile.timeouts.requestMs,
      externalSignal,
      phase: 'request',
      createTimeoutError,
      onResponse: () => {
        responseReceived = true
        if (typeof onFirstByte !== 'function') return
        try { onFirstByte() } catch { /* observability must not fail the request */ }
      },
    }))
  } catch (error) {
    throw modelRequestOutcomeUnknown(error, {
      modelRequestId,
      phase: responseReceived ? 'response' : 'request',
      responseReceived,
      externalAborted: externalSignal?.aborted === true,
      requestStarted: getRequestStarted?.() === true,
    })
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text.slice(0, 240) || response.statusText
    const error = new Error(message)
    error.status = response.status
    error.fromUpstream = true
    error.retryAfter = response.headers?.get?.('retry-after') ?? null
    throw modelRequestOutcomeUnknown(error, {
      modelRequestId,
      phase: 'response',
      responseReceived: true,
    })
  }

  try {
    yield* modelProviderResponseEvents(data, profile, { providerRequest })
  } catch (error) {
    throw modelRequestOutcomeUnknown(error, {
      modelRequestId,
      phase: 'response',
      responseReceived: true,
    })
  }
}
