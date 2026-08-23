import crypto from 'node:crypto'

import { getDb } from '../db.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'

const STAGING = 'staging'
const DATABASE_COMMITTED = 'database_committed'
const OPERATION_KIND = 'session_delete'
const LEASE_OWNER = crypto.randomUUID()
const LEASE_MS = 60 * 60 * 1000

function deletionError(code, message, statusCode = 409, cause = null, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readPendingOperation(db) {
  return db.prepare(`
    SELECT operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
           status, operation_kind, session_id, compaction_port_id,
           compaction_governance_version, compaction_digest,
           compaction_stage_token
    FROM user_data_clear_operations
    ORDER BY created_at ASC
    LIMIT 1
  `).get() || null
}

function assertSessionDeletionBinding(operation, port) {
  if (operation.operation_kind !== OPERATION_KIND
    || typeof operation.session_id !== 'string'
    || !operation.session_id.trim()) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_CONFLICT',
      'Another durable local-data operation must finish before this session can be deleted',
      409,
      null,
      { cleanupPending: true },
    )
  }
  const identity = [
    operation.compaction_port_id,
    operation.compaction_governance_version,
    operation.compaction_digest,
  ]
  if (identity.some((value) => value === null)) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_INVALID',
      'The pending session deletion has incomplete compaction recovery metadata',
      500,
      null,
      { cleanupPending: true },
    )
  }
  if (operation.compaction_port_id !== port.id
    || operation.compaction_governance_version !== port.governanceApiVersion) {
    throw deletionError(
      'SESSION_DELETE_COMPACTION_PORT_CHANGED',
      'The compaction archive provider changed while session deletion recovery was pending',
      409,
      null,
      { cleanupPending: true },
    )
  }
  return {
    stageToken: operation.compaction_stage_token,
    digest: operation.compaction_digest,
  }
}

function claimPendingOperation(db, operation, now) {
  const leaseExpiresAt = Number(operation.lease_expires_at)
  const foreignLiveLease = operation.lease_owner !== LEASE_OWNER
    && Number.isSafeInteger(leaseExpiresAt)
    && leaseExpiresAt > now
    && processIsAlive(operation.lease_pid)
  if (foreignLiveLease) {
    throw deletionError(
      'SESSION_DELETE_IN_PROGRESS',
      'Another local process is deleting session data',
      409,
    )
  }
  const claimed = db.prepare(`
    UPDATE user_data_clear_operations
    SET lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
    WHERE operation_id = ? AND lease_owner = ? AND lease_expires_at = ?
  `).run(
    LEASE_OWNER,
    process.pid,
    now + LEASE_MS,
    now,
    operation.operation_id,
    operation.lease_owner,
    operation.lease_expires_at,
  )
  if (claimed.changes !== 1) {
    throw deletionError(
      'SESSION_DELETE_IN_PROGRESS',
      'Another local process claimed session deletion recovery',
      409,
    )
  }
}

function deleteOperation(db, operation, status, port, binding) {
  const deleted = db.prepare(`
    DELETE FROM user_data_clear_operations
    WHERE operation_id = ? AND owner_id = ? AND operation_kind = ?
      AND session_id = ? AND status = ? AND lease_owner = ? AND lease_pid = ?
      AND compaction_port_id = ? AND compaction_governance_version = ?
      AND compaction_digest = ? AND compaction_stage_token IS ?
  `).run(
    operation.operation_id,
    operation.owner_id,
    OPERATION_KIND,
    operation.session_id,
    status,
    LEASE_OWNER,
    process.pid,
    port.id,
    port.governanceApiVersion,
    binding.digest,
    binding.stageToken,
  )
  if (deleted.changes !== 1) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_LOST',
      'The durable session deletion journal changed before it could be released',
      409,
      null,
      { cleanupPending: true },
    )
  }
}

function assertRecoveryDecision(result, operation, binding) {
  const databaseCommitted = operation.status === DATABASE_COMMITTED
  const expected = databaseCommitted ? 'committed' : 'rolled_back'
  const absentBeforeStage = result?.recovered === false
    && !databaseCommitted
    && binding.stageToken === null
    && result?.state === 'none'
    && result?.digest === null
    && result?.stageToken === null
  const matchingTerminalEvidence = result?.recovered === true
    && result?.state === expected
    && result?.digest === binding.digest
    && (binding.stageToken === null || result?.stageToken === binding.stageToken)
  if (!matchingTerminalEvidence && !absentBeforeStage) {
    throw deletionError(
      'SESSION_DELETE_RECOVERY_CONFLICT',
      'Compaction recovery evidence conflicts with the session deletion journal',
      500,
      null,
      { databaseCommitted, cleanupPending: true },
    )
  }
}

