import { projectSessionAdminResult } from './sessionAdminDtos.js'

export const LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION = 1
export const SESSION_ADMIN_PORT_CONTRACT_VERSION = 2
export const SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS = Object.freeze([
  LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
])
export const SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY = 'sqlite-path-sha256-v1'

const CATALOG_BACKEND_TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const CATALOG_INSTANCE_FINGERPRINT_RE = /^[a-f0-9]{64}$/u

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

export const SESSION_ADMIN_PORT_OPTIONAL_METHODS = Object.freeze([
  'importLegacySessions',
  'setSessionWorkspace',
])

export const LEGACY_SESSION_IMPORT_LIMITS = Object.freeze({
  sessionsPerBatch: 20,
  messagesPerSession: 1_000,
  messagesPerBatch: 2_000,
  messageContentCharacters: 1_000_000,
  modelContextCharacters: 256 * 1024,
})

const LEGACY_IMPORT_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

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

function snapshotCatalogSource(input) {
  const fail = (message) => invalidPort(`session admin port catalogSource ${message}`)
  const source = ownDataValue(input, 'catalogSource', fail, { optional: true })
  if (source === undefined) return null
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw fail('must be an object when provided')
  }
  const backendType = ownDataValue(source, 'backendType', fail)
  const instanceFingerprint = ownDataValue(
    source,
    'instanceFingerprint',
    fail,
    { optional: true },
  )
  const fingerprintStrategy = ownDataValue(
    source,
    'fingerprintStrategy',
    fail,
    { optional: true },
  )
  if (typeof backendType !== 'string' || !CATALOG_BACKEND_TYPE_RE.test(backendType)) {
    throw fail('backendType is invalid')
  }
  const hasFingerprint = instanceFingerprint !== undefined
  const hasStrategy = fingerprintStrategy !== undefined
  if (hasFingerprint === hasStrategy) {
    throw fail('must declare exactly one instance fingerprint source')
  }
  if (hasFingerprint && (
    typeof instanceFingerprint !== 'string'
    || !CATALOG_INSTANCE_FINGERPRINT_RE.test(instanceFingerprint)
  )) throw fail('instanceFingerprint must be a lowercase SHA-256 digest')
  if (hasStrategy && (
    backendType !== 'sqlite'
    || fingerprintStrategy !== SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY
  )) throw fail('fingerprintStrategy is unsupported')
  return Object.freeze({
    backendType,
    ...(hasFingerprint ? { instanceFingerprint } : { fingerprintStrategy }),
  })
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

function optionalInteger(method, input, key, { nullable = false } = {}) {
  const value = ownDataValue(
    input,
    key,
    (message) => invalidInput(method, message),
    { optional: true },
  )
  if (value === undefined) return undefined
  if (nullable && value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(method, `${key} must be a non-negative safe integer${nullable ? ' or null' : ''}`)
  }
  return value
}

function plainJsonData(method, value, label, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1
  if (state.nodes > 20_000 || depth > 32) {
    throw invalidInput(method, `${label} exceeds the plain-data safety limit`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput(method, `${label} must contain finite numbers`)
    return value
  }
  if (!value || typeof value !== 'object') {
    throw invalidInput(method, `${label} must contain plain JSON data`)
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) throw invalidInput(method, `${label} is too large`)
    return value.map((item, index) => plainJsonData(method, item, `${label}[${index}]`, state, depth + 1))
  }
  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw invalidInput(method, `${label} must be a plain object`)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidInput(method, `${label} must be a plain object`)
  }
  const projected = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw invalidInput(method, `${label} cannot contain symbol keys`)
    const descriptor = descriptors[key]
    if (!descriptor.enumerable) continue
    if (!Object.hasOwn(descriptor, 'value')) {
      throw invalidInput(method, `${label}.${key} must be an own data property`)
    }
    projected[key] = plainJsonData(method, descriptor.value, `${label}.${key}`, state, depth + 1)
  }
  return projected
}

function legacyImportMessage(method, value, label) {
  const source = inputRecord(method, value)
  const id = requiredString(method, source, 'id')
  const role = requiredString(method, source, 'role', { max: 32 })
  if (!LEGACY_IMPORT_MESSAGE_ROLES.has(role)) {
    throw invalidInput(method, `${label}.role is invalid`)
  }
  const content = ownDataValue(source, 'content', (message) => invalidInput(method, message))
  if (typeof content !== 'string' || content.length > LEGACY_SESSION_IMPORT_LIMITS.messageContentCharacters) {
    throw invalidInput(
      method,
      `${label}.content must be a string of at most ${LEGACY_SESSION_IMPORT_LIMITS.messageContentCharacters} characters`,
    )
  }
  const createdAt = optionalInteger(method, source, 'createdAt')
  const updatedAt = optionalInteger(method, source, 'updatedAt')
  const rawModelContext = ownDataValue(
    source,
    'modelContext',
    (message) => invalidInput(method, message),
    { optional: true },
  )
  let modelContext
  if (rawModelContext !== undefined) {
    if (!rawModelContext || typeof rawModelContext !== 'object' || Array.isArray(rawModelContext)) {
      throw invalidInput(method, `${label}.modelContext must be a plain object`)
    }
    modelContext = plainJsonData(method, rawModelContext, `${label}.modelContext`)
    if (JSON.stringify(modelContext).length > LEGACY_SESSION_IMPORT_LIMITS.modelContextCharacters) {
      throw invalidInput(method, `${label}.modelContext is too large`)
    }
  }
  return {
    id,
    role,
    content,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(modelContext === undefined ? {} : { modelContext }),
  }
}

