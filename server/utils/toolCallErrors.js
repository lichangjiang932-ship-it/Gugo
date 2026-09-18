import { isPlainObject, toolError } from './toolCallPrimitives.js'
import { redactSensitiveText } from '../../shared/sensitiveText.js'
export { redactSensitiveText } from '../../shared/sensitiveText.js'

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_ERROR_TEXT_CHARS = 2_000

function safeErrorText(value, fallback = '') {
  const text = String(value ?? fallback)
  // Tool/provider errors can contain request headers or URLs. Preserve the
  // actionable message while ensuring credentials never enter checkpoints,
  // turn events, model context, or the browser state.
  // Redact before truncating: a token crossing the display boundary must not
  // survive as a prefix too short for the credential detector to recognize.
  return redactSensitiveText(text).slice(0, MAX_ERROR_TEXT_CHARS)
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
  const rawMessage = typeof source.message === 'string' && source.message.trim() ? source.message
    : typeof error === 'string' && error.trim() ? error : fallbackMessage
  const message = safeErrorText(rawMessage, fallbackMessage)
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
function cleanFailureFields(value, ancestors = new Set(), depth = 0) {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'object') return undefined
  if (ancestors.has(value)) return '[Circular]'
  if (depth > 32) return '[Depth limit]'
  const next = new Set(ancestors).add(value)
  const cleaned = Array.isArray(value) ? [] : {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue
    if (/^(?:stack|stacktrace|diagnostic|__proto__|constructor|prototype)$/iu.test(key)) continue
    const credential = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|set[-_]?cookie)$/iu.test(key)
    const entry = credential ? '[REDACTED]' : cleanFailureFields(descriptor.value, next, depth + 1)
    if (entry !== undefined) Object.defineProperty(cleaned, key, { value: entry, enumerable: true, writable: true, configurable: true })
  }
  return cleaned
}

export function normalizeToolResult(result) {
  if (isPlainObject(result)) {
    const ok = Object.getOwnPropertyDescriptor(result, 'ok')?.value
    const verification = Object.getOwnPropertyDescriptor(result, 'requiresUserVerification')
    if (ok !== true || (verification && verification.value !== false)) result = cleanFailureFields(result)
    if (result.requiresUserVerification === true) {
      result = { ...result, ok: false, retryable: false,
        code: result.code || 'tool_execution_outcome_unknown',
        error: result.error || 'The tool outcome requires independent verification before continuing.' }
    }
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

export async function mapWithConcurrency(items, mapper, { concurrency = 4 } = {}) {
  const input = Array.isArray(items) ? items : []
  if (input.length === 0) return []
  const width = Math.max(1, Math.min(input.length, Math.floor(Number(concurrency) || 1)))
  const output = new Array(input.length)
  let cursor = 0
  let failed = false
  let failure

  const workers = Array.from({ length: width }, async () => {
    while (!failed) {
      const index = cursor
      cursor += 1
      if (index >= input.length) return
      try {
        output[index] = await mapper(input[index], index)
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
  return output
}
