import { types as utilTypes } from 'node:util'

export function adapterError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    if (utilTypes.isProxy(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

export function ownDescriptor(target, key) {
  try {
    return Object.getOwnPropertyDescriptor(target, key) || null
  } catch {
    return null
  }
}

export function optionalOwnDataValue(target, key, label) {
  const descriptor = ownDescriptor(target, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      `${label} must declare ${key} as a data property`,
    )
  }
  return descriptor.value
}

export function assertAllowedOwnKeys(target, allowed, label) {
  let keys
  try {
    keys = Reflect.ownKeys(target)
  } catch {
    throw adapterError('TOOL_LOOP_ADAPTER_INVALID', `${label} cannot be inspected safely`)
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw adapterError(
        'TOOL_LOOP_ADAPTER_INVALID',
        `${label} contains unsupported field ${String(key)}`,
      )
    }
  }
}

export function ownDataValue(target, key, label) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key)
  } catch {
    descriptor = null
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw adapterError(
      'TOOL_LOOP_ADAPTER_INVALID',
      `${label} must declare own data property ${key}`,
    )
  }
  return descriptor.value
}
