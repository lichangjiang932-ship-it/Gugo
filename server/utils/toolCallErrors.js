import { isPlainObject, toolError } from './toolCallPrimitives.js'

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_ERROR_TEXT_CHARS = 2_000

export function redactSensitiveText(value) {
  return String(value ?? '').replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+/giu, '$1[REDACTED]')
}

function safeErrorText(value, fallback = '') {
  const text = String(value ?? fallback).slice(0, MAX_ERROR_TEXT_CHARS)
  // Tool/provider errors can contain request headers or URLs. Preserve the
  // actionable message while ensuring credentials never enter checkpoints,
  // turn events, model context, or the browser state.
  return redactSensitiveText(text)
}

function normalizedStatus(value) {
  const status = Number(value)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
}

/** Convert a thrown provider/adapter error into the public tool-result shape. */
export function normalizeToolError(error, {
  fallbackCode = 'tool_execution_failed',
  fallbackMessage = 'Tool execution failed.',
} = {}) {
  const source = error && typeof error === 'object' ? error : {}
  const status = normalizedStatus(source.status ?? source.statusCode)
  const retryable = typeof source.retryable === 'boolean'
    ? source.retryable
    : RETRYABLE_HTTP_STATUSES.has(status)
  const code = safeErrorText(source.code || fallbackCode, fallbackCode).slice(0, 160)
  const message = safeErrorText(source.message || error || fallbackMessage, fallbackMessage)
  const hint = source.hint == null ? '' : safeErrorText(source.hint)
  const errorPath = source.path == null ? '' : safeErrorText(source.path)
  const suggestGrantPath = source.suggestGrantPath == null
    ? ''
    : safeErrorText(source.suggestGrantPath)
  const requiredAccessMode = ['read_only', 'read_write'].includes(source.requiredAccessMode)
    ? source.requiredAccessMode
    : ''
  const causeCode = source.cause && typeof source.cause === 'object'
    ? safeErrorText(source.cause.code || '').slice(0, 160)
    : ''
  return {
    ok: false,
    code,
    error: message,
    retryable,
    ...(status ? { status } : {}),
    ...(hint ? { hint } : {}),
    ...(errorPath ? { path: errorPath } : {}),
    ...(suggestGrantPath ? { suggestGrantPath } : {}),
    ...(requiredAccessMode ? { requiredAccessMode } : {}),
    // A cause code is useful for routing, but nested messages/stacks are not
    // exposed because they frequently contain response bodies or credentials.
    ...(causeCode ? { cause: { code: causeCode } } : {}),
  }
}

/**
 * Tool executors share one explicit result contract. Legacy `{ error }`
 * objects remain failures, while empty or ambiguous values must never be
 * mistaken for successful execution.
 */
export function normalizeToolResult(result) {
  if (isPlainObject(result)) {
    if (result.ok === true) return result
    if (result.ok === false || result.error) {
      const normalized = normalizeToolError({
        code: result.code,
        message: result.error,
        status: result.status ?? result.statusCode,
        retryable: result.retryable,
        hint: result.hint,
        cause: result.cause,
      })
      return {
        ...result,
        ...normalized,
        ...(result.statusCode != null && normalized.status == null ? { statusCode: result.statusCode } : {}),
      }
    }
  }

  return toolError(
    'tool_result_invalid',
    'Tool executor returned an invalid result. Expected an object with ok: true or ok: false.',
    { retryable: false },
  )
}

export function isSafeToolRetry(metadata) {
  if (!metadata || typeof metadata !== 'object') return false
  if (metadata.isReadOnly === true) return true
  // External writes are never replayed automatically, even when their API
  // accepts an idempotency key. Their outcome can be visible to other people.
  return metadata.isIdempotent === true
    && metadata.riskClass !== 'external'
    && metadata.isDestructive !== true
}

function abortError(signal) {
  const error = new Error('Tool execution cancelled')
  error.name = 'AbortError'
  if (signal?.reason !== undefined) error.cause = signal.reason
  return error
}

async function abortableDelay(ms, signal) {
  if (signal?.aborted) throw abortError(signal)
  if (!(ms > 0)) return
  await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const onAbort = () => {
      finish(reject, abortError(signal))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Execute one already-approved tool with conservative transient retries.
 * Validation, approval, hooks, and audit remain outside this function and are
 * therefore not repeated. Only read-only or explicitly idempotent local tools
 * qualify; external writes and destructive tools always receive one attempt.
 */
export async function executeToolWithRetry({
  execute,
  metadata,
  signal,
  maxAttempts = 3,
  baseDelayMs = 120,
  delay = abortableDelay,
  rethrowErrors = false,
} = {}) {
  const attemptsLimit = isSafeToolRetry(metadata)
    ? Math.max(1, Math.min(3, Math.floor(Number(maxAttempts) || 1)))
    : 1
  let result = null
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    if (signal?.aborted) throw abortError(signal)
    try {
      result = normalizeToolResult(await execute({ attempt }))
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
      if (rethrowErrors) throw error
      result = normalizeToolError(error)
    }
    if (result.ok === true) return attempt > 1 ? { ...result, attempts: attempt } : result
    if (result.retryable !== true || attempt >= attemptsLimit) {
      return attempt > 1 ? { ...result, attempts: attempt } : result
    }
    const waitMs = Math.max(0, Number(baseDelayMs) || 0) * (2 ** (attempt - 1))
    await delay(waitMs, signal)
  }
  return result
}

/**
 * 有界并发映射，输出顺序始终与输入一致。
 * mapper 抛错时保持 Promise.all 语义向上抛，由调用方决定如何降级。
 */
export async function mapWithConcurrency(items, mapper, { concurrency = 4 } = {}) {
  const input = Array.isArray(items) ? items : []
  if (input.length === 0) return []
  const width = Math.max(1, Math.min(input.length, Math.floor(Number(concurrency) || 1)))
  const output = new Array(input.length)
  let cursor = 0

  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= input.length) return
      output[index] = await mapper(input[index], index)
    }
  })
  await Promise.all(workers)
  return output
}
