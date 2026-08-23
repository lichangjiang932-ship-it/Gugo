import {
  TURN_EVENT_PERSISTENCE_FAILURE_CODE,
  TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
} from './turnEventEmitter.js'

const PUBLIC_TURN_FAILURE = '任务执行遇到问题，尚未完成。请重试；若仍失败，请检查模型配置和工具调用支持。'
export const PUBLIC_TURN_INTERRUPTED = '模型服务暂时中断。请重试，系统会继续处理尚未完成的任务。'
export const PUBLIC_TURN_INCOMPLETE = '任务尚未完全通过验证。已成功写入的本地修改会保留，并可在文件栏中查看；待验证文件不代表验证通过。请重试以继续完成验证。'
const PUBLIC_EVENT_PERSISTENCE_FAILURE = '任务事件无法可靠保存，已停止执行且不会标记为完成。请重试；已经产生的本地修改可能仍然保留。'
const PUBLIC_REASONING_RUNAWAY = '模型推理超过安全上限，任务已停止。请重试，或换用更适合执行工具任务的模型。'

const INTERNAL_TERMINAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
]

function containsInternalTerminalFailure(value) {
  return INTERNAL_TERMINAL_FAILURE_PATTERNS.some((pattern) => pattern.test(String(value || '')))
}

function publicTurnFailureMessage(error, { code = 'TURN_FAILED', fallback = PUBLIC_TURN_FAILURE } = {}) {
  const normalizedCode = String(error?.code || code || 'TURN_FAILED').trim().toUpperCase()
  const rawMessage = String(error?.message || error?.reason || '').trim()
  const status = Number(error?.status ?? error?.statusCode)
  if ([
    TURN_EVENT_PERSISTENCE_FAILURE_CODE,
    TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
  ].includes(normalizedCode)) {
    return PUBLIC_EVENT_PERSISTENCE_FAILURE
  }
  if (normalizedCode === 'TURN_INCOMPLETE') return PUBLIC_TURN_INCOMPLETE
  if (normalizedCode === 'REASONING_RUNAWAY') return PUBLIC_REASONING_RUNAWAY
  if (normalizedCode.includes('TIMEOUT')
    || normalizedCode.includes('UNAVAILABLE')
    || normalizedCode.includes('INTERRUPT')
    || status === 408
    || status === 425
    || status === 429
    || status >= 500) {
    return PUBLIC_TURN_INTERRUPTED
  }
  if (rawMessage
    && /[\u3400-\u9fff]/u.test(rawMessage)
    && !containsInternalTerminalFailure(rawMessage)) {
    return rawMessage
  }
  return fallback
}

export function finalClarificationText(result) {
  if (result?.text) return String(result.text)
  const clarification = result?.clarification
  if (typeof clarification === 'string') return clarification
  return String(clarification?.question || clarification?.message || '需要你补充信息后才能继续。')
}

export function normalizeArtifactIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

export function sameArtifactIds(left, right) {
  const normalizedLeft = normalizeArtifactIds(left)
  const normalizedRight = normalizeArtifactIds(right)
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((id, index) => id === normalizedRight[index])
}

export function optionalDeliveryArtifactIds(value, fallback = undefined) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'deliveryArtifactIds')) {
    return normalizeArtifactIds(value.deliveryArtifactIds)
  }
  return fallback
}

export function deliveryArtifactFields(deliveryArtifactIds) {
  return Array.isArray(deliveryArtifactIds)
    ? { deliveryArtifactIds: [...deliveryArtifactIds] }
    : {}
}

export function publicIncompleteText(value, fallback = PUBLIC_TURN_INCOMPLETE) {
  const text = String(value || '').trim()
  if (!text || containsInternalTerminalFailure(text)) return fallback
  return text
}

export function normalizeTurnFailure(error, {
  code = 'TURN_FAILED',
  message = PUBLIC_TURN_FAILURE,
  retryable,
} = {}) {
  const normalizedCode = String(error?.code || code || 'TURN_FAILED').trim() || 'TURN_FAILED'
  const normalizedMessage = publicTurnFailureMessage(error, {
    code: normalizedCode,
    fallback: String(message || PUBLIC_TURN_FAILURE).trim() || PUBLIC_TURN_FAILURE,
  })
  const rawStatus = Number(error?.status ?? error?.statusCode)
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null
  const inferredRetryable = status !== null
    ? status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
    : error?.name === 'AbortError' || /(?:TIMEOUT|TEMPORAR|UNAVAILABLE|INTERRUPT)/i.test(normalizedCode)
  const failure = {
    code: normalizedCode,
    message: normalizedMessage,
    retryable: typeof error?.retryable === 'boolean'
      ? error.retryable
      : (typeof retryable === 'boolean' ? retryable : inferredRetryable),
  }
  if (status !== null) failure.status = status
  const rawHint = String(error?.hint || '').trim()
  if (rawHint && /[\u3400-\u9fff]/u.test(rawHint) && !containsInternalTerminalFailure(rawHint)) {
    failure.hint = rawHint
  } else if (failure.retryable) {
    failure.hint = '请重试本任务；系统会继续处理尚未完成的步骤。'
  }
  const attempts = Number(error?.attempts)
  if (Number.isInteger(attempts) && attempts > 0) failure.attempts = attempts
  if (normalizedCode === TURN_EVENT_PERSISTENCE_FAILURE_CODE) {
    const failedEventCount = Number(error?.failedEventCount)
    const blockedEventCount = Number(error?.blockedEventCount)
    const firstFailedSequence = Number(error?.firstFailedSequence)
    const lastFailedSequence = Number(error?.lastFailedSequence)
    const failedAt = Number(error?.failedAt)
    failure.persistence = {
      failedEventCount: Number.isInteger(failedEventCount) && failedEventCount >= 0 ? failedEventCount : 0,
      blockedEventCount: Number.isInteger(blockedEventCount) && blockedEventCount >= 0 ? blockedEventCount : 0,
      failedEventTypes: [...new Set((Array.isArray(error?.failedEventTypes) ? error.failedEventTypes : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))].slice(0, 32),
      ...(Number.isInteger(firstFailedSequence) && firstFailedSequence >= 0 ? { firstFailedSequence } : {}),
      ...(Number.isInteger(lastFailedSequence) && lastFailedSequence >= 0 ? { lastFailedSequence } : {}),
      ...(Number.isInteger(failedAt) && failedAt >= 0 ? { failedAt } : {}),
    }
  }
  return failure
}
