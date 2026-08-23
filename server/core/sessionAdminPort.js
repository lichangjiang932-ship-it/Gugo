import { projectSessionAdminResult } from './sessionAdminDtos.js'

export const LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION = 1
export const SESSION_ADMIN_PORT_CONTRACT_VERSION = 2
export const SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS = Object.freeze([
  LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
])

export const SESSION_ADMIN_PORT_METHODS = Object.freeze([
  'searchMessages',
  'listSessions',
  'getSessionSnapshot',
  'getSessionBranches',
  'forkSession',
  'replaceSessionMessages',
  'deleteSession',
  'archiveSession',
  'unarchiveSession',
  'pinSession',
  'unpinSession',
])

const preparedPorts = new WeakSet()

function portError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function invalidPort(message) {
  return portError('SESSION_ADMIN_PORT_INVALID', message)
}

function invalidInput(method, message) {
  return portError('SESSION_ADMIN_INPUT_INVALID', `${method}: ${message}`)
}

function invalidResult(method, message) {
  return portError('SESSION_ADMIN_RESULT_INVALID', `${method}: ${message}`)
}

function ownDataValue(target, key, errorFactory, { optional = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key)
  } catch {
    descriptor = null
  }
  if (!descriptor) {
    if (optional) return undefined
    throw errorFactory(`must declare own data property ${key}`)
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw errorFactory(`${key} must be an own data property`)
  }
  return descriptor.value
}

function inputRecord(method, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput(method, 'input must be an object')
  }
  return input
}

function requiredString(method, input, key, { max = 512 } = {}) {
  const value = ownDataValue(input, key, (message) => invalidInput(method, message))
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw invalidInput(method, `${key} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function optionalString(method, input, key, { max = 512, trim = false } = {}) {
  const value = ownDataValue(
    input,
    key,
    (message) => invalidInput(method, message),
    { optional: true },
  )
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) {
    throw invalidInput(method, `${key} must be null or a string of at most ${max} characters`)
  }
  return trim ? value.trim() : value
}

function paginationInteger(method, input, key, { fallback, min, max }) {
  const raw = ownDataValue(
    input,
    key,
    (message) => invalidInput(method, message),
    { optional: true },
  )
  if (raw === undefined || raw === null || raw === '') {
    if (Number.isNaN(fallback)) {
      throw invalidInput(method, `${key} is required`)
    }
    return fallback
  }
  let value
  if (typeof raw === 'number') {
    value = raw
  } else if (typeof raw === 'string' && /^-?\d+$/u.test(raw)) {
    value = Number(raw)
  } else {
    throw invalidInput(method, `${key} must be an integer between ${min} and ${max}`)
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidInput(method, `${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function userInput(method, input) {
  const source = inputRecord(method, input)
  return { userId: requiredString(method, source, 'userId') }
}

function sessionInput(method, input) {
  const source = inputRecord(method, input)
  return {
    userId: requiredString(method, source, 'userId'),
    sessionId: requiredString(method, source, 'sessionId'),
  }
}

function normalizeInput(method, input) {
  if (method === 'searchMessages') {
    const source = inputRecord(method, input)
    return {
      ...userInput(method, source),
      query: optionalString(method, source, 'query', { max: 4096 }) || '',
      sessionId: optionalString(method, source, 'sessionId'),
      limit: paginationInteger(method, source, 'limit', { fallback: 20, min: 1, max: 100 }),
      offset: paginationInteger(method, source, 'offset', {
        fallback: 0,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }),
    }
  }
  if (method === 'listSessions') {
    const source = inputRecord(method, input)
    const archived = ownDataValue(
      source,
      'archived',
      (message) => invalidInput(method, message),
      { optional: true },
    ) ?? 'false'
    const normalizedArchived = archived === true ? 'true' : archived === false ? 'false' : archived
    if (!['false', 'true', 'all'].includes(normalizedArchived)) {
      throw invalidInput(method, 'archived must be false, true, or all')
    }
    return {
      ...userInput(method, source),
      archived: normalizedArchived,
      limit: paginationInteger(method, source, 'limit', { fallback: 100, min: 1, max: 200 }),
      offset: paginationInteger(method, source, 'offset', {
        fallback: 0,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }),
    }
  }
  if (method === 'getSessionSnapshot') {
    const source = inputRecord(method, input)
    return {
      ...sessionInput(method, source),
      limit: paginationInteger(method, source, 'limit', { fallback: 2000, min: 1, max: 2000 }),
      offset: paginationInteger(method, source, 'offset', {
        fallback: 0,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }),
    }
  }
  if (method === 'forkSession') {
    const source = inputRecord(method, input)
    return {
      ...sessionInput(method, source),
      label: optionalString(method, source, 'label', { max: 120, trim: true }),
    }
  }
  if (method === 'replaceSessionMessages') {
    const source = inputRecord(method, input)
    const messages = ownDataValue(
      source,
      'messages',
      (message) => invalidInput(method, message),
    )
    if (!Array.isArray(messages) || messages.length > 50_000) {
      throw invalidInput(method, 'messages must be an array with at most 50000 items')
    }
    return {
      ...sessionInput(method, source),
      expectedRevision: paginationInteger(method, source, 'expectedRevision', {
        fallback: Number.NaN,
        min: 0,
        max: Number.MAX_SAFE_INTEGER - 1,
      }),
      messages,
    }
  }
  if (method === 'deleteSession') {
    const source = inputRecord(method, input)
    return {
      ...sessionInput(method, source),
      expectedRevision: paginationInteger(method, source, 'expectedRevision', {
        fallback: Number.NaN,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }),
    }
  }
  return sessionInput(method, input)
}

function validateResult(method, value, input) {
  return projectSessionAdminResult({
    method,
    value,
    input,
    fail(message) {
      throw invalidResult(method, message)
    },
  })
}

function wrapMethod(method, implementation) {
  return function sessionAdminMethod(input) {
    const normalized = normalizeInput(method, input)
    const result = implementation(normalized)
    return result instanceof Promise
      ? Promise.prototype.then.call(
          result,
          (resolved) => validateResult(method, resolved, normalized),
        )
      : validateResult(method, result, normalized)
  }
}

/**
 * Validate and detach the Session management side of a persistence backend.
 * v1 remains accepted for existing embedding hosts. v2 adds normalized inputs
 * and fail-closed result schemas while preserving MaybePromise methods.
 */
export function prepareSessionAdminPort(input) {
  if (preparedPorts.has(input)) return input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidPort('session admin port must be an object')
  }
  const contractVersion = ownDataValue(
    input,
    'contractVersion',
    (message) => invalidPort(`session admin port ${message}`),
  )
  if (!SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS.includes(contractVersion)) {
    throw invalidPort(
      `session admin port requires contractVersion ${SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS.join(' or ')}`,
    )
  }
  const prepared = { contractVersion }
  for (const method of SESSION_ADMIN_PORT_METHODS) {
    const implementation = ownDataValue(
      input,
      method,
      (message) => invalidPort(`session admin port ${message}`),
    )
    if (typeof implementation !== 'function') {
      throw invalidPort(`session admin port ${method} must be a function`)
    }
    prepared[method] = contractVersion === LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION
      ? implementation
      : wrapMethod(method, implementation)
  }
  const snapshot = Object.freeze(prepared)
  preparedPorts.add(snapshot)
  return snapshot
}
