import {
  claimLocalChatSession,
  deleteMessage,
  getPreviousUserMessage,
  getSession,
  isSessionIdOccupied,
  listMessages,
  upsertMessage,
  upsertSession,
} from '../services/sessionStore.js'
import {
  appendTurnEvent,
  appendTurnEvents,
  getLastTurnEvent,
  listTurnEvents,
  recordTurnEventWriteFailure,
  resolveTurnSession,
  verifyTurnEventCommit,
} from '../services/turnEventStore.js'
import {
  deleteTurnCheckpoint,
  getTurnCheckpoint,
  saveTurnCheckpoint,
} from '../services/turnCheckpointStore.js'
import { SQLITE_TURN_PERSISTENCE_TRANSACTIONS } from '../services/sqliteTurnPersistenceTransactions.js'
import {
  claimTurnExecutionLease,
  getTurnExecutionLease,
  hasActiveTurnExecutionLeaseForSession,
  isTurnExecutionLeaseActive,
  listUnfinishedTurnExecutions,
  releaseTurnExecutionLease,
  renewTurnExecutionLease,
  requestTurnExecutionCancellation,
  tryCloseTurnSteeringInbox,
} from '../services/turnExecutionLeaseStore.js'
import {
  acknowledgeAppliedTurnSteering,
  acknowledgeTurnSteering,
  claimTurnSteering,
  enqueueTurnSteering,
  listTurnSteering,
  releaseTurnSteeringLease,
  releaseTurnSteeringLeasesForTurn,
} from '../services/turnSteeringStore.js'
import {
  clearTurnRecoveryState,
  getTurnRecoveryState,
  listTurnRecoveryStates,
  pruneResolvedTurnRecoveryStates,
  recordTurnRecoveryFailure,
} from '../services/turnRecoveryStateStore.js'
import {
  getPendingModelRequestRecovery,
  readModelRequestRecoveryResolution,
  resolvePendingModelRequest,
} from '../services/modelRequestRecoveryService.js'
import { SQLITE_SESSION_ADMIN_PORT } from '../services/sqliteSessionAdminPort.js'
import { TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION } from '../core/turnPersistenceAdapter.js'

export const SQLITE_TURN_PERSISTENCE_ADAPTER_ID = 'builtin.sqlite'

export const SQLITE_TURN_PERSISTENCE_ADAPTER = Object.freeze({
  id: SQLITE_TURN_PERSISTENCE_ADAPTER_ID,
  contractVersion: TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
  // Only this built-in runtime shares the same SQLite transaction domain.
  atomicAttachmentRuntimePortIds: Object.freeze(['builtin.sqlite-file']),
  session: Object.freeze({
    getSession,
    isSessionIdOccupied,
    claimLocalChatSession,
    upsertSession,
    listMessages,
    getPreviousUserMessage,
    upsertMessage,
    deleteMessage,
  }),
  eventLog: Object.freeze({
    appendTurnEvent,
    appendTurnEvents,
    getLastTurnEvent,
    listTurnEvents,
    recordTurnEventWriteFailure,
    resolveTurnSession,
    verifyTurnEventCommit,
    getTurnCheckpoint,
    saveTurnCheckpoint,
    deleteTurnCheckpoint,
  }),
  transactions: SQLITE_TURN_PERSISTENCE_TRANSACTIONS,
  execution: Object.freeze({
    claimTurnExecutionLease,
    getTurnExecutionLease,
    renewTurnExecutionLease,
    releaseTurnExecutionLease,
    isTurnExecutionLeaseActive,
    hasActiveTurnExecutionLeaseForSession,
    requestTurnExecutionCancellation,
    tryCloseTurnSteeringInbox,
    listUnfinishedTurnExecutions,
  }),
  steering: Object.freeze({
    enqueueTurnSteering,
    listTurnSteering,
    claimTurnSteering,
    acknowledgeTurnSteering,
    acknowledgeAppliedTurnSteering,
    releaseTurnSteeringLease,
    releaseTurnSteeringLeasesForTurn,
  }),
  recovery: Object.freeze({
    getTurnRecoveryState,
    recordTurnRecoveryFailure,
    clearTurnRecoveryState,
    listTurnRecoveryStates,
    pruneResolvedTurnRecoveryStates,
  }),
  modelRequestRecovery: Object.freeze({
    getPendingModelRequestRecovery,
    readModelRequestRecoveryResolution,
    resolvePendingModelRequest,
  }),
  sessionAdmin: SQLITE_SESSION_ADMIN_PORT,
})
