import {
  GOVERNANCE_INPUT_VALIDATORS,
  GOVERNANCE_METHODS,
  GOVERNANCE_OUTPUT_VALIDATORS,
  assertGovernanceData,
} from './compactionArchiveGovernanceContract.js'
import {
  assertAllowedFields,
  assertIdentity,
  assertNonNegativeInteger,
  assertRecord,
  boundaryError,
  frozenData,
  identityError,
  portError,
} from './compactionArchivePortValidation.js'

export const COMPACTION_ARCHIVE_PORT_VERSION = 1
export const COMPACTION_ARCHIVE_GOVERNANCE_VERSION = 1

const RUNTIME_METHODS = Object.freeze(['create', 'get', 'cleanup'])
const REQUIRED_METHODS = RUNTIME_METHODS
const AUDIT_LIMIT = 256
const HOST_PORTS = new WeakSet()
const auditEvents = []
let auditSequence = 0
let activeBinding = null
const ARCHIVE_FIELDS = Object.freeze([
  'id',
  'userId',
  'sessionId',
  'replacedMessageCount',
  'archivedMessages',
  'summaryText',
  'createdAt',
])
const CREATE_INPUT_FIELDS = Object.freeze([
  'userId',
  'sessionId',
  'archivedMessages',
  'summaryText',
  'id',
])
const GET_INPUT_FIELDS = Object.freeze(['userId', 'id'])
const CLEANUP_INPUT_FIELDS = Object.freeze([
  'userId',
  'now',
  'orphanGraceMs',
  'maxEntries',
])
const CLEANUP_METRIC_FIELDS = Object.freeze([
  'scanned',
  'removedFiles',
  'removedBytes',
  'preserved',
  'unsafe',
])
function emit(event, binding, details = {}) {
  const entry = Object.freeze({
    event,
    portId: binding.port.id,
    apiVersion: binding.port.apiVersion,
    source: binding.source,
    sequence: auditSequence += 1,
    at: Date.now(),
    ...details,
  })
  auditEvents.push(entry)
  if (auditEvents.length > AUDIT_LIMIT) {
    auditEvents.splice(0, auditEvents.length - AUDIT_LIMIT)
  }
}

function assertCreateInput(input) {
  assertRecord(input, 'input', 'create')
  assertAllowedFields(input, CREATE_INPUT_FIELDS, 'input', 'create')
  assertIdentity(input.userId, 'input', 'create', 'userId')
  assertIdentity(input.sessionId, 'input', 'create', 'sessionId')
  if (!Array.isArray(input.archivedMessages)) {
    throw boundaryError('input', 'create', 'archivedMessages must be an array')
  }
  if (typeof input.summaryText !== 'string') {
    throw boundaryError('input', 'create', 'summaryText must be a string')
  }
  if (input.id !== undefined) assertIdentity(input.id, 'input', 'create', 'id')
  return input
}

function assertGetInput(input) {
  assertRecord(input, 'input', 'get')
  assertAllowedFields(input, GET_INPUT_FIELDS, 'input', 'get')
  assertIdentity(input.userId, 'input', 'get', 'userId')
  assertIdentity(input.id, 'input', 'get', 'id')
  return input
}

function assertCleanupInput(input) {
  assertRecord(input, 'input', 'cleanup')
  assertAllowedFields(input, CLEANUP_INPUT_FIELDS, 'input', 'cleanup')
  assertIdentity(input.userId, 'input', 'cleanup', 'userId')
  for (const field of CLEANUP_INPUT_FIELDS.slice(1)) {
    if (input[field] !== undefined) {
      assertNonNegativeInteger(input[field], 'input', 'cleanup', field)
    }
  }
  return input
}