function legacyImportSession(method, value, index) {
  const source = inputRecord(method, value)
  const label = `sessions[${index}]`
  const id = requiredString(method, source, 'id')
  const title = optionalString(method, source, 'title', { max: 4096 })
  const workspacePath = optionalString(method, source, 'workspacePath', {
    max: 32_768,
    trim: true,
  })
  const createdAt = optionalInteger(method, source, 'createdAt')
  const updatedAt = optionalInteger(method, source, 'updatedAt')
  const lastViewedAt = optionalInteger(method, source, 'lastViewedAt', { nullable: true })
  const archivedAt = optionalInteger(method, source, 'archivedAt', { nullable: true })
  const pinnedAt = optionalInteger(method, source, 'pinnedAt', { nullable: true })
  const messages = ownDataValue(source, 'messages', (message) => invalidInput(method, message))
  if (!Array.isArray(messages)
    || messages.length > LEGACY_SESSION_IMPORT_LIMITS.messagesPerSession) {
    throw invalidInput(
      method,
      `${label}.messages must contain at most ${LEGACY_SESSION_IMPORT_LIMITS.messagesPerSession} items`,
    )
  }
  return {
    id,
    title: title ?? 'Untitled',
    ...(workspacePath ? { workspacePath } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(pinnedAt === undefined ? {} : { pinnedAt }),
    messages: messages.map((message, messageIndex) => (
      legacyImportMessage(method, message, `${label}.messages[${messageIndex}]`)
    )),
  }
}

function legacyImportInput(method, input) {
  const source = inputRecord(method, input)
  const userId = requiredString(method, source, 'userId')
  const sessions = ownDataValue(source, 'sessions', (message) => invalidInput(method, message))
  if (!Array.isArray(sessions) || sessions.length < 1
    || sessions.length > LEGACY_SESSION_IMPORT_LIMITS.sessionsPerBatch) {
    throw invalidInput(
      method,
      `sessions must contain between 1 and ${LEGACY_SESSION_IMPORT_LIMITS.sessionsPerBatch} items`,
    )
  }
  const normalized = sessions.map((session, index) => legacyImportSession(method, session, index))
  const sessionIds = new Set()
  const messageIds = new Set()
  let messageCount = 0
  for (const session of normalized) {
    if (sessionIds.has(session.id)) throw invalidInput(method, `duplicate session id: ${session.id}`)
    sessionIds.add(session.id)
    messageCount += session.messages.length
    for (const message of session.messages) {
      if (messageIds.has(message.id)) throw invalidInput(method, `duplicate message id: ${message.id}`)
      messageIds.add(message.id)
    }
  }
  if (messageCount > LEGACY_SESSION_IMPORT_LIMITS.messagesPerBatch) {
    throw invalidInput(
      method,
      `sessions contain more than ${LEGACY_SESSION_IMPORT_LIMITS.messagesPerBatch} messages`,
    )
  }
  return { userId, sessions: normalized }
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

function sessionWorkspaceInput(method, input) {
  const source = inputRecord(method, input)
  const workspacePath = ownDataValue(
    source,
    'workspacePath',
    (message) => invalidInput(method, message),
  )
  if (workspacePath === null) {
    return { ...sessionInput(method, source), workspacePath: null }
  }
  if (typeof workspacePath !== 'string') {
    throw invalidInput(method, 'workspacePath must be a non-empty string or null')
  }
  const normalized = workspacePath.trim()
  if (!normalized || normalized.length > 32_768) {
    throw invalidInput(method, 'workspacePath must be a non-empty string of at most 32768 characters or null')
  }
  return { ...sessionInput(method, source), workspacePath: normalized }
}

function normalizeInput(method, input) {
  if (method === 'importLegacySessions') return legacyImportInput(method, input)
  if (method === 'setSessionWorkspace') return sessionWorkspaceInput(method, input)
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
  const catalogSource = snapshotCatalogSource(input)
  const prepared = {
    contractVersion,
    ...(catalogSource ? { catalogSource } : {}),
  }
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
  for (const method of SESSION_ADMIN_PORT_OPTIONAL_METHODS) {
    const implementation = ownDataValue(
      input,
      method,
      (message) => invalidPort(`session admin port ${message}`),
      { optional: true },
    )
    if (implementation === undefined) continue
    if (typeof implementation !== 'function') {
      throw invalidPort(`session admin port ${method} must be a function when provided`)
    }
    prepared[method] = contractVersion === LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION
      ? implementation
      : wrapMethod(method, implementation)
  }
  const snapshot = Object.freeze(prepared)
  preparedPorts.add(snapshot)
  return snapshot
}
