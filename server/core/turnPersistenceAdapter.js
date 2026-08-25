import { prepareSessionAdminPort } from './sessionAdminPort.js'

export const TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION = 6

const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const AUDIT_LIMIT = 256
const SESSION_FUNCTIONS = Object.freeze([
  'getSession',
  'isSessionIdOccupied',
  'claimLocalChatSession',
  'upsertSession',
  'listMessages',
  'getPreviousUserMessage',
  'upsertMessage',
  'deleteMessage',
])
const EVENT_LOG_FUNCTIONS = Object.freeze([
  'appendTurnEvent',
  'appendTurnEvents',
  'getLastTurnEvent',
  'listTurnEvents',
  'recordTurnEventWriteFailure',
  'verifyTurnEventCommit',
  'getTurnCheckpoint',
  'saveTurnCheckpoint',
  'deleteTurnCheckpoint',
])
const OPTIONAL_EVENT_LOG_FUNCTIONS = Object.freeze([
  'resolveTurnSession',
])
const TRANSACTION_FUNCTIONS = Object.freeze([
  'commitTurnStart',
  'commitTurnCheckpoint',
  'commitTurnBoundary',
])
const OPTIONAL_TRANSACTION_FUNCTIONS = Object.freeze([
  'commitTurnFailedRetry',
  'commitTurnFailedRetryRejection',
])
const EXECUTION_FUNCTIONS = Object.freeze([
  'claimTurnExecutionLease',
  'getTurnExecutionLease',
  'renewTurnExecutionLease',
  'releaseTurnExecutionLease',
  'isTurnExecutionLeaseActive',
  'hasActiveTurnExecutionLeaseForSession',
  'requestTurnExecutionCancellation',
  'tryCloseTurnSteeringInbox',
  'listUnfinishedTurnExecutions',
])
const STEERING_FUNCTIONS = Object.freeze([
  'enqueueTurnSteering',
  'listTurnSteering',
  'claimTurnSteering',
  'acknowledgeTurnSteering',
  'acknowledgeAppliedTurnSteering',
  'releaseTurnSteeringLease',
  'releaseTurnSteeringLeasesForTurn',
])
const RECOVERY_FUNCTIONS = Object.freeze([
  'getTurnRecoveryState',
  'recordTurnRecoveryFailure',
  'clearTurnRecoveryState',
  'listTurnRecoveryStates',
  'pruneResolvedTurnRecoveryStates',
])
const MODEL_REQUEST_RECOVERY_FUNCTIONS = Object.freeze([
  'getPendingModelRequestRecovery',
  'readModelRequestRecoveryResolution',
  'resolvePendingModelRequest',
])

function snapshotAtomicAttachmentRuntimePortIds(input) {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'atomicAttachmentRuntimePortIds')
  if (!descriptor) return Object.freeze([])
  if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      'turn persistence adapter atomicAttachmentRuntimePortIds must be an own array',
    )
  }
  const ids = [...new Set(descriptor.value)]
  if (ids.length !== descriptor.value.length
    || ids.some((id) => typeof id !== 'string' || !ADAPTER_ID_RE.test(id))) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      'turn persistence adapter atomicAttachmentRuntimePortIds must contain unique valid port ids',
    )
  }
  return Object.freeze(ids)
}

const preparedAdapters = new WeakSet()
const preparedAdapterSnapshots = new WeakMap()
const auditEvents = []
let auditSequence = 0
let activeBinding = null

function adapterError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownDataValue(target, key, label) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key)
  } catch {
    descriptor = null
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      `${label} must declare own data property ${key}`,
    )
  }
  return descriptor.value
}

function snapshotFunctionSection(input, key, requiredFunctions, optionalFunctions = []) {
  const section = ownDataValue(input, key, 'turn persistence adapter')
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      `turn persistence adapter ${key} must be an object`,
    )
  }
  const snapshot = {}
  for (const name of requiredFunctions) {
    const value = ownDataValue(section, name, `turn persistence adapter ${key}`)
    if (typeof value !== 'function') {
      throw adapterError(
        'TURN_PERSISTENCE_ADAPTER_INVALID',
        `turn persistence adapter ${key}.${name} must be a function`,
      )
    }
    snapshot[name] = value
  }
  for (const name of optionalFunctions) {
    const descriptor = Object.getOwnPropertyDescriptor(section, name)
    if (!descriptor) continue
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw adapterError(
        'TURN_PERSISTENCE_ADAPTER_INVALID',
        `turn persistence adapter ${key}.${name} must be an own function when provided`,
      )
    }
    snapshot[name] = descriptor.value
  }
  return Object.freeze(snapshot)
}