function assertArchiveOutput(output, method, input) {
  assertRecord(output, 'output', method)
  assertAllowedFields(output, ARCHIVE_FIELDS, 'output', method)
  const id = assertIdentity(output.id, 'output', method, 'id')
  const userId = assertIdentity(output.userId, 'output', method, 'userId')
  const sessionId = assertIdentity(output.sessionId, 'output', method, 'sessionId')
  if (userId !== input.userId) {
    throw identityError(method, 'userId', input.userId, userId)
  }
  if (method === 'get' && id !== input.id) {
    throw identityError(method, 'id', input.id, id)
  }
  if (method === 'create' && input.id !== undefined && id !== input.id) {
    throw identityError(method, 'id', input.id, id)
  }
  if (method === 'create' && sessionId !== input.sessionId) {
    throw identityError(method, 'sessionId', input.sessionId, sessionId)
  }
  if (!Array.isArray(output.archivedMessages)) {
    throw boundaryError('output', method, 'archivedMessages must be an array')
  }
  const count = assertNonNegativeInteger(
    output.replacedMessageCount,
    'output',
    method,
    'replacedMessageCount',
  )
  if (count !== output.archivedMessages.length) {
    throw boundaryError(
      'output',
      method,
      'replacedMessageCount must equal archivedMessages.length',
    )
  }
  if (typeof output.summaryText !== 'string') {
    throw boundaryError('output', method, 'summaryText must be a string')
  }
  assertNonNegativeInteger(output.createdAt, 'output', method, 'createdAt')
  return output
}

function assertCreateOutput(output, input) {
  return assertArchiveOutput(output, 'create', input)
}

function assertGetOutput(output, input) {
  return output === null ? null : assertArchiveOutput(output, 'get', input)
}

function assertCleanupOutput(output) {
  assertRecord(output, 'output', 'cleanup')
  const fields = Object.keys(output)
  if (fields.length === 1 && fields[0] === 'removed') {
    assertNonNegativeInteger(output.removed, 'output', 'cleanup', 'removed')
    return output
  }
  assertAllowedFields(output, CLEANUP_METRIC_FIELDS, 'output', 'cleanup')
  for (const field of CLEANUP_METRIC_FIELDS) {
    assertNonNegativeInteger(output[field], 'output', 'cleanup', field)
  }
  return output
}

const INPUT_VALIDATORS = Object.freeze({
  create: assertCreateInput,
  get: assertGetInput,
  cleanup: assertCleanupInput,
  ...GOVERNANCE_INPUT_VALIDATORS,
})

const OUTPUT_VALIDATORS = Object.freeze({
  create: assertCreateOutput,
  get: assertGetOutput,
  cleanup: assertCleanupOutput,
  ...GOVERNANCE_OUTPUT_VALIDATORS,
})

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_INVALID',
      'Compaction archive adapter must be an object',
    )
  }
  const version = Number(adapter.apiVersion)
  if (version !== COMPACTION_ARCHIVE_PORT_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
      `Compaction archive adapter apiVersion must be ${COMPACTION_ARCHIVE_PORT_VERSION}`,
    )
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_INVALID',
        `Compaction archive adapter is missing ${method}()`,
      )
    }
  }
  const governanceMethods = GOVERNANCE_METHODS.filter(
    (method) => typeof adapter[method] === 'function',
  )
  if (governanceMethods.length > 0 && governanceMethods.length !== GOVERNANCE_METHODS.length) {
    const missing = GOVERNANCE_METHODS.find((method) => typeof adapter[method] !== 'function')
    throw portError(
      'COMPACTION_ARCHIVE_PORT_INVALID',
      `Compaction archive governance adapter is missing ${missing}()`,
    )
  }
  if (governanceMethods.length > 0
    && Number(adapter.governanceApiVersion) !== COMPACTION_ARCHIVE_GOVERNANCE_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_GOVERNANCE_VERSION_UNSUPPORTED',
      `Compaction archive governance apiVersion must be ${COMPACTION_ARCHIVE_GOVERNANCE_VERSION}`,
    )
  }
  return { adapter, governanceMethods }
}

