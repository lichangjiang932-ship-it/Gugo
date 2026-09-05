import { rollbackManagedDeletionStage } from './userDataManagedFileCatalog.js'
import { recoverTurnEmergencyFailureUserClear } from './turnEmergencyFailureDataGovernance.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import {
  CLEAR_OPERATION_COMMITTED,
  CLEAR_OPERATION_LEASE_MS,
  CLEAR_OPERATION_LEASE_OWNER,
  CLEAR_OPERATION_STAGING,
  checkpointUserDataWal,
  clearOperationPaths,
  deleteClearOperation,
  isProcessAlive,
  renewClearOperationLease,
} from './userDataClearJournal.js'
import { cleanupCommittedClearOperation } from './userDataClearFilesystem.js'

function compactionJournalBinding(operation, compactionArchivePort) {
  if (operation.operation_kind !== 'user_clear' || operation.session_id !== null) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A non-user clear journal cannot be recovered as a full data clear',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  const identity = [
    operation.compaction_port_id,
    operation.compaction_governance_version,
    operation.compaction_digest,
  ]
  if (identity.every((value) => value === null)) {
    if (operation.compaction_stage_token !== null) {
      throw governanceError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A legacy data-clear journal contains an orphaned compaction stage token',
        500,
        null,
        { incomplete: true, cleanupPending: true },
      )
    }
    return null
  }
  if (identity.some((value) => value === null)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A data-clear journal contains an incomplete compaction port identity',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  if (operation.compaction_port_id !== compactionArchivePort.id
    || operation.compaction_governance_version !== compactionArchivePort.governanceApiVersion) {
    throw governanceError(
      'USER_DATA_CLEAR_COMPACTION_PORT_CHANGED',
      'The compaction archive provider changed while a recoverable data clear was pending',
      409,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  return {
    digest: operation.compaction_digest,
    stageToken: operation.compaction_stage_token,
  }
}

export function recoverCompactionArchiveDeletion({
  port,
  userId,
  operationId,
  binding,
  databaseCommitted,
}) {
  if (!binding) return null
  const result = port.recoverDeletion({
    userId,
    operationId,
    databaseCommitted,
    expectedDigest: binding.digest,
    expectedStageToken: binding.stageToken,
  })
  const expectedState = databaseCommitted ? 'committed' : 'rolled_back'
  const missingUnstagedOperation = result?.recovered === false
    && !databaseCommitted
    && binding.stageToken === null
    && result?.state === 'none'
    && result?.digest === null
    && result?.stageToken === null
  const matchingTerminalEvidence = result?.recovered === true
    && result?.state === expectedState
    && result?.digest === binding.digest
    && (binding.stageToken === null || result?.stageToken === binding.stageToken)
  if (!matchingTerminalEvidence && !missingUnstagedOperation) {
    throw governanceError(
      'USER_DATA_CLEAR_COMPACTION_RECOVERY_CONFLICT',
      'Compaction archive recovery evidence conflicts with the database clear journal',
      500,
      null,
      {
        incomplete: true,
        databaseCleared: databaseCommitted,
        cleanupPending: true,
      },
    )
  }
  return result
}

function recoverStagedClearOperation({
  operation,
  userId,
  compactionArchivePort,
  compactionBinding,
  paths,
  fileSystem,
  attachmentGovernancePort,
  env,
  cwd,
  tempDir,
  renewLease,
  db,
}) {
  try {
    renewLease()
    recoverCompactionArchiveDeletion({
      port: compactionArchivePort,
      userId,
      operationId: operation.operation_id,
      binding: compactionBinding,
      databaseCommitted: false,
    })
    renewLease()
    for (const [root, stagePath, domain] of [
      [paths.dataRoot, paths.dataStagePath, 'data'],
      [paths.artifactRoot, paths.artifactStagePath, 'artifacts'],
    ]) {
      rollbackManagedDeletionStage({
        root, stagePath, domain, operationId: operation.operation_id, userId, fileSystem,
      })
      renewLease()
    }
    attachmentGovernancePort.rollbackUserClear({ userId, operationId: operation.operation_id })
    renewLease()
    recoverTurnEmergencyFailureUserClear({
      operationId: operation.operation_id,
      committed: false,
      env,
      cwd,
      tempDir,
      fileSystem,
    })
    renewLease()
    deleteClearOperation(db, {
      operationId: operation.operation_id,
      userId,
      status: CLEAR_OPERATION_STAGING,
    })
    return { recovered: 'rolled_back', operationId: operation.operation_id }
  } catch (cause) {
    if (cause?.code?.startsWith('USER_DATA_')) throw cause
    throw governanceError(
      'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
      'A staged user-data clear could not be restored',
      500,
      cause,
      { incomplete: true, databaseCleared: false, cleanupPending: true },
    )
  }
}

function recoverCommittedClearOperation({
  operation,
  userId,
  compactionArchivePort,
  compactionBinding,
  paths,
  fileSystem,
  attachmentGovernancePort,
  env,
  cwd,
  tempDir,
  renewLease,
  db,
}) {
  try {
    renewLease()
    recoverCompactionArchiveDeletion({
      port: compactionArchivePort,
      userId,
      operationId: operation.operation_id,
      binding: compactionBinding,
      databaseCommitted: true,
    })
    renewLease()
    recoverTurnEmergencyFailureUserClear({
      operationId: operation.operation_id,
      committed: true,
      env,
      cwd,
      tempDir,
      fileSystem,
    })
    renewLease()
    cleanupCommittedClearOperation({
      paths,
      userId,
      operationId: operation.operation_id,
      fileSystem,
      attachmentGovernancePort,
      renewLease,
    })
    renewLease()
    checkpointUserDataWal(db)
    renewLease()
    deleteClearOperation(db, {
      operationId: operation.operation_id,
      userId,
      status: CLEAR_OPERATION_COMMITTED,
    })
    return { recovered: 'cleanup_completed', operationId: operation.operation_id }
  } catch (cause) {
    if (cause?.code?.startsWith('USER_DATA_')) {
      cause.databaseCleared = true
      cause.cleanupPending = true
      throw cause
    }
    throw governanceError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'Committed user data is no longer active, but physical file cleanup is still pending',
      500,
      cause,
      { incomplete: true, databaseCleared: true, cleanupPending: true },
    )
  }
}