function recoverPendingWithPort({ db, port, now = Date.now() }) {
  const operation = readPendingOperation(db)
  if (!operation) return null
  const binding = assertSessionDeletionBinding(operation, port)
  if (![STAGING, DATABASE_COMMITTED].includes(operation.status)) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_INVALID',
      'The pending session deletion has an unknown recovery state',
      500,
      null,
      { cleanupPending: true },
    )
  }
  claimPendingOperation(db, operation, now)
  const databaseCommitted = operation.status === DATABASE_COMMITTED
  if (databaseCommitted && binding.stageToken === null) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_INVALID',
      'The committed session deletion has no durable compaction stage receipt',
      500,
      null,
      { databaseCommitted: true, cleanupPending: true },
    )
  }
  const recovered = port.recoverDeletion({
    userId: operation.owner_id,
    operationId: operation.operation_id,
    databaseCommitted,
    expectedDigest: binding.digest,
    expectedStageToken: binding.stageToken,
  })
  assertRecoveryDecision(recovered, operation, binding)
  deleteOperation(db, operation, operation.status, port, binding)
  return {
    operationId: operation.operation_id,
    userId: operation.owner_id,
    sessionId: operation.session_id,
    databaseCommitted,
  }
}

function insertOperation(db, {
  operationId,
  userId,
  sessionId,
  port,
  digest,
  now,
}) {
  const inserted = db.prepare(`
    INSERT INTO user_data_clear_operations
      (operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
       status, operation_kind, session_id, compaction_port_id,
       compaction_governance_version, compaction_digest,
       compaction_stage_token, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM user_data_clear_operations)
  `).run(
    operationId,
    userId,
    LEASE_OWNER,
    process.pid,
    now + LEASE_MS,
    STAGING,
    OPERATION_KIND,
    sessionId,
    port.id,
    port.governanceApiVersion,
    digest,
    now,
    now,
  )
  if (inserted.changes !== 1) {
    throw deletionError(
      'SESSION_DELETE_IN_PROGRESS',
      'Another recoverable local-data operation is already in progress',
      409,
    )
  }
}

function persistStageReceipt(db, operation, port, receipt, now = Date.now()) {
  const updated = db.prepare(`
    UPDATE user_data_clear_operations
    SET compaction_stage_token = ?, updated_at = ?
    WHERE operation_id = ? AND owner_id = ? AND operation_kind = ?
      AND session_id = ? AND status = ? AND lease_owner = ? AND lease_pid = ?
      AND compaction_port_id = ? AND compaction_governance_version = ?
      AND compaction_digest = ? AND compaction_stage_token IS NULL
  `).run(
    receipt.stageToken,
    now,
    operation.operationId,
    operation.userId,
    OPERATION_KIND,
    operation.sessionId,
    STAGING,
    LEASE_OWNER,
    process.pid,
    port.id,
    port.governanceApiVersion,
    receipt.digest,
  )
  if (updated.changes !== 1) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_LOST',
      'The compaction deletion receipt could not be persisted',
      500,
      null,
      { databaseCommitted: false, cleanupPending: true },
    )
  }
}

function markDatabaseCommitted(db, operation, port, receipt, now = Date.now()) {
  const marked = db.prepare(`
    UPDATE user_data_clear_operations
    SET status = ?, lease_expires_at = ?, updated_at = ?
    WHERE operation_id = ? AND owner_id = ? AND operation_kind = ?
      AND session_id = ? AND status = ? AND lease_owner = ? AND lease_pid = ?
      AND compaction_port_id = ? AND compaction_governance_version = ?
      AND compaction_digest = ? AND compaction_stage_token = ?
  `).run(
    DATABASE_COMMITTED,
    now + LEASE_MS,
    now,
    operation.operationId,
    operation.userId,
    OPERATION_KIND,
    operation.sessionId,
    STAGING,
    LEASE_OWNER,
    process.pid,
    port.id,
    port.governanceApiVersion,
    receipt.digest,
    receipt.stageToken,
  )
  if (marked.changes !== 1) {
    throw deletionError(
      'SESSION_DELETE_JOURNAL_LOST',
      'The session deletion journal could not be committed with its database rows',
      500,
      null,
      { databaseCommitted: false, cleanupPending: true },
    )
  }
}

