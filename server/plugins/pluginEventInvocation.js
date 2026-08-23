import { snapshotPluginData } from './pluginServiceData.js'

const OBSERVER_EVENTS = new Set([
  'pre-step',
  'post-tool',
  'compaction',
  'turn-stopping',
])
const DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 32_768,
  maxBytes: 16 * 1024 * 1024,
})
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

function eventError(code, message, identity) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.pluginId = identity.pluginId
  error.event = identity.event
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
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_ERROR_TEXT)
    : ''
}

function isolatedEventFailure(thrown, identity, fallbackCode = 'PLUGIN_EVENT_LISTENER_FAILED') {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const message = boundedText(errorField(thrown, 'message')) || boundedText(primitive)
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : fallbackCode
  return eventError(
    code,
    message || `plugin event listener failed: ${identity.event}`,
    identity,
  )
}

function errorMetadata(error) {
  const primitive = error === null || (typeof error !== 'object' && typeof error !== 'function')
    ? String(error)
    : ''
  const statusCode = errorField(error, 'statusCode')
  return {
    name: boundedText(errorField(error, 'name')) || (error && typeof error === 'object' ? 'Error' : null),
    message: boundedText(errorField(error, 'message')) || boundedText(primitive) || null,
    code: boundedText(errorField(error, 'code')) || null,
    statusCode: typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : null,
    retryable: errorField(error, 'retryable') === true,
  }
}

function eventFailureCode(error) {
  const code = errorField(error, 'code')
  return typeof code === 'string' && ERROR_CODE_RE.test(code)
    ? code
    : 'PLUGIN_EVENT_LISTENER_FAILED'
}

function snapshotEventData(value, { code, label, freeze }) {
  return snapshotPluginData(value, {
    code,
    label,
    freeze,
    ...DATA_LIMITS,
  })
}

function hostOwnedTopLevelValue(value) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype !== Object.prototype && prototype !== null
}

function invalidRequest(event, kind) {
  const error = new TypeError(`plugin event ${event} ${kind} must be an object`)
  error.code = kind === 'request' ? 'PLUGIN_EVENT_ARGUMENT_INVALID' : 'PLUGIN_EVENT_RESULT_INVALID'
  error.retryable = false
  return error
}

function requestProjection(request, event) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw invalidRequest(event, 'request')
  }
  const projected = {}
  const hostDescriptors = new Map()
  const descriptors = Object.getOwnPropertyDescriptors(request)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key]
    if (typeof key !== 'string'
      || !Object.hasOwn(descriptor, 'value')
      || hostOwnedTopLevelValue(descriptor.value)) {
      hostDescriptors.set(key, descriptor)
      continue
    }
    Object.defineProperty(projected, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  const payload = snapshotEventData(projected, {
    code: 'PLUGIN_EVENT_ARGUMENT_INVALID',
    label: `plugin event ${event} request`,
    freeze: true,
  })
  return {
    payload,
    restore(candidate) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw invalidRequest(event, 'result')
      }
      for (const [key, descriptor] of hostDescriptors) {
        Object.defineProperty(candidate, key, descriptor)
      }
      return candidate
    },
  }
}

function requestErrorProjection(payload, event) {
  const projectedRequest = requestProjection(ownValue(payload, 'request'), event)
  const projected = {
    kind: ownValue(payload, 'kind'),
    error: errorMetadata(ownValue(payload, 'error')),
    request: projectedRequest.payload,
    attempt: ownValue(payload, 'attempt'),
  }
  return {
    payload: snapshotEventData(projected, {
      code: 'PLUGIN_EVENT_ARGUMENT_INVALID',
      label: `plugin event ${event} payload`,
      freeze: true,
    }),
    restore(candidate) {
      if (candidate?.kind === 'retry' && candidate.request !== undefined) {
        candidate.request = projectedRequest.restore(candidate.request)
      }
      return candidate
    },
  }
}

function callbackArguments(event, args) {
  let projection = null
  if (event === 'request') projection = requestProjection(args[0], event)
  if (event === 'request-error') projection = requestErrorProjection(args[0], event)
  const payload = projection?.payload ?? snapshotEventData(args[0], {
    code: 'PLUGIN_EVENT_ARGUMENT_INVALID',
    label: `plugin event ${event} payload`,
    freeze: true,
  })
  return {
    input: [
      payload,
      snapshotEventData(args[1], {
        code: 'PLUGIN_EVENT_ARGUMENT_INVALID',
        label: `plugin event ${event} context`,
        freeze: true,
      }),
    ],
    restore: projection?.restore ?? ((value) => value),
  }
}

export function createRuntimePluginEventListener({ record, event, listener, invoke, onFailure = null }) {
  const identity = Object.freeze({ pluginId: record.manifest.id, event })
  const observerOnly = OBSERVER_EVENTS.has(event)

  return async (...args) => {
    if (record.state !== 'active') return undefined
    try {
      return await invoke(record, 'event', async (...hostArgs) => {
        let input
        try {
          input = callbackArguments(event, hostArgs)
        } catch (error) {
          throw isolatedEventFailure(error, identity, 'PLUGIN_EVENT_ARGUMENT_INVALID')
        }
        try {
          const returned = await listener(...input.input)
          if (observerOnly || returned === undefined) return undefined
          const result = snapshotEventData(returned, {
            code: 'PLUGIN_EVENT_RESULT_INVALID',
            label: `plugin event ${event} result`,
            freeze: false,
          })
          return input.restore(result)
        } catch (error) {
          throw isolatedEventFailure(error, identity)
        }
      }, args)
    } catch (error) {
      try {
        onFailure?.(Object.freeze({
          pluginId: identity.pluginId,
          event: identity.event,
          code: eventFailureCode(error),
        }))
      } catch {
        // Observability must never replace the isolated plugin failure.
      }
      throw error
    }
  }
}
