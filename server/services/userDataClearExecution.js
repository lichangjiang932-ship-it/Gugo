import crypto from 'node:crypto'
import fs from 'node:fs'

import { getDb } from '../db.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'
import {
  buildManagedUserFileCatalog,
  stageManagedDeletionDomain,
} from './userDataManagedFileCatalog.js'
import { stageTurnEmergencyFailureUserClear } from './turnEmergencyFailureDataGovernance.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import {
  collectDatabaseRows,
  quoteIdentifier,
  userOwnershipColumn,
} from './userDataRecordGraph.js'
import {
  assertArtifactDeletionStillExclusive,
  assertClearPreviewMatches,
  clearDatabaseImpact,
  consumeClearPreviewToken,
  prepareClearImpact,
} from './userDataClearPreview.js'
import {
  CLEAR_OPERATION_COMMITTED,
  CLEAR_OPERATION_LEASE_MS,
  CLEAR_OPERATION_LEASE_OWNER,
  CLEAR_OPERATION_STAGING,
  assertCollectedRowsDeleted,
  assertUserRuntimeIdle,
  checkpointUserDataWal,
  childFirstTableOrder,
  clearOperationPaths,
  deleteClearOperation,
  deleteCollectedRows,
  insertClearOperation,
  pathExists,
  persistCompactionStageReceipt,
  renewClearOperationLease,
} from './userDataClearJournal.js'
import { stageAttachmentDeletion } from './userDataClearFilesystem.js'
import {
  recoverCompactionArchiveDeletion,
  recoverPendingClearOperation,
} from './userDataClearRecovery.js'

export const USER_DATA_CLEAR_CONFIRMATION = 'DELETE ALL MY GUGO DATA'

const activeClears = new Set()