/**
 * Host-owned CompactionArchivePort v1 with an optional governance v1 surface.
 *
 * Runtime methods may return a value or Promise. Governance methods are
 * deliberately synchronous so export snapshots and staged deletion barriers
 * cannot escape their host-owned transaction/lifecycle scope.
 */
export function createCompactionArchivePort(adapter) {
  const { adapter: normalized, governanceMethods } = normalizeAdapter(adapter)
  const methodNames = [...REQUIRED_METHODS, ...governanceMethods]

  const invoke = (method, input) => {
    if (GOVERNANCE_METHODS.includes(method)) {
      assertGovernanceData(input, 'input', method)
    }
    const boundaryInput = frozenData(input)
    INPUT_VALIDATORS[method](boundaryInput)
    const result = normalized[method](boundaryInput)
    if (GOVERNANCE_METHODS.includes(method) && isPromiseLike(result)) {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_GOVERNANCE_ASYNC_UNSUPPORTED',
        `CompactionArchivePort ${method} must return synchronously`,
      )
    }
    const settle = (value) => {
      if (GOVERNANCE_METHODS.includes(method)) {
        assertGovernanceData(value, 'output', method)
      }
      const boundaryOutput = frozenData(value)
      return frozenData(OUTPUT_VALIDATORS[method](boundaryOutput, boundaryInput))
    }
    return isPromiseLike(result)
      ? Promise.resolve(result).then(settle)
      : settle(result)
  }

  const methods = Object.fromEntries(methodNames.map((method) => [
    method,
    (input) => invoke(method, input),
  ]))
  const port = Object.freeze({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    governanceApiVersion: governanceMethods.length > 0
      ? COMPACTION_ARCHIVE_GOVERNANCE_VERSION
      : null,
    id: String(normalized.id || 'compaction-archive-adapter').trim()
      || 'compaction-archive-adapter',
    ...methods,
  })
  HOST_PORTS.add(port)
  return port
}

export function assertCompactionArchivePort(port) {
  if (!port || Number(port.apiVersion) !== COMPACTION_ARCHIVE_PORT_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
      `CompactionArchivePort v${COMPACTION_ARCHIVE_PORT_VERSION} is required`,
    )
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof port[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_PORT_INVALID',
        `CompactionArchivePort is missing ${method}()`,
      )
    }
  }
  if (!HOST_PORTS.has(port)) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_UNTRUSTED',
      'CompactionArchivePort must be created by the host boundary',
    )
  }
  return port
}

export function assertCompactionArchiveGovernancePort(port) {
  const trusted = assertCompactionArchivePort(port)
  if (Number(trusted.governanceApiVersion) !== COMPACTION_ARCHIVE_GOVERNANCE_VERSION) {
    throw portError(
      'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
      'CompactionArchivePort governance capability is not configured',
    )
  }
  for (const method of GOVERNANCE_METHODS) {
    if (typeof trusted[method] !== 'function') {
      throw portError(
        'COMPACTION_ARCHIVE_GOVERNANCE_NOT_CONFIGURED',
        `CompactionArchivePort governance is missing ${method}()`,
      )
    }
  }
  return trusted
}

function createRevocableCompactionArchivePort(port, {
  isAuthorized,
  authority = 'runtime capability',
} = {}) {
  const target = assertCompactionArchivePort(port)
  if (typeof isAuthorized !== 'function') {
    throw new TypeError('CompactionArchivePort revocation authority must be a function')
  }
  const assertAuthorized = () => {
    if (isAuthorized()) return
    throw portError(
      'COMPACTION_ARCHIVE_PORT_REVOKED',
      `CompactionArchivePort ${target.id} ${authority} has been revoked`,
    )
  }
  const invoke = (method, input) => {
    assertAuthorized()
    return target[method](input)
  }
  const governanceMethods = Number(target.governanceApiVersion)
      === COMPACTION_ARCHIVE_GOVERNANCE_VERSION
    ? GOVERNANCE_METHODS
    : []
  const methods = Object.fromEntries([...REQUIRED_METHODS, ...governanceMethods].map((method) => [
    method,
    (input) => invoke(method, input),
  ]))
  const facade = Object.freeze({
    apiVersion: target.apiVersion,
    governanceApiVersion: target.governanceApiVersion ?? null,
    id: target.id,
    ...methods,
  })
  HOST_PORTS.add(facade)
  return facade
}

