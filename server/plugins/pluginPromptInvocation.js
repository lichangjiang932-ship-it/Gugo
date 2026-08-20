const MAX_BLOCK_BYTES = 16 * 1024
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const MAX_SCOPE_SKILL_IDS = 32

function promptError(code, message, identity) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  error.pluginId = identity.pluginId
  error.promptId = identity.promptId
  return error
}

function ownValue(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function errorField(error, key) {
  try {
    return ownValue(error, key)
  } catch {
    return undefined
  }
}

function boundedText(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ERROR_TEXT) : ''
}

function isolatedPromptFailure(thrown, identity) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const message = boundedText(errorField(thrown, 'message')) || boundedText(primitive)
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : 'PLUGIN_PROMPT_RENDER_FAILED'
  return promptError(
    code,
    message || `plugin prompt render failed: ${identity.promptId}`,
    identity,
  )
}

function promptScopeError(field) {
  const error = new TypeError(`plugin prompt scope.${field} must be an own data property`)
  error.code = 'PLUGIN_PROMPT_SCOPE_INVALID'
  error.retryable = false
  return error
}

function ownScopeValue(object, field, label = field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, field)
  } catch {
    throw promptScopeError(label)
  }
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw promptScopeError(label)
  return descriptor.value
}

function scopeText(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw promptScopeError(field)
  return value.trim() || null
}

function scopeSkillIds(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw promptScopeError('skillIds')
  const length = ownScopeValue(value, 'length', 'skillIds.length')
  if (!Number.isSafeInteger(length) || length < 0) throw promptScopeError('skillIds.length')
  const normalized = []
  for (let index = 0; index < Math.min(length, MAX_SCOPE_SKILL_IDS); index += 1) {
    const item = ownScopeValue(value, String(index), `skillIds[${index}]`)
    if (typeof item !== 'string') throw promptScopeError(`skillIds[${index}]`)
    const text = item.trim()
    if (text && !normalized.includes(text)) normalized.push(text)
  }
  return Object.freeze(normalized)
}

export function snapshotRuntimePluginPromptScope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw promptScopeError('input')
  }
  return Object.freeze({
    userId: scopeText(ownScopeValue(input, 'userId'), 'userId'),
    sessionId: scopeText(ownScopeValue(input, 'sessionId'), 'sessionId'),
    agentId: scopeText(ownScopeValue(input, 'agentId'), 'agentId'),
    skillIds: scopeSkillIds(ownScopeValue(input, 'skillIds')),
  })
}

function completePromptResult(rendered, identity) {
  if (rendered == null || rendered === '') return null
  if (typeof rendered !== 'string') {
    throw promptError(
      'PLUGIN_PROMPT_RESULT_INVALID',
      'plugin prompt render must return text',
      identity,
    )
  }
  const text = rendered.trim()
  if (!text) return null
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_BLOCK_BYTES) {
    throw promptError(
      'PLUGIN_PROMPT_BLOCK_TOO_LARGE',
      'plugin prompt block exceeds 16 KiB',
      identity,
    )
  }
  return Object.freeze({ text, bytes })
}

export function createRuntimePluginPromptRenderer({ record, id, render, invokeSync }) {
  const identity = Object.freeze({ pluginId: record.manifest.id, promptId: id })
  return (scope) => invokeSync(
    record,
    'prompt',
    render,
    [scope],
    {
      complete: (value) => completePromptResult(value, identity),
      isolateError: (error) => isolatedPromptFailure(error, identity),
    },
  )
}