function emit(event, binding, details = {}) {
  const entry = Object.freeze({
    event,
    adapterId: binding.adapter.id,
    contractVersion: binding.adapter.contractVersion,
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

/**
 * Validate and detach a complete host-owned Turn persistence adapter.
 * Missing members are never filled from SQLite: one configured adapter owns
 * the whole Session Store + Session Log/checkpoint boundary.
 */
export function prepareTurnPersistenceAdapter(input) {
  const candidate = input
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw adapterError('TURN_PERSISTENCE_ADAPTER_INVALID', 'turn persistence adapter must be an object')
  }
  const existingSnapshot = preparedAdapterSnapshots.get(candidate)
  if (existingSnapshot) return existingSnapshot
  const id = ownDataValue(candidate, 'id', 'turn persistence adapter')
  if (typeof id !== 'string' || !ADAPTER_ID_RE.test(id)) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      'turn persistence adapter id must match [a-z0-9][a-z0-9._:-]{0,127}',
    )
  }
  const contractVersion = ownDataValue(candidate, 'contractVersion', 'turn persistence adapter')
  if (contractVersion !== TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_VERSION_UNSUPPORTED',
      `turn persistence adapter ${id} requires contractVersion ${TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION}`,
    )
  }
  const atomicAttachmentRuntimePortIds = snapshotAtomicAttachmentRuntimePortIds(candidate)
  const session = snapshotFunctionSection(candidate, 'session', SESSION_FUNCTIONS)
  const eventLogFunctions = snapshotFunctionSection(
    candidate,
    'eventLog',
    EVENT_LOG_FUNCTIONS,
    OPTIONAL_EVENT_LOG_FUNCTIONS,
  )
  const transactions = snapshotFunctionSection(
    candidate,
    'transactions',
    TRANSACTION_FUNCTIONS,
    OPTIONAL_TRANSACTION_FUNCTIONS,
  )
  const execution = snapshotFunctionSection(candidate, 'execution', EXECUTION_FUNCTIONS)
  const steering = snapshotFunctionSection(candidate, 'steering', STEERING_FUNCTIONS)
  const recovery = snapshotFunctionSection(candidate, 'recovery', RECOVERY_FUNCTIONS)
  const modelRequestRecovery = snapshotFunctionSection(
    candidate,
    'modelRequestRecovery',
    MODEL_REQUEST_RECOVERY_FUNCTIONS,
  )
  const sessionAdmin = prepareSessionAdminPort(
    ownDataValue(candidate, 'sessionAdmin', 'turn persistence adapter'),
  )
  const prepared = Object.freeze({
    id,
    contractVersion,
    atomicAttachmentRuntimePortIds,
    session,
    eventLog: Object.freeze({
      ...eventLogFunctions,
      supportsAtomicCheckpointState: true,
    }),
    transactions,
    execution,
    steering,
    recovery,
    modelRequestRecovery,
    sessionAdmin,
  })
  preparedAdapters.add(prepared)
  preparedAdapterSnapshots.set(candidate, prepared)
  preparedAdapterSnapshots.set(prepared, prepared)
  return prepared
}

function activatePreparedAdapter(adapter, source) {
  if (!preparedAdapters.has(adapter)) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      'turn persistence adapter must be prepared before activation',
    )
  }
  if (activeBinding) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_ALREADY_ACTIVE',
      `turn persistence adapter ${activeBinding.adapter.id} is already active`,
    )
  }
  const binding = {
    adapter,
    source: String(source || 'host').trim().slice(0, 80) || 'host',
    engineLease: null,
  }
  activeBinding = binding
  emit('turn_persistence.configured', binding)
  return binding
}

/** Host lifecycle controller. This API is intentionally not exposed to runtime plugins. */
export function createTurnPersistenceAdapterController(input, {
  source = 'host.lifecycle',
} = {}) {
  const adapter = prepareTurnPersistenceAdapter(input)
  let binding = null
  return Object.freeze({
    adapterId: adapter.id,
    activate() {
      if (binding) return adapter
      binding = activatePreparedAdapter(adapter, source)
      return adapter
    },
    release() {
      if (!binding) return false
      if (activeBinding !== binding) {
        throw adapterError(
          'TURN_PERSISTENCE_BINDING_STALE',
          `turn persistence adapter binding ${adapter.id} is no longer authoritative`,
        )
      }
      if (binding.engineLease) {
        throw adapterError(
          'TURN_PERSISTENCE_ADAPTER_IN_USE',
          `turn persistence adapter ${adapter.id} cannot be released while TurnEngine is active`,
        )
      }
      emit('turn_persistence.released', binding)
      activeBinding = null
      binding = null
      return true
    },
  })
}

/** Acquire the immutable adapter snapshot used for one process TurnEngine singleton. */
export function acquireTurnPersistenceAdapterForEngine() {
  if (!activeBinding) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      'turn persistence adapter must be activated before TurnEngine is created',
    )
  }
  const binding = activeBinding
  if (binding.engineLease) {
    throw adapterError(
      'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
      `turn persistence adapter ${binding.adapter.id} is already bound to a TurnEngine`,
    )
  }
  const token = Object.freeze({})
  binding.engineLease = token
  emit('turn_persistence.engine_bound', binding)
  let released = false
  return Object.freeze({
    adapter: binding.adapter,
    release() {
      if (released) return false
      if (activeBinding !== binding || binding.engineLease !== token) {
        throw adapterError(
          'TURN_PERSISTENCE_ENGINE_LEASE_STALE',
          `turn persistence adapter engine lease ${binding.adapter.id} is no longer authoritative`,
        )
      }
      binding.engineLease = null
      released = true
      emit('turn_persistence.engine_released', binding)
      return true
    },
  })
}

export function getTurnPersistenceAdapterStatus() {
  if (!activeBinding) {
    return Object.freeze({
      configured: false,
      adapterId: null,
      contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
      engineBound: false,
      source: null,
    })
  }
  return Object.freeze({
    configured: true,
    adapterId: activeBinding.adapter.id,
    contractVersion: activeBinding.adapter.contractVersion,
    engineBound: activeBinding.engineLease !== null,
    source: activeBinding.source,
  })
}

/** Read-only host view used by recovery/realtime services after activation. */
export function getActiveTurnPersistenceAdapter() {
  return activeBinding?.adapter || null
}

/** Session management always follows the selected persistence backend. */
export function getSessionAdminPort() {
  if (!activeBinding) {
    throw adapterError(
      'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      'turn persistence adapter must be activated before SessionAdmin is used',
    )
  }
  return activeBinding.adapter.sessionAdmin
}

export function listTurnPersistenceAdapterAuditEvents() {
  return Object.freeze([...auditEvents])
}
