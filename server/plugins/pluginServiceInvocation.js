import { types as nodeTypes } from 'node:util'

import { snapshotPluginServiceData } from './pluginServiceData.js'

const MAX_SERVICE_PROPERTIES = 256
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const addEventListener = EventTarget.prototype.addEventListener
const removeEventListener = EventTarget.prototype.removeEventListener

function serviceError(code, message, { pluginId, serviceName }) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.pluginId = pluginId
  error.serviceName = serviceName
  return error
}

function ownValue(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function isolatedServiceCancellation(executionContext, identity) {
  const controller = new AbortController()
  if (!executionContext || typeof executionContext !== 'object' || nodeTypes.isProxy(executionContext)) {
    return null
  }
  let hostSignal
  try {
    hostSignal = ownValue(executionContext, 'signal')
  } catch {
    return null
  }
  if (!hostSignal || nodeTypes.isProxy(hostSignal)) return null
  let aborted
  try {
    aborted = abortSignalAborted?.call(hostSignal)
  } catch {
    return null
  }
  let rejectCancellation
  let cancellationSettled = false
  const cancelled = new Promise((_, reject) => {
    rejectCancellation = reject
  })
  // A losing cancellation branch must never become an unhandled rejection.
  cancelled.catch(() => {})
  const abort = () => {
    if (cancellationSettled) return false
    cancellationSettled = true
    controller.abort()
    rejectCancellation(serviceError(
      'PLUGIN_SERVICE_CALL_ABORTED',
      `plugin service call aborted: ${identity.serviceName}`,
      identity,
    ))
    return true
  }
  if (aborted) abort()
  try {
    if (!aborted) addEventListener.call(hostSignal, 'abort', abort, { once: true })
  } catch {
    return null
  }
  return {
    context: Object.freeze({ signal: controller.signal }),
    revoke: abort,
    wait(value) {
      return Promise.race([Promise.resolve(value), cancelled])
    },
    dispose() {
      try {
        removeEventListener.call(hostSignal, 'abort', abort)
      } catch {
        // The isolated signal remains detached even if host cleanup rejects.
      }
    },
  }
}

function errorField(error, key) {
  try {
    return ownValue(error, key)
  } catch {
    return undefined
  }
}

function isolatedServiceFailure(thrown, identity) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const ownMessage = errorField(thrown, 'message')
  const message = typeof ownMessage === 'string' ? ownMessage : primitive
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : 'PLUGIN_SERVICE_CALL_FAILED'
  return serviceError(
    code,
    message.trim().slice(0, MAX_ERROR_TEXT) || `plugin service call failed: ${identity.serviceName}`,
    identity,
  )
}

function snapshotServiceMethods(value, identity) {
  const methods = new Map()
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return methods
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_SERVICE_PROPERTIES) {
      throw new TypeError('plugin service has too many own properties')
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function') {
        methods.set(key, descriptor.value)
      }
    }
  } catch (cause) {
    const ownMessage = errorField(cause, 'message')
    const message = typeof ownMessage === 'string'
      ? ownMessage.trim().slice(0, MAX_ERROR_TEXT)
      : ''
    throw serviceError(
      'PLUGIN_SERVICE_DEFINITION_INVALID',
      message || 'plugin service definition cannot be inspected safely',
      identity,
    )
  }
  return methods
}

export function createRuntimePluginService({ record, name, value, invoke }) {
  const identity = Object.freeze({
    pluginId: record.manifest.id,
    serviceName: name,
  })
  const directCallback = typeof value === 'function' ? value : null
  const methods = snapshotServiceMethods(value, identity)
  const activeCancellations = new Set()

  const resolveCallback = (method) => {
    const callback = method ? methods.get(method) : directCallback
    if (typeof callback === 'function') return callback
    throw serviceError(
      'PLUGIN_SERVICE_METHOD_INVALID',
      `plugin service method is not callable: ${name}/${method}`,
      identity,
    )
  }

  return Object.freeze({
    revoke() {
      for (const cancellation of [...activeCancellations]) cancellation.revoke()
      return true
    },
    async invoke(method, args = [], executionContext = null) {
      const callback = resolveCallback(method)
      let values
      try {
        if (!Array.isArray(args)) {
          throw serviceError(
            'PLUGIN_SERVICE_ARGUMENT_INVALID',
            'plugin service arguments must be a plain data array',
            identity,
          )
        }
        values = snapshotPluginServiceData(args, {
          code: 'PLUGIN_SERVICE_ARGUMENT_INVALID',
          label: 'plugin service arguments',
        })
      } catch (error) {
        throw isolatedServiceFailure(error, identity)
      }
      const cancellation = isolatedServiceCancellation(executionContext, identity)
      if (cancellation) activeCancellations.add(cancellation)
      try {
        return await invoke(record, 'service', async (...input) => {
          try {
            const callbackInput = cancellation?.context
              ? [...input, cancellation.context]
              : input
            const callbackResult = callback.apply(value, callbackInput)
            const returned = cancellation
              ? await cancellation.wait(callbackResult)
              : await callbackResult
            return snapshotPluginServiceData(returned, {
              code: 'PLUGIN_SERVICE_RESULT_INVALID',
              label: 'plugin service result',
            })
          } catch (error) {
            throw isolatedServiceFailure(error, identity)
          }
        }, values)
      } finally {
        if (cancellation) {
          activeCancellations.delete(cancellation)
          cancellation.dispose()
        }
      }
    },
  })
}
