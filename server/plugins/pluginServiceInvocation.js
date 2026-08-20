import { snapshotPluginServiceData } from './pluginServiceData.js'

const MAX_SERVICE_PROPERTIES = 256
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

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
    async invoke(method, args = []) {
      const callback = resolveCallback(method)
      let values
      try {
        values = snapshotPluginServiceData(Array.isArray(args) ? args : [], {
          code: 'PLUGIN_SERVICE_ARGUMENT_INVALID',
          label: 'plugin service arguments',
        })
      } catch (error) {
        throw isolatedServiceFailure(error, identity)
      }
      return invoke(record, 'service', async (...input) => {
        try {
          const returned = await callback.apply(value, input)
          return snapshotPluginServiceData(returned, {
            code: 'PLUGIN_SERVICE_RESULT_INVALID',
            label: 'plugin service result',
          })
        } catch (error) {
          throw isolatedServiceFailure(error, identity)
        }
      }, values)
    },
  })
}
