import {
  claimLocalChatSession,
  deleteMessage,
  getPreviousUserMessage,
  getSession,
  isSessionIdOccupied,
  listMessages,
  upsertMessage,
  upsertSession,
} from './sessionStore.js'
import {
  appendTurnEvent,
  appendTurnEvents,
  getLastTurnEvent,
  listTurnEvents,
  recordTurnEventWriteFailure,
  verifyTurnEventCommit,
} from './turnEventStore.js'
import { createEventWriteBehind } from './eventWriteBehind.js'
import { recordTurnEmergencyFailure } from './turnEmergencyFailureJournal.js'
import { createTurnExecutionLeaseCoordinator } from './turnExecutionLeaseRuntime.js'
import {
  clearTurnRecoveryState,
  getTurnRecoveryState,
  recordTurnRecoveryFailure,
} from './turnRecoveryStateStore.js'
import { createTurnRuntimeCore } from './runtimeCore.js'
import {
  acknowledgeAppliedTurnSteering,
  acknowledgeTurnSteering,
  claimTurnSteering,
  enqueueTurnSteering,
  releaseTurnSteeringLease,
  releaseTurnSteeringLeasesForTurn,
} from './turnSteeringStore.js'
import {
  getPendingModelRequestRecovery,
  readModelRequestRecoveryResolution,
  resolvePendingModelRequest,
} from './modelRequestRecoveryService.js'
import {
  rejectFlatPersistenceOptions,
  requireTurnEnginePersistenceBundle,
} from './turnEnginePersistenceBundle.js'

function portsFromBundle(bundle) {
  return {
    appendEvent: bundle.eventLog.appendTurnEvent,
    appendEventBatch: bundle.eventLog.appendTurnEvents,
    verifyEventCommit: bundle.eventLog.verifyTurnEventCommit,
    supportsAtomicCheckpointState: bundle.eventLog.supportsAtomicCheckpointState,
    recordEventWriteFailure: bundle.eventLog.recordTurnEventWriteFailure,
    lastEvent: bundle.eventLog.getLastTurnEvent,
    replayEvents: bundle.eventLog.listTurnEvents,
    readCheckpoint: bundle.eventLog.getTurnCheckpoint,
    writeCheckpoint: bundle.eventLog.saveTurnCheckpoint,
    clearCheckpoint: bundle.eventLog.deleteTurnCheckpoint,
    commitTurnStart: bundle.transactions.commitTurnStart,
    commitTurnCheckpoint: bundle.transactions.commitTurnCheckpoint,
    commitTurnBoundary: bundle.transactions.commitTurnBoundary,
    commitTurnFailedRetry: bundle.transactions.commitTurnFailedRetry || null,
    readSession: bundle.session.getSession,
    sessionIdOccupied: bundle.session.isSessionIdOccupied,
    claimSession: bundle.session.claimLocalChatSession,
    writeSession: bundle.session.upsertSession,
    readMessages: bundle.session.listMessages,
    readPreviousUserMessage: bundle.session.getPreviousUserMessage,
    writeMessage: bundle.session.upsertMessage,
    removeMessage: bundle.session.deleteMessage,
    executionLeases: bundle.executionLeases,
    runtimeCore: bundle.runtimeCore,
    enqueueSteering: bundle.steering.enqueueTurnSteering,
    claimSteering: bundle.steering.claimTurnSteering,
    acknowledgeSteering: bundle.steering.acknowledgeTurnSteering,
    acknowledgeAppliedSteering: bundle.steering.acknowledgeAppliedTurnSteering,
    releaseSteering: bundle.steering.releaseTurnSteeringLease,
    releaseStaleSteering: bundle.steering.releaseTurnSteeringLeasesForTurn,
    readRecoveryState: bundle.recovery.getTurnRecoveryState,
    writeRecoveryFailure: bundle.recovery.recordTurnRecoveryFailure,
    clearRecoveryState: bundle.recovery.clearTurnRecoveryState,
    readPendingModelRequest: bundle.modelRequestRecovery.getPendingModelRequestRecovery,
    readModelRequestResolution: bundle.modelRequestRecovery.readModelRequestRecoveryResolution,
    commitPendingModelRequest: bundle.modelRequestRecovery.resolvePendingModelRequest,
  }
}

function createRuntimeCore(ports) {
  if (ports.runtimeCore) return ports.runtimeCore
  const options = { executionLeases: ports.executionLeases }
  if (typeof ports.readCheckpoint === 'function') options.readCheckpoint = ports.readCheckpoint
  if (typeof ports.writeCheckpoint === 'function') options.writeCheckpoint = ports.writeCheckpoint
  if (typeof ports.clearCheckpoint === 'function') options.clearCheckpoint = ports.clearCheckpoint
  return createTurnRuntimeCore(options)
}

