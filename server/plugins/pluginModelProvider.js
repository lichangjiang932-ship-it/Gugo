import { snapshotPluginData } from './pluginServiceData.js'

const METHODS = Object.freeze([
  'buildRequest',
  'parseResponse',
  'extractUsage',
  'createStreamState',
  'consumeStreamPayload',
  'finishStream',
])
const DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 32_768,
  maxBytes: 16 * 1024 * 1024,
})
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

function providerError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function unavailableError(record, kind, method) {
  return providerError(
    'PLUGIN_MODEL_PROVIDER_UNAVAILABLE',
    `plugin model provider is unavailable: ${record.manifest.id}/${kind}/${method}`,
  )
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

function isolatedProviderFailure(thrown, record, kind, method) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const message = boundedText(errorField(thrown, 'message')) || boundedText(primitive)
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : 'PLUGIN_MODEL_PROVIDER_EXECUTION_FAILED'
  const error = providerError(
    code,
    message || `plugin model provider callback failed: ${kind}/${method}`,
  )
  error.pluginId = record.manifest.id
  error.providerKind = kind
  error.method = method
  return error
}

function snapshotData(value, { code, label, freeze = true }) {
  return snapshotPluginData(value, { code, label, freeze, ...DATA_LIMITS })
}

function snapshotArguments(args, method) {
  return snapshotData(args, {
    code: 'PLUGIN_MODEL_PROVIDER_ARGUMENT_INVALID',
    label: `plugin model provider ${method} arguments`,
  })
}

function snapshotResult(value, method) {
  return snapshotData(value, {
    code: 'PLUGIN_MODEL_PROVIDER_RESULT_INVALID',
    label: `plugin model provider ${method} result`,
  })
}

function assertResultShape(value, method) {
  const objectResult = value && typeof value === 'object' && !Array.isArray(value)
  if ((method === 'buildRequest' || method === 'parseResponse') && !objectResult) {
    throw providerError(
      'PLUGIN_MODEL_PROVIDER_RESULT_INVALID',
      `plugin model provider ${method} result must be a plain data object`,
    )
  }
  if (method === 'extractUsage' && value != null && !objectResult) {
    throw providerError(
      'PLUGIN_MODEL_PROVIDER_RESULT_INVALID',
      'plugin model provider extractUsage result must be null or a plain data object',
    )
  }
  if ((method === 'consumeStreamPayload' || method === 'finishStream') && !Array.isArray(value)) {
    throw providerError(
      'PLUGIN_MODEL_PROVIDER_RESULT_INVALID',
      `plugin model provider ${method} result must be a plain data array`,
    )
  }
  return value
}

function snapshotStreamState(value) {
  const state = snapshotData(value, {
    code: 'PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID',
    label: 'plugin model provider stream state',
    freeze: false,
  })
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw providerError(
      'PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID',
      'plugin model provider stream state must be a plain data object',
    )
  }
  return state
}

export function snapshotRuntimeModelProvider({ record, kind, adapter, invokeSync }) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('model provider adapter must be an object')
  }
  const callbacks = new Map()
  for (const method of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(adapter, method)
    if (!descriptor) continue
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw new TypeError(`model provider adapter.${method} must be an own function property`)
    }
    callbacks.set(method, descriptor.value)
  }

  const streamStates = new WeakMap()
  const assertAvailable = (method) => {
    if (record.state !== 'active') throw unavailableError(record, kind, method)
  }
  const invoke = (method, callback, args, complete = (value) => value) => {
    assertAvailable(method)
    return invokeSync(
      record,
      'model-provider',
      (...input) => callback.apply(adapter, input),
      args,
      {
        complete,
        isolateError: (error) => isolatedProviderFailure(error, record, kind, method),
      },
    )
  }
  const wrapped = {}
  for (const [method, callback] of callbacks) {
    Object.defineProperty(wrapped, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value(...args) {
        assertAvailable(method)
        if (method === 'createStreamState') {
          const input = snapshotArguments(args, method)
          const pluginState = invoke(method, callback, input, snapshotStreamState)
          const token = Object.defineProperty({}, 'kind', {
            value: kind,
            enumerable: true,
            configurable: false,
            writable: false,
          })
          streamStates.set(token, pluginState)
          return token
        }
        if (method === 'consumeStreamPayload' || method === 'finishStream') {
          const token = method === 'consumeStreamPayload' ? args[1] : args[0]
          const pluginState = token && typeof token === 'object' ? streamStates.get(token) : null
          if (!pluginState) {
            throw providerError(
              'PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID',
              `plugin model provider ${method} received an unknown stream state`,
            )
          }
          const workingState = snapshotStreamState(pluginState)
          const input = method === 'consumeStreamPayload'
            ? [snapshotArguments([args[0]], method)[0], workingState]
            : [workingState]
          const completed = invoke(method, callback, input, (value) => ({
            result: assertResultShape(snapshotResult(value, method), method),
            nextState: snapshotStreamState(workingState),
          }))
          streamStates.set(token, completed.nextState)
          return completed.result
        }
        const input = snapshotArguments(args, method)
        return invoke(
          method,
          callback,
          input,
          (value) => assertResultShape(snapshotResult(value, method), method),
        )
      },
    })
  }
  return Object.freeze(wrapped)
}