function prepareControllerPort(input) {
  try {
    return assertCompactionArchivePort(input)
  } catch (error) {
    if (error?.code !== 'COMPACTION_ARCHIVE_PORT_UNTRUSTED') throw error
    return createCompactionArchivePort(input)
  }
}

function activatePort(port, source) {
  if (activeBinding) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_ALREADY_ACTIVE',
      `CompactionArchivePort ${activeBinding.port.id} is already active`,
    )
  }
  const binding = {
    port,
    source: String(source || 'host').trim().slice(0, 80) || 'host',
    leases: new Set(),
  }
  activeBinding = binding
  emit('compaction_archive.configured', binding)
  return binding
}

/** Host lifecycle controller. Runtime consumers can acquire but cannot replace the active port. */
export function createCompactionArchivePortController(input, {
  source = 'host.lifecycle',
} = {}) {
  const hostPort = prepareControllerPort(input)
  let activation = null
  return Object.freeze({
    portId: hostPort.id,
    activate() {
      if (activation) return activation.port
      let authorized = true
      let ownedBinding = null
      const port = createRevocableCompactionArchivePort(hostPort, {
        authority: 'controller capability',
        isAuthorized: () => authorized && activeBinding === ownedBinding,
      })
      ownedBinding = activatePort(port, source)
      activation = {
        binding: ownedBinding,
        port,
        revoke: () => { authorized = false },
      }
      return port
    },
    release() {
      if (!activation) return false
      const { binding } = activation
      if (activeBinding !== binding) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_BINDING_STALE',
          `CompactionArchivePort binding ${hostPort.id} is no longer authoritative`,
        )
      }
      if (binding.leases.size > 0) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_IN_USE',
          `CompactionArchivePort ${hostPort.id} cannot be released while leases are active`,
        )
      }
      emit('compaction_archive.released', binding)
      activation.revoke()
      activeBinding = null
      activation = null
      return true
    },
  })
}

/** Acquire one immutable port snapshot for a complete archive operation scope. */
export function acquireCompactionArchivePort() {
  if (!activeBinding) {
    throw portError(
      'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
      'CompactionArchivePort must be activated before it is acquired',
    )
  }
  const binding = activeBinding
  const token = Object.freeze({})
  binding.leases.add(token)
  let released = false
  const port = createRevocableCompactionArchivePort(binding.port, {
    authority: 'lease capability',
    isAuthorized: () => !released
      && activeBinding === binding
      && binding.leases.has(token),
  })
  emit('compaction_archive.lease_acquired', binding, { activeLeases: binding.leases.size })
  return Object.freeze({
    port,
    release() {
      if (released) return false
      if (activeBinding !== binding || !binding.leases.has(token)) {
        throw portError(
          'COMPACTION_ARCHIVE_PORT_LEASE_STALE',
          `CompactionArchivePort lease ${binding.port.id} is no longer authoritative`,
        )
      }
      binding.leases.delete(token)
      released = true
      emit('compaction_archive.lease_released', binding, { activeLeases: binding.leases.size })
      return true
    },
  })
}

export function getCompactionArchivePortStatus() {
  if (!activeBinding) {
    return Object.freeze({
      configured: false,
      portId: null,
      apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
      activeLeases: 0,
      source: null,
    })
  }
  return Object.freeze({
    configured: true,
    portId: activeBinding.port.id,
    apiVersion: activeBinding.port.apiVersion,
    activeLeases: activeBinding.leases.size,
    source: activeBinding.source,
  })
}

export function listCompactionArchivePortAuditEvents() {
  return Object.freeze([...auditEvents])
}
