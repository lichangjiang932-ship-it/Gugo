export const MODEL_REQUEST_OUTCOME_UNKNOWN_CODE = 'MODEL_REQUEST_OUTCOME_UNKNOWN'

const OUTCOME_UNKNOWN_MESSAGE = '模型请求可能已被上游接受，但没有取得可验证的最终结果。为避免再次请求并产生额外的上游模型供应商费用，系统已停止自动重试；请核对上游请求记录后再恢复。'

// These failures happen before an HTTP request can reach the configured
// endpoint. Everything else at the fetch boundary is treated conservatively:
// a reset or timeout may have happened after the request body was accepted.
const DEFINITELY_NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
])

function transportCode(error) {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase()
}

function markModelRequestNotSent(error) {
  try { error.modelRequestOutcome = 'not_sent' } catch { /* immutable error */ }
  return error
}

/**
 * Stop before the physical fetch boundary while preserving the caller's
 * cancellation error. The marker lets the durable loop distinguish a safe
 * pre-send cancellation from an ambiguous interruption after dispatch.
 */
export function throwIfModelRequestAbortedBeforeSend(signal) {
  if (!signal?.aborted) return
  const reason = signal.reason
  const error = reason && (typeof reason === 'object' || typeof reason === 'function')
    ? reason
    : Object.assign(new Error('Model request cancelled before send.'), {
        name: 'AbortError',
        ...(reason === undefined ? {} : { cause: reason }),
      })
  throw markModelRequestNotSent(error)
}

export function isDefinitelyNotSentModelRequestError(error) {
  if (error?.modelRequestOutcome === 'not_sent') return true
  if (error?.fromUpstream === true || Number.isFinite(Number(error?.status))) return false
  return DEFINITELY_NOT_SENT_CODES.has(transportCode(error))
}

export function modelRequestOutcomeUnknown(error, {
  modelRequestId = null,
  phase = 'request',
  responseReceived = false,
  externalAborted = false,
  requestStarted = false,
} = {}) {
  // Untracked probes and compatibility routes have no durable invocation to
  // reconcile. Preserve their legacy error contract rather than advertising a
  // recovery target that does not exist.
  const requestId = String(modelRequestId || '').trim()
  if (!requestId) return error
  if (error?.code === MODEL_REQUEST_OUTCOME_UNKNOWN_CODE || error?.unsafeToReplay === true) return error

  const physicalRequestStarted = requestStarted === true || responseReceived === true
  const cancellationObserved = externalAborted === true || error?.name === 'AbortError'
  if (cancellationObserved) {
    if (!physicalRequestStarted) return markModelRequestNotSent(error)
  } else if (!responseReceived && isDefinitelyNotSentModelRequestError(error)) {
    // Connection/DNS failures remain authoritative pre-send outcomes even
    // though the fetch implementation was entered. No HTTP request reached
    // the Provider, so existing retry/failover behavior stays safe.
    return markModelRequestNotSent(error)
  }

  const status = Number(error?.status ?? error?.statusCode)
  if (Number.isFinite(status)
    && status >= 400
    && status < 500
    && ![408, 409, 425, 429].includes(status)) {
    // Authentication, validation and missing-model responses are explicit
    // terminal rejections rather than ambiguous transport outcomes.
    return error
  }
  if (error?.code === 'REASONING_RUNAWAY') return error

  const unknown = new Error(OUTCOME_UNKNOWN_MESSAGE, { cause: error })
  unknown.code = MODEL_REQUEST_OUTCOME_UNKNOWN_CODE
  unknown.statusCode = 409
  unknown.retryable = false
  unknown.unsafeToReplay = true
  unknown.requiresUserVerification = true
  unknown.recoveryKind = 'model_request_outcome_unknown'
  unknown.action = 'verify_model_request'
  unknown.modelRequestId = requestId
  unknown.transportPhase = String(phase || 'request')
  if (Number.isFinite(status) && status > 0) unknown.upstreamStatus = status
  if (error?.timeoutPhase) unknown.timeoutPhase = String(error.timeoutPhase)
  if (Number.isFinite(Number(error?.timeoutMs))) unknown.timeoutMs = Number(error.timeoutMs)
  if (error?.partialModelResult) unknown.partialModelResult = error.partialModelResult
  return unknown
}
