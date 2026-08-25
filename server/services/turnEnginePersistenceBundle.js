import { createTurnExecutionLeaseCoordinator } from './turnExecutionLeaseRuntime.js'
import { createTurnRuntimeCore } from './runtimeCore.js'
import {
  SESSION_ADMIN_PORT_METHODS,
  SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS,
} from '../core/sessionAdminPort.js'

export const TURN_ENGINE_PERSISTENCE_BUNDLE_VERSION = 1
const SUPPORTED_TURN_PERSISTENCE_ADAPTER_VERSION = 6

export const TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS = Object.freeze([
  'appendEvent',
  'appendEventBatch',
  'verifyEventCommit',
  'supportsAtomicCheckpointState',
  'recordEventWriteFailure',
  'lastEvent',
  'replayEvents',
  'readCheckpoint',
  'writeCheckpoint',
  'clearCheckpoint',
  'commitTurnStart',
  'commitTurnCheckpoint',
  'commitTurnBoundary',
  'commitTurnFailedRetry',
  'commitTurnFailedRetryRejection',
  'readSession',
  'sessionIdOccupied',
  'claimSession',
  'writeSession',
  'readMessages',
  'readPreviousUserMessage',
  'writeMessage',
  'removeMessage',
  'bindAttachments',
  'executionLeases',
  'runtimeCore',
  'enqueueSteering',
  'claimSteering',
  'acknowledgeSteering',
  'acknowledgeAppliedSteering',
  'releaseSteering',
  'releaseStaleSteering',
  'readRecoveryState',
  'writeRecoveryFailure',
  'clearRecoveryState',
  'readPendingModelRequest',
  'readModelRequestResolution',
  'commitPendingModelRequest',
])

const SECTION_FUNCTIONS = Object.freeze({
  session: Object.freeze([
    'getSession',
    'isSessionIdOccupied',
    'claimLocalChatSession',
    'upsertSession',
    'listMessages',
    'getPreviousUserMessage',
    'upsertMessage',
    'deleteMessage',
  ]),
  eventLog: Object.freeze([
    'appendTurnEvent',
    'appendTurnEvents',
    'getLastTurnEvent',
    'listTurnEvents',
    'recordTurnEventWriteFailure',
    'verifyTurnEventCommit',
    'getTurnCheckpoint',
    'saveTurnCheckpoint',
    'deleteTurnCheckpoint',
  ]),
  transactions: Object.freeze([
    'commitTurnStart',
    'commitTurnCheckpoint',
    'commitTurnBoundary',
  ]),
  execution: Object.freeze([
    'claimTurnExecutionLease',
    'getTurnExecutionLease',
    'renewTurnExecutionLease',
    'releaseTurnExecutionLease',
    'isTurnExecutionLeaseActive',
    'hasActiveTurnExecutionLeaseForSession',
    'requestTurnExecutionCancellation',
    'tryCloseTurnSteeringInbox',
    'listUnfinishedTurnExecutions',
  ]),
  steering: Object.freeze([
    'enqueueTurnSteering',
    'listTurnSteering',
    'claimTurnSteering',
    'acknowledgeTurnSteering',
    'acknowledgeAppliedTurnSteering',
    'releaseTurnSteeringLease',
    'releaseTurnSteeringLeasesForTurn',
  ]),
  recovery: Object.freeze([
    'getTurnRecoveryState',
    'recordTurnRecoveryFailure',
    'clearTurnRecoveryState',
    'listTurnRecoveryStates',
    'pruneResolvedTurnRecoveryStates',
  ]),
  modelRequestRecovery: Object.freeze([
    'getPendingModelRequestRecovery',
    'readModelRequestRecoveryResolution',
    'resolvePendingModelRequest',
  ]),
})

const preparedBundles = new WeakSet()

function persistenceBundleError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function attachmentAtomicDomainError(adapterId, runtimeId) {
  const error = new Error(
    `turn persistence adapter ${adapterId} cannot atomically bind managed attachment runtime ${runtimeId || 'unconfigured'}`,
  )
  error.code = 'TURN_ATTACHMENT_ATOMIC_DOMAIN_MISMATCH'
  error.statusCode = 503
  error.retryable = false
  return error
}

function snapshotSection(adapter, name) {
  const source = adapter?.[name]
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      `turn persistence adapter ${name} section is required`,
    )
  }
  const snapshot = {}
  for (const method of SECTION_FUNCTIONS[name]) {
    if (typeof source[method] !== 'function') {
      throw persistenceBundleError(
        'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
        `turn persistence adapter ${name}.${method} is required`,
      )
    }
    snapshot[method] = source[method]
  }
  return Object.freeze(snapshot)
}

function optionalSectionFunction(adapter, sectionName, methodName) {
  const section = adapter?.[sectionName]
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null
  const descriptor = Object.getOwnPropertyDescriptor(section, methodName)
  if (!descriptor) return null
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      `turn persistence adapter ${sectionName}.${methodName} must be an own function when provided`,
    )
  }
  return descriptor.value
}

function validateSessionAdmin(adapter) {
  const sessionAdmin = adapter?.sessionAdmin
  if (!sessionAdmin
    || typeof sessionAdmin !== 'object'
    || Array.isArray(sessionAdmin)
    || !SESSION_ADMIN_PORT_SUPPORTED_CONTRACT_VERSIONS.includes(sessionAdmin.contractVersion)) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      'turn persistence adapter sessionAdmin contract is required',
    )
  }
  for (const method of SESSION_ADMIN_PORT_METHODS) {
    if (typeof sessionAdmin[method] !== 'function') {
      throw persistenceBundleError(
        'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
        `turn persistence adapter sessionAdmin.${method} is required`,
      )
    }
  }
}