function createWriterFactory({
  ports,
  eventWriteBehind,
  eventWriteBehindFactory,
  recordEmergencyFailure,
}) {
  if (eventWriteBehind !== null && eventWriteBehind !== undefined) {
    const error = new TypeError(
      'eventWriteBehind instances cannot be shared across Turns; provide eventWriteBehindFactory',
    )
    error.code = 'TURN_EVENT_WRITER_INSTANCE_UNSUPPORTED'
    error.retryable = false
    throw error
  }
  if (typeof eventWriteBehindFactory === 'function') {
    const issuedWriters = new WeakSet()
    return () => {
      const writer = eventWriteBehindFactory()
      if ((typeof writer === 'object' && writer !== null) || typeof writer === 'function') {
        if (issuedWriters.has(writer)) {
          const error = new Error('eventWriteBehindFactory must return a fresh writer for every Turn')
          error.code = 'TURN_EVENT_WRITER_REUSED'
          error.retryable = false
          throw error
        }
        issuedWriters.add(writer)
      }
      return writer
    }
  }
  const batchAppender = typeof ports.appendEventBatch === 'function'
    ? ports.appendEventBatch
    : ports.appendEvent === appendTurnEvent ? appendTurnEvents : null
  if (!batchAppender) {
    const error = new TypeError(
      'custom Turn event persistence requires an atomic appendEventBatch implementation',
    )
    error.code = 'TURN_EVENT_BATCH_APPENDER_REQUIRED'
    error.retryable = false
    throw error
  }
  return () => createEventWriteBehind({
    writeBatch: batchAppender,
    writeBatchSync: batchAppender === appendTurnEvents ? appendTurnEvents : null,
    recordFailure: ports.recordEventWriteFailure,
    recordEmergencyFailure,
  })
}

export function assembleTurnEnginePersistence(options = {}) {
  const {
    persistence = null,
    appendEvent = appendTurnEvent,
    appendEventBatch = null,
    verifyEventCommit = verifyTurnEventCommit,
    supportsAtomicCheckpointState = appendEvent === appendTurnEvent,
    eventWriteBehind = null,
    eventWriteBehindFactory = null,
    readPendingModelRequest = getPendingModelRequestRecovery,
    readModelRequestResolution = readModelRequestRecoveryResolution,
    commitPendingModelRequest = resolvePendingModelRequest,
    recordEventWriteFailure = recordTurnEventWriteFailure,
    recordEmergencyFailure = recordTurnEmergencyFailure,
    lastEvent = getLastTurnEvent,
    replayEvents = listTurnEvents,
    readCheckpoint = null,
    writeCheckpoint = null,
    clearCheckpoint = null,
    commitTurnStart = null,
    commitTurnCheckpoint = null,
    commitTurnBoundary = null,
    commitTurnFailedRetry = null,
    readSession = getSession,
    sessionIdOccupied = isSessionIdOccupied,
    claimSession = claimLocalChatSession,
    writeSession = upsertSession,
    readMessages = listMessages,
    readPreviousUserMessage = getPreviousUserMessage,
    writeMessage = upsertMessage,
    removeMessage = deleteMessage,
    executionLeases = null,
    readRecoveryState = getTurnRecoveryState,
    writeRecoveryFailure = recordTurnRecoveryFailure,
    clearRecoveryState = clearTurnRecoveryState,
    runtimeCore = null,
    enqueueSteering = enqueueTurnSteering,
    claimSteering = claimTurnSteering,
    acknowledgeSteering = acknowledgeTurnSteering,
    acknowledgeAppliedSteering = acknowledgeAppliedTurnSteering,
    releaseSteering = releaseTurnSteeringLease,
    releaseStaleSteering = releaseTurnSteeringLeasesForTurn,
  } = options
  const persistenceBundle = persistence === null || persistence === undefined
    ? null
    : requireTurnEnginePersistenceBundle(persistence)
  if (persistenceBundle) rejectFlatPersistenceOptions(options)

  const ports = persistenceBundle
    ? portsFromBundle(persistenceBundle)
    : {
        appendEvent,
        appendEventBatch,
        verifyEventCommit,
        supportsAtomicCheckpointState,
        recordEventWriteFailure,
        lastEvent,
        replayEvents,
        readCheckpoint,
        writeCheckpoint,
        clearCheckpoint,
        commitTurnStart,
        commitTurnCheckpoint,
        commitTurnBoundary,
        commitTurnFailedRetry,
        readSession,
        sessionIdOccupied,
        claimSession,
        writeSession,
        readMessages,
        readPreviousUserMessage,
        writeMessage,
        removeMessage,
        executionLeases: executionLeases || createTurnExecutionLeaseCoordinator(),
        runtimeCore,
        enqueueSteering,
        claimSteering,
        acknowledgeSteering,
        acknowledgeAppliedSteering,
        releaseSteering,
        releaseStaleSteering,
        readRecoveryState,
        writeRecoveryFailure,
        clearRecoveryState,
        readPendingModelRequest,
        readModelRequestResolution,
        commitPendingModelRequest,
      }
  return {
    persistence: persistenceBundle,
    ports: {
      ...ports,
      runtimeCore: createRuntimeCore(ports),
      createEventWriteBehind: createWriterFactory({
        ports,
        eventWriteBehind,
        eventWriteBehindFactory,
        recordEmergencyFailure,
      }),
      recordEmergencyFailure,
      supportsAtomicCheckpointState: ports.supportsAtomicCheckpointState === true,
    },
  }
}
