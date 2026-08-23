import { types as utilTypes } from 'node:util'

import {
  normalizeManagedAttachmentBindInput,
  normalizeManagedAttachmentPrepareInput,
  normalizeManagedAttachmentValidateInput,
  validateManagedAttachmentList,
  validateManagedAttachmentPreparedOutput,
} from './managedAttachmentRuntimeBoundary.js'
import {
  managedAttachmentBoundaryError,
  normalizeManagedAttachmentOperationError,
} from './managedAttachmentRuntimeErrors.js'

export const MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION = 1

export const MANAGED_ATTACHMENT_RUNTIME_PORT_METHODS = Object.freeze([
  'validateAttachments',
  'bindAttachments',
  'prepareAttachments',
])

const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const preparedPorts = new WeakSet()
const preparedSnapshots = new WeakMap()
let activeBinding = null

function portError(code, message, extras = {}) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
    ...extras,
  })
}

function invalidPort(message) {
  return portError('MANAGED_ATTACHMENT_RUNTIME_PORT_INVALID', message)
}

function isPlainCandidate(value) {
  if (!value || typeof value !== 'object') return false
  try {
    if (utilTypes.isProxy(value) || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function candidateDataValue(candidate, field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(candidate, field)
  } catch {
    throw invalidPort('managed attachment runtime port could not be safely inspected')
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw invalidPort(`managed attachment runtime port ${field} must be an enumerable own data property`)
  }
  return descriptor.value
}

function boundaryResultError(message) {
  return managedAttachmentBoundaryError(message)
}

function assertPristineNativePromise(value) {
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
  } catch {
    throw boundaryResultError('managed attachment runtime Promise could not be safely inspected')
  }
  if (prototype !== Promise.prototype) {
    throw boundaryResultError('managed attachment runtime Promise must not expose custom properties')
  }
  for (const key of keys) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw boundaryResultError('managed attachment runtime Promise could not be safely inspected')
    }
    if (typeof key === 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw boundaryResultError('managed attachment runtime Promise must not expose custom properties')
    }
  }
}

function validateResult(result, validate) {
  const fulfilled = (output) => {
    try {
      return validate(output)
    } catch (error) {
      throw normalizeManagedAttachmentOperationError(error)
    }
  }
  const rejected = (error) => {
    throw normalizeManagedAttachmentOperationError(error)
  }
  try {
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      if (utilTypes.isProxy(result)) {
        throw boundaryResultError('managed attachment runtime result must not be a Proxy')
      }
    }
    if (utilTypes.isPromise(result)) {
      assertPristineNativePromise(result)
      return Promise.prototype.then.call(result, fulfilled, rejected)
    }
    if (result && (typeof result === 'object' || typeof result === 'function')) {
      let descriptor
      try {
        descriptor = Object.getOwnPropertyDescriptor(result, 'then')
      } catch {
        throw boundaryResultError('managed attachment runtime result could not be safely inspected')
      }
      if (descriptor) {
        if (
          !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.value !== 'function'
          || utilTypes.isProxy(descriptor.value)
        ) {
          throw boundaryResultError(
            'managed attachment runtime result.then must be an own data function',
          )
        }
        const settled = new Promise((resolve, reject) => {
          try {
            Reflect.apply(descriptor.value, result, [
              (value) => resolve(Object.freeze({ value })),
              reject,
            ])
          } catch {
            reject(boundaryResultError('managed attachment runtime thenable failed at its boundary'))
          }
        })
        return Promise.prototype.then.call(
          settled,
          (entry) => fulfilled(entry.value),
          rejected,
        )
      }
    }
    return fulfilled(result)
  } catch (error) {
    throw normalizeManagedAttachmentOperationError(error)
  }
}

function invokePreparedMethod(method, receiver, input, validate) {
  let result
  try {
    result = Reflect.apply(method, receiver, [input])
  } catch (error) {
    throw normalizeManagedAttachmentOperationError(error)
  }
  return validateResult(result, validate)
}

export function prepareManagedAttachmentRuntimePort(candidate) {
  if (preparedPorts.has(candidate)) return candidate
  if (candidate && preparedSnapshots.has(candidate)) return preparedSnapshots.get(candidate)
  if (!isPlainCandidate(candidate)) {
    throw invalidPort('managed attachment runtime port must be a non-Proxy plain object')
  }
  const id = candidateDataValue(candidate, 'id')
  const apiVersion = candidateDataValue(candidate, 'apiVersion')
  if (typeof id !== 'string' || !PORT_ID_PATTERN.test(id)) {
    throw invalidPort('managed attachment runtime port id is invalid')
  }
  if (apiVersion !== MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION) {
    throw portError(
      'MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION_UNSUPPORTED',
      `managed attachment runtime port ${id} requires apiVersion ${MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION}`,
    )
  }
  const methods = Object.fromEntries(MANAGED_ATTACHMENT_RUNTIME_PORT_METHODS.map((name) => {
    const method = candidateDataValue(candidate, name)
    if (typeof method !== 'function' || utilTypes.isProxy(method)) {
      throw invalidPort(`managed attachment runtime port ${id} must implement ${name}()`)
    }
    return [name, method]
  }))
  const receiver = Object.freeze({ id, apiVersion, ...methods })
  const prepared = Object.freeze({
    id,
    apiVersion,
    validateAttachments(input) {
      const normalized = normalizeManagedAttachmentValidateInput(input)
      return invokePreparedMethod(
        methods.validateAttachments,
        receiver,
        normalized,
        (output) => validateManagedAttachmentList(output, normalized, 'validateAttachments'),
      )
    },
    bindAttachments(input) {
      const normalized = normalizeManagedAttachmentBindInput(input)
      return invokePreparedMethod(
        methods.bindAttachments,
        receiver,
        normalized,
        (output) => validateManagedAttachmentList(output, normalized, 'bindAttachments'),
      )
    },
    prepareAttachments(input) {
      const normalized = normalizeManagedAttachmentPrepareInput(input)
      return invokePreparedMethod(
        methods.prepareAttachments,
        receiver,
        normalized,
        (output) => validateManagedAttachmentPreparedOutput(output, normalized),
      )
    },
  })
  preparedPorts.add(prepared)
  preparedSnapshots.set(candidate, prepared)
  preparedSnapshots.set(prepared, prepared)
  return prepared
}