export function createTurnEnginePersistenceBundle(adapter, {
  leaseMs,
  renewalTimeoutMs,
  attachmentRuntime = null,
} = {}) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      'a complete turn persistence adapter is required',
    )
  }
  const adapterId = String(adapter.id || '').trim()
  if (!adapterId || adapter.contractVersion !== SUPPORTED_TURN_PERSISTENCE_ADAPTER_VERSION) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      `turn persistence adapter contractVersion ${SUPPORTED_TURN_PERSISTENCE_ADAPTER_VERSION} is required`,
    )
  }

  const session = snapshotSection(adapter, 'session')
  const eventLog = Object.freeze({
    ...snapshotSection(adapter, 'eventLog'),
    supportsAtomicCheckpointState: adapter.eventLog.supportsAtomicCheckpointState === true,
  })
  if (!eventLog.supportsAtomicCheckpointState) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      'turn persistence adapter must support atomic checkpoint state',
    )
  }
  const baseTransactions = snapshotSection(adapter, 'transactions')
  const atomicAttachmentRuntimePortIds = Array.isArray(adapter.atomicAttachmentRuntimePortIds)
    ? Object.freeze([...adapter.atomicAttachmentRuntimePortIds])
    : Object.freeze([])
  const attachmentRuntimeId = String(attachmentRuntime?.id || '').trim()
  const attachmentRuntimeAvailable = typeof attachmentRuntime?.bindAttachments === 'function'
  const commitTurnStart = (input = {}) => {
    if (input?.attachmentBinding) {
      if (!attachmentRuntimeAvailable
        || !atomicAttachmentRuntimePortIds.includes(attachmentRuntimeId)) {
        throw attachmentAtomicDomainError(adapterId, attachmentRuntimeId)
      }
      return baseTransactions.commitTurnStart({
        ...input,
        attachmentBindingAuthorized: true,
      })
    }
    return baseTransactions.commitTurnStart(input)
  }
  const commitTurnFailedRetry = optionalSectionFunction(
    adapter,
    'transactions',
    'commitTurnFailedRetry',
  )
  const commitTurnFailedRetryRejection = optionalSectionFunction(
    adapter,
    'transactions',
    'commitTurnFailedRetryRejection',
  )
  const transactions = Object.freeze({
    ...baseTransactions,
    commitTurnStart,
    ...(commitTurnFailedRetry ? { commitTurnFailedRetry } : {}),
    ...(commitTurnFailedRetryRejection ? { commitTurnFailedRetryRejection } : {}),
  })
  const execution = snapshotSection(adapter, 'execution')
  const steering = snapshotSection(adapter, 'steering')
  const recovery = snapshotSection(adapter, 'recovery')
  const modelRequestRecovery = snapshotSection(adapter, 'modelRequestRecovery')
  validateSessionAdmin(adapter)
  const executionLeases = Object.freeze(createTurnExecutionLeaseCoordinator({
    leaseMs,
    renewalTimeoutMs,
    claimLease: execution.claimTurnExecutionLease,
    readLease: execution.getTurnExecutionLease,
    renewLease: execution.renewTurnExecutionLease,
    releaseLease: execution.releaseTurnExecutionLease,
    isLeaseActive: execution.isTurnExecutionLeaseActive,
    hasActiveSessionLease: execution.hasActiveTurnExecutionLeaseForSession,
    requestCancellation: execution.requestTurnExecutionCancellation,
    closeSteeringInbox: execution.tryCloseTurnSteeringInbox,
  }))
  const runtimeCore = createTurnRuntimeCore({
    executionLeases,
    readCheckpoint: eventLog.getTurnCheckpoint,
    writeCheckpoint: eventLog.saveTurnCheckpoint,
    clearCheckpoint: eventLog.deleteTurnCheckpoint,
  })
  const bundle = Object.freeze({
    version: TURN_ENGINE_PERSISTENCE_BUNDLE_VERSION,
    adapterId,
    adapterContractVersion: adapter.contractVersion,
    atomicAttachmentRuntimePortIds,
    session,
    eventLog,
    transactions,
    steering,
    recovery,
    modelRequestRecovery,
    executionLeases,
    runtimeCore,
  })
  preparedBundles.add(bundle)
  return bundle
}

export function requireTurnEnginePersistenceBundle(bundle) {
  if (!bundle
    || typeof bundle !== 'object'
    || Array.isArray(bundle)
    || bundle.version !== TURN_ENGINE_PERSISTENCE_BUNDLE_VERSION
    || !Object.isFrozen(bundle)
    || !preparedBundles.has(bundle)) {
    throw persistenceBundleError(
      'TURN_ENGINE_PERSISTENCE_BUNDLE_INVALID',
      'TurnEngine persistence must be a complete bundle created by the host',
    )
  }
  return bundle
}

export function rejectFlatPersistenceOptions(options) {
  const conflicts = TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS.filter((key) => Object.hasOwn(options, key))
  if (conflicts.length === 0) return
  throw persistenceBundleError(
    'TURN_ENGINE_PERSISTENCE_BUNDLE_CONFLICT',
    `TurnEngine persistence bundle cannot be mixed with flat options: ${conflicts.join(', ')}`,
  )
}
