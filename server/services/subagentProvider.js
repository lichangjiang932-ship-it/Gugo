import { invokePluginService } from '../plugins/pluginRegistry.js'

export const SUBAGENT_PROVIDER_SERVICE = 'subagent-provider'
export const SUBAGENT_PROVIDER_TIMEOUT_MS = 2 * 60 * 60 * 1_000
export const SUBAGENT_PROVIDER_TRACE_EVENT = 'subagent_provider'

const PROVIDER_STATUSES = new Set(['completed', 'paused', 'interrupted', 'failed'])
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const MAX_PROMPT_CHARS = 20_000
const MAX_RESULT_TEXT_CHARS = 64_000
const MAX_REASON_CHARS = 2_000

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return undefined
  }
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function boundedString(value, maxChars, { trim = false } = {}) {
  if (typeof value !== 'string') return ''
  const normalized = trim ? value.trim() : value
  return normalized.slice(0, maxChars)
}

function boundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

function snapshotTeam(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.freeze({
    id: boundedString(ownDataValue(value, 'id'), 200, { trim: true }) || null,
    name: boundedString(ownDataValue(value, 'name'), 120, { trim: true }) || null,
    mode: boundedString(ownDataValue(value, 'mode'), 40, { trim: true }) || null,
    role: boundedString(ownDataValue(value, 'role'), 120, { trim: true }) || null,
    size: boundedInteger(ownDataValue(value, 'size'), { min: 1, max: 1_000 }),
    memberIndex: boundedInteger(ownDataValue(value, 'memberIndex'), { min: 0, max: 999 }),
  })
}

function providerScope(input) {
  const model = ownDataValue(input, 'model')
  return Object.freeze({
    runId: boundedString(ownDataValue(input, 'runId'), 500, { trim: true }),
    resume: ownDataValue(input, 'resume') === true,
    type: boundedString(ownDataValue(input, 'type'), 40, { trim: true }),
    prompt: boundedString(ownDataValue(input, 'prompt'), MAX_PROMPT_CHARS),
    description: boundedString(ownDataValue(input, 'description'), 120, { trim: true }),
    depth: boundedInteger(ownDataValue(input, 'depth'), { min: 0, max: 1_000 }) ?? 0,
    model: Object.freeze({
      name: boundedString(ownDataValue(model, 'name'), 200, { trim: true }) || null,
      providerId: boundedString(ownDataValue(model, 'providerId'), 200, { trim: true }) || null,
      configRevision: boundedInteger(ownDataValue(model, 'configRevision'), { min: 1 }),
    }),
    team: snapshotTeam(ownDataValue(input, 'team')),
  })
}

function pluginId(value) {
  return boundedString(value, 80, { trim: true }) || null
}

export function projectSubagentProviderProvenance(value) {
  const decision = boundedString(ownDataValue(value, 'decision'), 40, { trim: true }) || 'error'
  const error = boundedString(ownDataValue(value, 'error'), 128, { trim: true })
  return Object.freeze({
    pluginId: pluginId(ownDataValue(value, 'pluginId')),
    service: SUBAGENT_PROVIDER_SERVICE,
    decision,
    ...(error ? { error } : {}),
  })
}

function provenance({ providerPluginId = null, decision, error = null }) {
  return projectSubagentProviderProvenance({
    pluginId: providerPluginId,
    decision,
    ...(error ? { error } : {}),
  })
}

function providerError(code, message, providerProvenance) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.providerProvenance = providerProvenance
  return error
}

function stableErrorCode(error, fallback) {
  const code = ownDataValue(error, 'code')
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : fallback
}

function hasOnlyOwnKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key))
  } catch {
    return false
  }
}

function normalizeProviderResult(value) {
  const decision = ownDataValue(value, 'decision')
  if (decision === 'decline') {
    if (!hasOnlyOwnKeys(value, new Set(['decision']))) return null
    return Object.freeze({ decision })
  }
  if (decision !== 'handled'
    || !hasOnlyOwnKeys(value, new Set(['decision', 'status', 'text', 'reason']))) return null

  const status = ownDataValue(value, 'status')
  const text = ownDataValue(value, 'text')
  const reason = ownDataValue(value, 'reason')
  if (!PROVIDER_STATUSES.has(status)
    || (text !== undefined && typeof text !== 'string')
    || (reason !== undefined && typeof reason !== 'string')
    || (typeof text === 'string' && text.length > MAX_RESULT_TEXT_CHARS)
    || (typeof reason === 'string' && reason.length > MAX_REASON_CHARS)) return null

  return Object.freeze({
    decision,
    status,
    text: text || '',
    reason: reason || '',
  })
}