function revokedError(authority) {
  return portError(
    'MANAGED_ATTACHMENT_RUNTIME_PORT_REVOKED',
    `managed attachment runtime ${authority} is no longer authoritative`,
    { statusCode: 503 },
  )
}

function revocablePort(port, authority, isAuthorized, {
  beginInvocation = () => {},
  endInvocation = () => {},
} = {}) {
  const invoke = (method, input) => {
    if (!isAuthorized()) throw revokedError(authority)
    beginInvocation()
    let result
    try {
      result = port[method](input)
    } catch (error) {
      endInvocation()
      throw error
    }
    if (utilTypes.isPromise(result)) {
      return Promise.prototype.then.call(
        result,
        (value) => {
          const authorized = isAuthorized()
          endInvocation()
          if (!authorized) throw revokedError(authority)
          return value
        },
        (error) => {
          const authorized = isAuthorized()
          endInvocation()
          if (!authorized) throw revokedError(authority)
          throw error
        },
      )
    }
    const authorized = isAuthorized()
    endInvocation()
    if (!authorized) throw revokedError(authority)
    return result
  }
  return Object.freeze({
    id: port.id,
    apiVersion: port.apiVersion,
    validateAttachments: (input) => invoke('validateAttachments', input),
    bindAttachments: (input) => invoke('bindAttachments', input),
    prepareAttachments: (input) => invoke('prepareAttachments', input),
  })
}

function invocationTracker(binding) {
  return {
    beginInvocation() {
      binding.inFlightCalls += 1
    },
    endInvocation() {
      binding.inFlightCalls = Math.max(0, binding.inFlightCalls - 1)
    },
  }
}

export function createManagedAttachmentRuntimePortController(input, {
  source = 'host.lifecycle',
} = {}) {
  const prepared = prepareManagedAttachmentRuntimePort(input)
  if (typeof source !== 'string' || !source.trim() || source.trim() !== source) {
    throw boundaryResultError('managed attachment runtime source must be a normalized string')
  }
  const normalizedSource = source
  let binding = null
  let controllerAuthorized = false
  return Object.freeze({
    portId: prepared.id,
    activate() {
      if (binding) return binding.port
      if (activeBinding) {
        throw portError(
          'MANAGED_ATTACHMENT_RUNTIME_PORT_ALREADY_ACTIVE',
          `managed attachment runtime port ${activeBinding.port.id} is already active`,
        )
      }
      controllerAuthorized = true
      const nextBinding = {
        prepared,
        port: null,
        source: normalizedSource,
        leases: new Set(),
        inFlightCalls: 0,
      }
      nextBinding.port = revocablePort(
        prepared,
        'controller capability',
        () => controllerAuthorized && activeBinding === nextBinding,
        invocationTracker(nextBinding),
      )
      binding = nextBinding
      activeBinding = nextBinding
      return nextBinding.port
    },
    release() {
      if (!binding) return false
      if (activeBinding !== binding) {
        throw portError(
          'MANAGED_ATTACHMENT_RUNTIME_PORT_BINDING_STALE',
          `managed attachment runtime port ${prepared.id} binding is no longer authoritative`,
        )
      }
      if (binding.leases.size > 0 || binding.inFlightCalls > 0) {
        throw portError(
          'MANAGED_ATTACHMENT_RUNTIME_PORT_IN_USE',
          `managed attachment runtime port ${prepared.id} cannot be released while capabilities are active`,
          { statusCode: 503 },
        )
      }
      controllerAuthorized = false
      activeBinding = null
      binding = null
      return true
    },
  })
}

export function acquireManagedAttachmentRuntimePort() {
  if (!activeBinding) {
    throw portError(
      'MANAGED_ATTACHMENT_RUNTIME_PORT_NOT_CONFIGURED',
      'Managed attachment runtime must be activated before it is acquired',
      { statusCode: 503 },
    )
  }
  const binding = activeBinding
  const token = Object.freeze({})
  binding.leases.add(token)
  let released = false
  const port = revocablePort(
    binding.prepared,
    'lease capability',
    () => !released && activeBinding === binding && binding.leases.has(token),
    invocationTracker(binding),
  )
  return Object.freeze({
    port,
    release() {
      if (released) return false
      if (activeBinding !== binding || !binding.leases.has(token)) {
        throw portError(
          'MANAGED_ATTACHMENT_RUNTIME_PORT_LEASE_STALE',
          `managed attachment runtime port ${binding.port.id} lease is no longer authoritative`,
        )
      }
      binding.leases.delete(token)
      released = true
      return true
    },
  })
}

export function getManagedAttachmentRuntimePortStatus() {
  return Object.freeze({
    configured: Boolean(activeBinding),
    portId: activeBinding?.port.id || null,
    apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
    source: activeBinding?.source || null,
    activeLeases: activeBinding?.leases.size || 0,
    inFlightCalls: activeBinding?.inFlightCalls || 0,
  })
}