function releaseLease(lease, operationError, { ignoreReleaseError = false } = {}) {
  try {
    lease.release()
  } catch (releaseError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, releaseError],
        'Session deletion failed and its compaction governance lease could not be released',
        { cause: releaseError },
      )
    }
    if (ignoreReleaseError) return releaseError
    throw releaseError
  }
  if (operationError) throw operationError
  return null
}

export function recoverPendingSessionDeletion({
  db = getDb(),
} = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  const lease = acquireGovernanceLease()
  let result = null
  let operationError = null
  try {
    result = recoverPendingWithPort({ db, port: lease.port })
  } catch (error) {
    operationError = error
  }
  releaseLease(lease, operationError, { ignoreReleaseError: result !== null })
  return result
}

export function runGovernedSessionDeletion({
  db = getDb(),
  userId,
  sessionId,
  validate,
  commitDatabaseDeletion,
  now = Date.now(),
} = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  if (!userId || !sessionId || typeof validate !== 'function'
    || typeof commitDatabaseDeletion !== 'function') {
    throw new TypeError('Governed session deletion requires identity and database callbacks')
  }
  const lease = acquireGovernanceLease()
  const port = lease.port
  const scope = { kind: 'session', sessionId }
  const operation = {
    operationId: crypto.randomUUID(),
    userId,
    sessionId,
  }
  let operationInserted = false
  let databaseCommitted = false
  let operationFinalized = false
  let receipt = null
  let journalBinding = null
  let result = null
  let operationError = null
  try {
    recoverPendingWithPort({ db, port, now })
    const initial = db.transaction(() => {
      const validated = validate()
      if (validated === null) return null
      const preview = port.previewDeletion({ userId, scope })
      insertOperation(db, {
        ...operation,
        port,
        digest: preview.digest,
        now,
      })
      return preview
    }).immediate()
    if (initial !== null) {
      operationInserted = true
      journalBinding = { digest: initial.digest, stageToken: null }
      const staged = port.stageDeletion({
        userId,
        scope,
        operationId: operation.operationId,
        expectedDigest: initial.digest,
      })
      receipt = {
        userId,
        operationId: operation.operationId,
        stageToken: staged.stageToken,
        digest: staged.digest,
      }
      persistStageReceipt(db, operation, port, receipt)
      journalBinding = { digest: receipt.digest, stageToken: receipt.stageToken }
      port.assertDeletionStable(receipt)
      result = db.transaction(() => {
        const validated = validate()
        if (validated === null) {
          throw deletionError(
            'SESSION_DELETE_CHANGED',
            'The session changed while its managed data was being staged',
            409,
            null,
            { databaseCommitted: false },
          )
        }
        port.assertDeletionStable(receipt)
        const committed = commitDatabaseDeletion(validated)
        markDatabaseCommitted(db, operation, port, receipt)
        return committed
      }).immediate()
      databaseCommitted = true
      port.commitDeletion(receipt)
      deleteOperation(db, {
        operation_id: operation.operationId,
        owner_id: userId,
        session_id: sessionId,
      }, DATABASE_COMMITTED, port, journalBinding)
      operationFinalized = true
    }
  } catch (error) {
    operationError = error
    if (operationInserted && !databaseCommitted) {
      try {
        const recovered = port.recoverDeletion({
          userId,
          operationId: operation.operationId,
          databaseCommitted: false,
          expectedDigest: journalBinding.digest,
          expectedStageToken: journalBinding.stageToken,
        })
        assertRecoveryDecision(recovered, { status: STAGING }, journalBinding)
        deleteOperation(db, {
          operation_id: operation.operationId,
          owner_id: userId,
          session_id: sessionId,
        }, STAGING, port, journalBinding)
      } catch (recoveryError) {
        operationError = deletionError(
          'SESSION_DELETE_RECOVERY_INCOMPLETE',
          'The failed session deletion could not restore staged compaction archives',
          500,
          new AggregateError([error, recoveryError]),
          { databaseCommitted: false, cleanupPending: true },
        )
      }
    } else if (databaseCommitted) {
      operationError.databaseCommitted = true
      operationError.cleanupPending = true
    }
  }
  releaseLease(lease, operationError, {
    ignoreReleaseError: operationFinalized && operationError === null,
  })
  return result
}
