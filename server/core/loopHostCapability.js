import { isProxy, isSharedArrayBuffer } from 'node:util/types'

export const LOOP_HOST_BROKER_API_VERSION = 1
export const LOOP_HOST_ADAPTER_CONTRACT_VERSION = 3
export const LOOP_HOST_SUPPORTED_ADAPTER_CONTRACT_VERSIONS = Object.freeze([2, 3])
export const LOOP_HOST_CAPABILITY_DECLARATION_MAX_BYTES = 256

export const LOOP_HOST_CAPABILITY_ERROR_CODES = Object.freeze({
  INVALID_DECLARATION: 'LOOP_HOST_CAPABILITY_DECLARATION_INVALID',
  UNSUPPORTED_ADAPTER_VERSION: 'LOOP_HOST_ADAPTER_VERSION_UNSUPPORTED',
})

const SUPPORTED_ADAPTER_CONTRACT_VERSIONS = new Set(
  LOOP_HOST_SUPPORTED_ADAPTER_CONTRACT_VERSIONS,
)
const CAPABILITY_KEYS = Object.freeze(['loopBroker'])

function capabilityError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function invalidDeclaration(message) {
  return capabilityError(
    LOOP_HOST_CAPABILITY_ERROR_CODES.INVALID_DECLARATION,
    message,
  )
}

function ownDataDescriptor(target, key, label, { required = true } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key)
  } catch {
    throw invalidDeclaration(`${label} could not be inspected safely`)
  }
  if (!descriptor) {
    if (!required) return null
    throw invalidDeclaration(`${label} must declare own data property ${key}`)
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw invalidDeclaration(`${label} must declare own data property ${key}`)
  }
  return descriptor
}

function assertInspectableObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw invalidDeclaration(`${label} must be a non-proxy object`)
  }
}

function assertPlainCapabilityObject(value) {
  assertInspectableObject(value, 'adapter hostCapabilities')
  if (isSharedArrayBuffer(value)) {
    throw invalidDeclaration('adapter hostCapabilities must not contain shared memory')
  }

  let prototype
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    throw invalidDeclaration('adapter hostCapabilities could not be inspected safely')
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidDeclaration('adapter hostCapabilities must be a plain data object')
  }

  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw invalidDeclaration('adapter hostCapabilities could not be inspected safely')
  }
  if (keys.length > CAPABILITY_KEYS.length) {
    throw invalidDeclaration('adapter hostCapabilities contains unsupported capability fields')
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !CAPABILITY_KEYS.includes(key)) {
      throw invalidDeclaration('adapter hostCapabilities contains unsupported capability fields')
    }
  }
}

function projectHostCapabilities(adapter, contractVersion) {
  const declaration = ownDataDescriptor(
    adapter,
    'hostCapabilities',
    'loop adapter',
    { required: contractVersion === LOOP_HOST_ADAPTER_CONTRACT_VERSION },
  )
  if (!declaration) return Object.freeze({})

  const hostCapabilities = declaration.value
  assertPlainCapabilityObject(hostCapabilities)
  const loopBroker = ownDataDescriptor(
    hostCapabilities,
    'loopBroker',
    'adapter hostCapabilities',
    { required: contractVersion === LOOP_HOST_ADAPTER_CONTRACT_VERSION },
  )
  if (!loopBroker) return Object.freeze({})
  if (isSharedArrayBuffer(loopBroker.value) || loopBroker.value !== LOOP_HOST_BROKER_API_VERSION) {
    throw invalidDeclaration(
      `adapter hostCapabilities.loopBroker must equal ${LOOP_HOST_BROKER_API_VERSION}`,
    )
  }
  return Object.freeze({ loopBroker: LOOP_HOST_BROKER_API_VERSION })
}

/**
 * Validate and detach the small, data-only capability handshake for a Loop
 * adapter. This declaration is not an authority object: callers must still
 * require adapter contract v3 before granting a broker lease.
 */
export function prepareLoopHostCapability(adapter) {
  assertInspectableObject(adapter, 'loop adapter')
  const contractVersionDescriptor = ownDataDescriptor(
    adapter,
    'contractVersion',
    'loop adapter',
  )
  const contractVersion = contractVersionDescriptor.value
  if (!SUPPORTED_ADAPTER_CONTRACT_VERSIONS.has(contractVersion)) {
    throw capabilityError(
      LOOP_HOST_CAPABILITY_ERROR_CODES.UNSUPPORTED_ADAPTER_VERSION,
      'loop adapter contractVersion is unsupported',
    )
  }

  const hostCapabilities = projectHostCapabilities(adapter, contractVersion)
  const snapshot = {
    apiVersion: LOOP_HOST_BROKER_API_VERSION,
    adapterContractVersion: contractVersion,
    hostCapabilities,
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  if (encodedBytes > LOOP_HOST_CAPABILITY_DECLARATION_MAX_BYTES) {
    throw invalidDeclaration('loop host capability declaration exceeds its size limit')
  }
  return Object.freeze(snapshot)
}