function cancellationError(reason) {
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const message = reason instanceof Error && reason.message
    ? reason.message
    : 'runtime subagent provider invocation aborted'
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'SUBAGENT_PROVIDER_ABORTED'
  error.retryable = false
  return error
}

function providerTimeoutMs(value) {
  const configured = Number(value)
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : SUBAGENT_PROVIDER_TIMEOUT_MS
}

async function invokeWithCancellation(callback, { timeoutMs, signal }) {
  if (signal?.aborted) throw cancellationError(signal.reason)
  const controller = new AbortController()
  let timer = null
  let removeHostAbort = null
  const cancelled = new Promise((_, reject) => {
    const abort = (error) => {
      if (!controller.signal.aborted) controller.abort(error)
      reject(error)
    }
    const onHostAbort = () => abort(cancellationError(signal?.reason))
    if (signal?.aborted) onHostAbort()
    else if (signal?.addEventListener) {
      signal.addEventListener('abort', onHostAbort, { once: true })
      removeHostAbort = () => signal.removeEventListener('abort', onHostAbort)
    }
    timer = setTimeout(() => {
      abort(providerError(
        'SUBAGENT_PROVIDER_TIMEOUT',
        'runtime subagent provider timed out',
        provenance({ decision: 'error', error: 'SUBAGENT_PROVIDER_TIMEOUT' }),
      ))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(controller.signal)),
      cancelled,
    ])
  } finally {
    if (timer) clearTimeout(timer)
    removeHostAbort?.()
  }
}

/**
 * Invoke the optional process-local subagent provider with a bounded plain-data
 * task envelope. A separate callback-scoped cancellation context carries only
 * an isolated AbortSignal; no identity, approval, tool schema, persistence
 * handle, environment, or skill body crosses this boundary.
 */
export async function invokeRuntimeSubagentProvider(input = {}, dependencies = {}) {
  const scope = providerScope(input)
  const invokeService = dependencies.invokePluginService || invokePluginService
  const signal = dependencies.signal
  const timeoutMs = providerTimeoutMs(dependencies.timeoutMs)

  let invoked
  try {
    invoked = await invokeWithCancellation(
      (providerSignal) => invokeService(
        SUBAGENT_PROVIDER_SERVICE,
        'run',
        [scope],
        Object.freeze({ signal: providerSignal }),
      ),
      { timeoutMs, signal },
    )
  } catch (error) {
    if (error?.code === 'SUBAGENT_PROVIDER_TIMEOUT') throw error
    if (error?.name === 'AbortError') throw error
    const code = 'SUBAGENT_PROVIDER_INVOCATION_FAILED'
    throw providerError(
      code,
      'runtime subagent provider invocation failed',
      provenance({
        providerPluginId: ownDataValue(error, 'pluginId'),
        decision: 'error',
        error: stableErrorCode(error, code),
      }),
    )
  }

  if (!invoked?.found) {
    return Object.freeze({
      kind: 'builtin',
      provenance: provenance({ decision: 'absent' }),
    })
  }

  const providerPluginId = pluginId(invoked.pluginId)
  const result = normalizeProviderResult(invoked.value)
  if (!result) {
    const code = 'SUBAGENT_PROVIDER_RESULT_INVALID'
    throw providerError(
      code,
      'runtime subagent provider returned an invalid result',
      provenance({ providerPluginId, decision: 'error', error: code }),
    )
  }
  if (result.decision === 'decline') {
    return Object.freeze({
      kind: 'builtin',
      provenance: provenance({ providerPluginId, decision: 'decline' }),
    })
  }
  return Object.freeze({
    kind: 'handled',
    terminal: Object.freeze({
      status: result.status,
      text: result.text,
      reason: result.reason,
    }),
    provenance: provenance({ providerPluginId, decision: 'handled' }),
  })
}

export const _testing = Object.freeze({
  providerScope,
  providerTimeoutMs,
  normalizeProviderResult,
})