export function recoverPendingClearOperation({
  db,
  userId,
  env,
  cwd,
  tempDir,
  fileSystem,
  compactionArchivePort,
  attachmentGovernancePort,
}) {
  const operation = db.prepare(`
    SELECT operation_id, owner_id, lease_owner, lease_pid, lease_expires_at, status,
           operation_kind, session_id, compaction_port_id,
           compaction_governance_version, compaction_digest, compaction_stage_token
    FROM user_data_clear_operations
    WHERE owner_id = ?
  `).get(userId)
  if (!operation) return null
  const compactionBinding = compactionJournalBinding(operation, compactionArchivePort)
  const now = Date.now()
  // Expiry is a crash-recovery hint, not permission to race a process that is
  // demonstrably still alive. Synchronous hashing/staging can legitimately run
  // longer than the nominal lease window and cannot service a timer heartbeat.
  const foreignLiveLease = operation.lease_owner !== CLEAR_OPERATION_LEASE_OWNER
    && isProcessAlive(operation.lease_pid)
  if (foreignLiveLease) {
    throw governanceError(
      'USER_DATA_CLEAR_IN_PROGRESS',
      'Another local process is clearing this user data',
      409,
    )
  }
  const claimed = db.prepare(`
    UPDATE user_data_clear_operations
    SET lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
    WHERE operation_id = ? AND lease_owner = ? AND lease_expires_at = ?
  `).run(
    CLEAR_OPERATION_LEASE_OWNER,
    process.pid,
    now + CLEAR_OPERATION_LEASE_MS,
    now,
    operation.operation_id,
    operation.lease_owner,
    operation.lease_expires_at,
  )
  if (claimed.changes !== 1) {
    throw governanceError(
      'USER_DATA_CLEAR_IN_PROGRESS',
      'Another local process claimed this user-data clear recovery',
      409,
    )
  }
  const renewLease = () => renewClearOperationLease(db, {
    operationId: operation.operation_id,
    userId,
    status: operation.status,
  })
  renewLease()
  const paths = clearOperationPaths({ userId, operationId: operation.operation_id, env })
  if (operation.status === CLEAR_OPERATION_STAGING) {
    return recoverStagedClearOperation({
      operation,
      userId,
      compactionArchivePort,
      compactionBinding,
      paths,
      fileSystem,
      attachmentGovernancePort,
      env,
      cwd,
      tempDir,
      renewLease,
      db,
    })
  }
  if (operation.status !== CLEAR_OPERATION_COMMITTED) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear recovery record has an unknown state',
      500,
      null,
      { incomplete: true, cleanupPending: true },
    )
  }
  return recoverCommittedClearOperation({
    operation,
    userId,
    compactionArchivePort,
    compactionBinding,
    paths,
    fileSystem,
    attachmentGovernancePort,
    env,
    cwd,
    tempDir,
    renewLease,
    db,
  })
}