export function clearAuthoritativeUserData({
  userId,
  confirmation,
  previewToken,
  requirePreview = true,
  previewNow = Date.now(),
  db = getDb(),
  env = process.env,
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) throw governanceError('UNAUTHORIZED', 'User is required', 401)
  if (confirmation !== USER_DATA_CLEAR_CONFIRMATION) {
    throw governanceError(
      'USER_DATA_CLEAR_CONFIRMATION_REQUIRED',
      `Type exactly: ${USER_DATA_CLEAR_CONFIRMATION}`,
      400,
    )
  }
  if (activeClears.size > 0) {
    throw governanceError('USER_DATA_CLEAR_IN_PROGRESS', 'A data clear is already in progress', 409)
  }
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(safeUserId)) {
    throw governanceError('USER_DATA_USER_NOT_FOUND', 'User does not exist', 404)
  }
  const preview = requirePreview || previewToken
    ? consumeClearPreviewToken({ token: previewToken, userId: safeUserId, now: previewNow })
    : null
  const governanceLease = acquireGovernanceLease()
  const compactionArchivePort = governanceLease.port

  activeClears.add(safeUserId)
  let stagedAttachments = null
  let stagedArtifacts = null
  let stagedData = null
  let stagedEmergencyJournals = null
  let compactionStageReceipt = null
  let archiveDeletionPreview = null
  let operationId = null
  let databaseCommitted = false
  let terminalError = null
  let clearResult = null
  try {
    recoverPendingClearOperation({
      db,
      userId: safeUserId,
      env,
      cwd,
      tempDir,
      fileSystem,
      compactionArchivePort,
    })
    assertUserRuntimeIdle(db, safeUserId)
    archiveDeletionPreview = compactionArchivePort.previewDeletion({
      userId: safeUserId,
      scope: { kind: 'user' },
    })
    const pendingOperationId = crypto.randomUUID()
    insertClearOperation(db, {
      operationId: pendingOperationId,
      userId: safeUserId,
      compactionPortId: compactionArchivePort.id,
      compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
      compactionDigest: archiveDeletionPreview.digest,
      now: Date.now(),
    })
    operationId = pendingOperationId
    const renewStagingLease = () => renewClearOperationLease(db, {
      operationId,
      userId: safeUserId,
      status: CLEAR_OPERATION_STAGING,
    })
    const preparedImpact = preview
      ? prepareClearImpact({
          userId: safeUserId,
          db,
          env,
          cwd,
          tempDir,
          fileSystem,
          includeCompactionArchives: false,
        })
      : null
    if (preview) {
      assertClearPreviewMatches(preview, preparedImpact, {
        compactionArchivePort,
        archiveDeletionPreview,
      })
    }
    const { catalog, records } = preparedImpact || collectDatabaseRows(db, safeUserId)
    const ownedTables = catalog.filter((table) => userOwnershipColumn(table))
    const catalogByName = new Map(catalog.map((table) => [table.name, table]))
    const relatedWithoutOwner = Object.keys(records).filter((name) => (
      name !== 'users'
      && !userOwnershipColumn(catalogByName.get(name))
      && records[name].length > 0
    ))
    const unownedDeletionOrder = childFirstTableOrder(catalog, relatedWithoutOwner)
    // The durable operation row prevents another process from claiming pending
    // content while files are enumerated and staged. A claim that won just
    // before the barrier remains visible as a lease and aborts this clear.
    assertUserRuntimeIdle(db, safeUserId)
    renewStagingLease()
    let managed = preparedImpact?.managed || null
    try {
      managed ||= buildManagedUserFileCatalog({
        records,
        userId: safeUserId,
        db,
        catalogByName,
        env,
        purpose: 'clear',
        fileSystem,
        includeCompactionArchives: false,
      })
    } catch (error) {
      if (error?.code?.startsWith('USER_DATA_CLEAR_')) {
        error.incomplete = true
        error.databaseCleared = false
      }
      throw error
    }
    renewStagingLease()
    stagedEmergencyJournals = stageTurnEmergencyFailureUserClear({
      userId: safeUserId,
      operationId,
      env,
      cwd,
      tempDir,
      fileSystem,
    })
    renewStagingLease()
    const paths = clearOperationPaths({ userId: safeUserId, operationId, env })
    stagedAttachments = stageAttachmentDeletion(
      safeUserId,
      operationId,
      env,
      fileSystem,
      preparedImpact?.files?.domainSnapshots?.attachments || null,
    )
    renewStagingLease()
    stagedArtifacts = stageManagedDeletionDomain({
      root: managed.deletion.artifacts.root,
      stagePath: paths.artifactStagePath,
      domain: 'artifacts',
      entries: managed.deletion.artifacts.entries,
      operationId,
      userId: safeUserId,
      expectedSnapshot: preparedImpact?.files?.domainSnapshots?.artifacts || null,
      fileSystem,
    })
    renewStagingLease()
    stagedData = stageManagedDeletionDomain({
      root: managed.deletion.data.root,
      stagePath: paths.dataStagePath,
      domain: 'data',
      entries: managed.deletion.data.entries,
      operationId,
      userId: safeUserId,
      expectedSnapshot: preparedImpact?.files?.domainSnapshots?.data || null,
      fileSystem,
    })
    renewStagingLease()
    const compactionStageResult = compactionArchivePort.stageDeletion({
      userId: safeUserId,
      scope: { kind: 'user' },
      operationId,
      expectedDigest: archiveDeletionPreview.digest,
    })
    compactionStageReceipt = {
      userId: safeUserId,
      operationId,
      stageToken: compactionStageResult.stageToken,
      digest: compactionStageResult.digest,
    }
    persistCompactionStageReceipt(db, {
      operationId,
      userId: safeUserId,
      compactionPortId: compactionArchivePort.id,
      compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
      compactionDigest: compactionStageReceipt.digest,
      stageToken: compactionStageReceipt.stageToken,
    })
    renewStagingLease()
    stagedAttachments.assertStable()
    stagedArtifacts.assertStable()
    stagedData.assertStable()
    compactionArchivePort.assertDeletionStable(compactionStageReceipt)
    const deleted = db.transaction(() => {
      db.pragma('defer_foreign_keys = ON')
      renewStagingLease()
      assertUserRuntimeIdle(db, safeUserId)
      stagedAttachments.assertStable()
      stagedArtifacts.assertStable()
      stagedData.assertStable()
      compactionArchivePort.assertDeletionStable(compactionStageReceipt)
      if (preview) {
        assertClearPreviewMatches(preview, {
          database: clearDatabaseImpact(collectDatabaseRows(db, safeUserId).records),
        }, { databaseOnly: true })
      }
      // The artifact files have already moved to staging, but another owner
      // may have acquired a reference immediately before this IMMEDIATE
      // transaction. Recheck under SQLite's write lock before authorizing
      // either database deletion or later physical cleanup.
      assertArtifactDeletionStillExclusive({
        db,
        catalogByName,
        userId: safeUserId,
        entries: managed.deletion.artifacts.entries,
      })
      const counts = {}
      for (const name of unownedDeletionOrder) {
        const table = catalogByName.get(name)
        counts[name] = deleteCollectedRows(db, table, records[name])
      }
      for (const table of ownedTables.filter((entry) => entry.name !== 'sessions')) {
        const ownerColumn = userOwnershipColumn(table)
        counts[table.name] = db.prepare(
          `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(ownerColumn)} = ?`,
        ).run(safeUserId).changes
      }
      counts.sessions = db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
      `).run(safeUserId).changes
      for (const table of ownedTables) {
        const remaining = table.name === 'sessions'
          ? db.prepare(`
              SELECT COUNT(*) AS count FROM sessions
              WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
            `).get(safeUserId).count
          : db.prepare(`
              SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}
              WHERE ${quoteIdentifier(userOwnershipColumn(table))} = ?
            `).get(safeUserId).count
        if (remaining !== 0) {
          throw governanceError('USER_DATA_CLEAR_INCOMPLETE', `Could not clear ${table.name}`, 500)
        }
      }
      for (const name of unownedDeletionOrder) {
        assertCollectedRowsDeleted(db, catalogByName.get(name), records[name])
      }
      const resetAccount = db.prepare(`
        UPDATE users SET updated_at = ? WHERE id = ?
      `).run(Date.now(), safeUserId)
      if (resetAccount.changes !== 1) {
        throw governanceError(
          'USER_DATA_CLEAR_INCOMPLETE',
          'Could not reset retained account metadata',
          500,
        )
      }
      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
      if (foreignKeyViolations.length) {
        throw governanceError(
          'USER_DATA_CLEAR_INCOMPLETE',
          'Could not clear user data without violating relational ownership boundaries',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      const marked = db.prepare(`
        UPDATE user_data_clear_operations
        SET status = ?, lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
        WHERE operation_id = ? AND owner_id = ? AND status = ? AND lease_owner = ?
          AND operation_kind = 'user_clear' AND session_id IS NULL
          AND compaction_port_id = ?
          AND compaction_governance_version = ?
          AND compaction_digest = ?
          AND compaction_stage_token = ?
      `).run(
        CLEAR_OPERATION_COMMITTED,
        CLEAR_OPERATION_LEASE_OWNER,
        process.pid,
        Date.now() + CLEAR_OPERATION_LEASE_MS,
        Date.now(),
        operationId,
        safeUserId,
        CLEAR_OPERATION_STAGING,
        CLEAR_OPERATION_LEASE_OWNER,
        compactionArchivePort.id,
        compactionArchivePort.governanceApiVersion,
        compactionStageReceipt.digest,
        compactionStageReceipt.stageToken,
      )
      if (marked.changes !== 1) {
        throw governanceError(
          'USER_DATA_CLEAR_JOURNAL_INVALID',
          'The user-data clear journal could not be committed',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      return counts
    }).immediate()
    databaseCommitted = true
    const renewCommittedLease = () => renewClearOperationLease(db, {
      operationId,
      userId: safeUserId,
      status: CLEAR_OPERATION_COMMITTED,
    })
    let walCheckpoint
    try {
      renewCommittedLease()
      compactionArchivePort.commitDeletion(compactionStageReceipt)
      renewCommittedLease()
      stagedArtifacts.cleanup()
      renewCommittedLease()
      stagedData.cleanup()
      renewCommittedLease()
      stagedAttachments.cleanup()
      renewCommittedLease()
      stagedEmergencyJournals.cleanup()
      renewCommittedLease()
      walCheckpoint = checkpointUserDataWal(db)
      renewCommittedLease()
      deleteClearOperation(db, {
        operationId,
        userId: safeUserId,
        status: CLEAR_OPERATION_COMMITTED,
      })
    } catch (cause) {
      if (cause?.code?.startsWith('USER_DATA_')) {
        cause.incomplete = true
        cause.databaseCleared = true
        cause.cleanupPending = true
        throw cause
      }
      throw governanceError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'User data is no longer active, but physical file cleanup is still pending',
        500,
        cause,
        { incomplete: true, databaseCleared: true, cleanupPending: true },
      )
    }
    clearResult = {
      ok: true,
      deleted,
      accountPreserved: true,
      authenticationSessionsPreserved: true,
      retainedAccountFieldsReset: [],
      attachmentFilesRemoved: true,
      artifactFiles: managed.stats.artifactFiles,
      managedFiles: managed.stats.managedFiles,
      emergencyFailureJournals: stagedEmergencyJournals.stats,
      walCheckpoint,
    }
  } catch (error) {
    let failure = error
    if (!databaseCommitted) {
      const rollbackErrors = []
      if (operationId) {
        try {
          recoverCompactionArchiveDeletion({
            port: compactionArchivePort,
            userId: safeUserId,
            operationId,
            binding: {
              digest: archiveDeletionPreview.digest,
              stageToken: compactionStageReceipt?.stageToken || null,
            },
            databaseCommitted: false,
          })
        } catch (rollbackCause) {
          rollbackErrors.push(rollbackCause)
        }
      }
      for (const stage of [
        stagedData,
        stagedArtifacts,
        stagedAttachments,
        stagedEmergencyJournals,
      ]) {
        try { stage?.rollback() } catch (rollbackCause) { rollbackErrors.push(rollbackCause) }
      }
      let recoveryEvidence = !!error?.recoveryRequired
      if (operationId) {
        const paths = clearOperationPaths({ userId: safeUserId, operationId, env })
        recoveryEvidence ||= [
          paths.dataStagePath,
          paths.artifactStagePath,
          paths.attachmentStagePath,
        ].some((target) => pathExists(fileSystem, target))
        if (!rollbackErrors.length && !recoveryEvidence) {
          const released = deleteClearOperation(db, {
            operationId,
            userId: safeUserId,
            status: CLEAR_OPERATION_STAGING,
            required: false,
          })
          if (!released && error?.code !== 'USER_DATA_CLEAR_LEASE_LOST') recoveryEvidence = true
        }
      }
      if (rollbackErrors.length || recoveryEvidence) {
        failure = governanceError(
          'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
          'The failed user-data clear could not fully restore staged files; recovery evidence was retained',
          500,
          new AggregateError([error, ...rollbackErrors]),
          {
            incomplete: true,
            databaseCleared: false,
            cleanupPending: true,
            recoveryRequired: true,
          },
        )
      }
    }
    terminalError = failure
  } finally {
    activeClears.delete(safeUserId)
  }
  try {
    governanceLease.release()
  } catch (releaseError) {
    if (terminalError) {
      throw new AggregateError(
        [terminalError, releaseError],
        'User-data clear failed and its compaction governance lease could not be released',
        { cause: releaseError },
      )
    }
    throw releaseError
  }
  if (terminalError) throw terminalError
  return clearResult
}
