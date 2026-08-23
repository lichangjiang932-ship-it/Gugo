import { fetchModelOutbound, modelTimeoutError } from './modelEndpoint.js'
import { throwIfModelRequestAbortedBeforeSend } from './modelRequestOutcome.js'

/**
 * Execute one non-streaming upstream attempt with an attempt-local timeout.
 * External cancellation remains distinguishable from a host timeout.
 */
export async function fetchWithTimeout(fetchImpl, url, init, {
  timeoutMs,
  externalSignal,
  phase = 'request',
  config = {},
  onRequestStart = null,
  onResponse = null,
  consumeResponse = null,
}) {
  throwIfModelRequestAbortedBeforeSend(externalSignal)
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
    const response = await fetchModelOutbound(
      url,
      { ...init, signal: controller.signal },
      { config, fetchImpl, onRequestStart },
    )
    if (typeof onResponse === 'function') onResponse(response)
    if (typeof consumeResponse !== 'function') return response
    return {
      response,
      consumed: await consumeResponse(response),
    }
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      const timeoutError = modelTimeoutError(
        `模型 ${Math.round(timeoutMs / 1000)} 秒内没有响应。本地模型可在 Provider 高级设置中调大后台超时，或确认服务未卡死。`,
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
