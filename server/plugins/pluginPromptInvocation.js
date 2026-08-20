const MAX_BLOCK_BYTES = 16 * 1024
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

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
