import crypto from 'node:crypto'
import fs from 'node:fs'

import { getDb } from '../db.js'
import { settleDeletedUserAgentEventRetriesInTransaction } from './agentEventSubscriptionStore.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'
import { buildManagedUserFileCatalog, stageManagedDeletionDomain } from './userDataManagedFileCatalog.js'
import { stageTurnEmergencyFailureUserClear } from './turnEmergencyFailureDataGovernance.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import { collectDatabaseRows, quoteIdentifier, userOwnershipColumn } from './userDataRecordGraph.js'
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
import { recoverCompactionArchiveDeletion, recoverPendingClearOperation } from './userDataClearRecovery.js'

export const USER_DATA_CLEAR_CONFIRMATION = 'DELETE ALL MY GUGO DATA'
const activeClears = new Set()

function prepareClearRuntime(options, dependencies) {
  const safeUserId = String(options.userId || '').trim()
  if (!safeUserId) throw governanceError('UNAUTHORIZED', 'User is required', 401)
  if (options.confirmation !== USER_DATA_CLEAR_CONFIRMATION) {
    throw governanceError(
      'USER_DATA_CLEAR_CONFIRMATION_REQUIRED',
      `Type exactly: ${USER_DATA_CLEAR_CONFIRMATION}`,
      400,
    )
  }
  if (activeClears.size > 0) {
    throw governanceError('USER_DATA_CLEAR_IN_PROGRESS', 'A data clear is already in progress', 409)
  }
  if (!options.db.prepare('SELECT 1 FROM users WHERE id = ?').get(safeUserId)) {
    throw governanceError('USER_DATA_USER_NOT_FOUND', 'User does not exist', 404)
  }
  const preview = options.requirePreview || options.previewToken
    ? consumeClearPreviewToken({
        token: options.previewToken, userId: safeUserId, now: options.previewNow,
      })
    : null
  const governanceLease = dependencies.acquireGovernanceLease()
  return {
    ...options,
    ...dependencies,
    safeUserId,
    preview,
    governanceLease,
    compactionArchivePort: governanceLease.port,
    stagedAttachments: null,
    stagedArtifacts: null,
    stagedData: null,
    stagedEmergencyJournals: null,
    compactionStageReceipt: null,
    archiveDeletionPreview: null,
    operationId: null,
    databaseCommitted: false,
  }
}

function renewClearLease(runtime, status = CLEAR_OPERATION_STAGING) {
  return renewClearOperationLease(runtime.db, {
    operationId: runtime.operationId,
    userId: runtime.safeUserId,
    status,
  })
}

function prepareClearCatalog(runtime) {
  const { db, safeUserId, env, cwd, tempDir, fileSystem, attachmentGovernancePort } = runtime
  const preparedImpact = runtime.preview
    ? prepareClearImpact({
        userId: safeUserId, db, env, cwd, tempDir, fileSystem,
        attachmentGovernancePort, includeCompactionArchives: false,
      })
    : null
  if (runtime.preview) {
    assertClearPreviewMatches(runtime.preview, preparedImpact, {
      compactionArchivePort: runtime.compactionArchivePort,
      archiveDeletionPreview: runtime.archiveDeletionPreview,
    })
  }
  const { catalog, records } = preparedImpact || collectDatabaseRows(db, safeUserId)
  const catalogByName = new Map(catalog.map((table) => [table.name, table]))
  const relatedWithoutOwner = Object.keys(records).filter((name) => (
    name !== 'users'
    && !userOwnershipColumn(catalogByName.get(name))
    && records[name].length > 0
  ))
  return {
    preparedImpact,
    catalog,
    records,
    catalogByName,
    ownedTables: catalog.filter((table) => userOwnershipColumn(table)),
    unownedDeletionOrder: childFirstTableOrder(catalog, relatedWithoutOwner),
    managed: preparedImpact?.managed || null,
  }
}

function stageUserDataClear(runtime) {
  const { db, safeUserId, env, cwd, tempDir, fileSystem,
    compactionArchivePort, attachmentGovernancePort } = runtime
  recoverPendingClearOperation({
    db, userId: safeUserId, env, cwd, tempDir, fileSystem,
    compactionArchivePort, attachmentGovernancePort,
  })
  assertUserRuntimeIdle(db, safeUserId)
  runtime.archiveDeletionPreview = compactionArchivePort.previewDeletion({
    userId: safeUserId, scope: { kind: 'user' },
  })
  const pendingOperationId = crypto.randomUUID()
  insertClearOperation(db, {
    operationId: pendingOperationId,
    userId: safeUserId,
    compactionPortId: compactionArchivePort.id,
    compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
    compactionDigest: runtime.archiveDeletionPreview.digest,
    now: Date.now(),
  })
  runtime.operationId = pendingOperationId
  const catalogState = prepareClearCatalog(runtime)
  assertUserRuntimeIdle(db, safeUserId)
  renewClearLease(runtime)
  try {
    catalogState.managed ||= buildManagedUserFileCatalog({
      records: catalogState.records,
      userId: safeUserId,
      db,
      catalogByName: catalogState.catalogByName,
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
  renewClearLease(runtime)
  const paths = clearOperationPaths({ userId: safeUserId, operationId: runtime.operationId, env })
  runtime.stagedEmergencyJournals = stageTurnEmergencyFailureUserClear({
    userId: safeUserId, operationId: runtime.operationId, env, cwd, tempDir, fileSystem,
  })
  renewClearLease(runtime)
  runtime.stagedAttachments = attachmentGovernancePort.stageUserClear({
    userId: safeUserId,
    operationId: runtime.operationId,
    expectedSnapshot: catalogState.preparedImpact?.files?.domainSnapshots?.attachments || null,
  })
  renewClearLease(runtime)
  runtime.stagedArtifacts = stageManagedDeletionDomain({
    root: catalogState.managed.deletion.artifacts.root,
    stagePath: paths.artifactStagePath,
    domain: 'artifacts',
    entries: catalogState.managed.deletion.artifacts.entries,
    operationId: runtime.operationId,
    userId: safeUserId,
    expectedSnapshot: catalogState.preparedImpact?.files?.domainSnapshots?.artifacts || null,
    fileSystem,
  })
  renewClearLease(runtime)
  runtime.stagedData = stageManagedDeletionDomain({
    root: catalogState.managed.deletion.data.root,
    stagePath: paths.dataStagePath,
    domain: 'data',
    entries: catalogState.managed.deletion.data.entries,
    operationId: runtime.operationId,
    userId: safeUserId,
    expectedSnapshot: catalogState.preparedImpact?.files?.domainSnapshots?.data || null,
    fileSystem,
  })
  renewClearLease(runtime)
  const result = compactionArchivePort.stageDeletion({
    userId: safeUserId,
    scope: { kind: 'user' },
    operationId: runtime.operationId,
    expectedDigest: runtime.archiveDeletionPreview.digest,
  })
  runtime.compactionStageReceipt = {
    userId: safeUserId,
    operationId: runtime.operationId,
    stageToken: result.stageToken,
    digest: result.digest,
  }
  persistCompactionStageReceipt(db, {
    operationId: runtime.operationId,
    userId: safeUserId,
    compactionPortId: compactionArchivePort.id,
    compactionGovernanceVersion: compactionArchivePort.governanceApiVersion,
    compactionDigest: result.digest,
    stageToken: result.stageToken,
  })
  renewClearLease(runtime)
  runtime.stagedAttachments.assertStable()
  runtime.stagedArtifacts.assertStable()
  runtime.stagedData.assertStable()
  compactionArchivePort.assertDeletionStable(runtime.compactionStageReceipt)
  return catalogState
}

function deleteUserRows(runtime, catalogState) {
  const { db, safeUserId, compactionArchivePort } = runtime
  const { catalogByName, records, ownedTables, unownedDeletionOrder, managed } = catalogState
  return db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    renewClearLease(runtime)
    assertUserRuntimeIdle(db, safeUserId)
    runtime.stagedAttachments.assertStable()
    runtime.stagedArtifacts.assertStable()
    runtime.stagedData.assertStable()
    compactionArchivePort.assertDeletionStable(runtime.compactionStageReceipt)
    if (runtime.preview) {
      assertClearPreviewMatches(runtime.preview, {
        database: clearDatabaseImpact(collectDatabaseRows(db, safeUserId).records),
      }, { databaseOnly: true })
    }
    assertArtifactDeletionStillExclusive({
      db, catalogByName, userId: safeUserId, entries: managed.deletion.artifacts.entries,
    })
    settleDeletedUserAgentEventRetriesInTransaction({ userId: safeUserId, now: Date.now(), db })
    const counts = {}
    for (const name of unownedDeletionOrder) {
      counts[name] = deleteCollectedRows(db, catalogByName.get(name), records[name])
    }
    for (const table of ownedTables.filter((entry) => entry.name !== 'sessions')) {
      const ownerColumn = userOwnershipColumn(table)
      counts[table.name] = db.prepare(
        `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(ownerColumn)} = ?`,
      ).run(safeUserId).changes
    }
    counts.sessions = db.prepare(`
      DELETE FROM sessions WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).run(safeUserId).changes
    for (const table of ownedTables) {
      const remaining = table.name === 'sessions'
        ? db.prepare(`SELECT COUNT(*) AS count FROM sessions
            WHERE user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)`).get(safeUserId).count
        : db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}
            WHERE ${quoteIdentifier(userOwnershipColumn(table))} = ?`).get(safeUserId).count
      if (remaining !== 0) {
        throw governanceError('USER_DATA_CLEAR_INCOMPLETE', `Could not clear ${table.name}`, 500)
      }
    }
    for (const name of unownedDeletionOrder) {
      assertCollectedRowsDeleted(db, catalogByName.get(name), records[name])
    }
    const reset = db.prepare('UPDATE users SET updated_at = ? WHERE id = ?')
      .run(Date.now(), safeUserId)
    if (reset.changes !== 1) {
      throw governanceError('USER_DATA_CLEAR_INCOMPLETE', 'Could not reset retained account metadata', 500)
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) {
      throw governanceError(
        'USER_DATA_CLEAR_INCOMPLETE',
        'Could not clear user data without violating relational ownership boundaries',
        500,
        null,
        { incomplete: true, databaseCleared: false },
      )
    }
    const marked = db.prepare(`UPDATE user_data_clear_operations
      SET status = ?, lease_owner = ?, lease_pid = ?, lease_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND owner_id = ? AND status = ? AND lease_owner = ?
        AND operation_kind = 'user_clear' AND session_id IS NULL
        AND compaction_port_id = ? AND compaction_governance_version = ?
        AND compaction_digest = ? AND compaction_stage_token = ?`).run(
      CLEAR_OPERATION_COMMITTED,
      CLEAR_OPERATION_LEASE_OWNER,
      process.pid,
      Date.now() + CLEAR_OPERATION_LEASE_MS,
      Date.now(),
      runtime.operationId,
      safeUserId,
      CLEAR_OPERATION_STAGING,
      CLEAR_OPERATION_LEASE_OWNER,
      compactionArchivePort.id,
      compactionArchivePort.governanceApiVersion,
      runtime.compactionStageReceipt.digest,
      runtime.compactionStageReceipt.stageToken,
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
}

function finalizeUserDataClear(runtime, catalogState, deleted) {
  try {
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    runtime.compactionArchivePort.commitDeletion(runtime.compactionStageReceipt)
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    runtime.stagedArtifacts.cleanup()
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    runtime.stagedData.cleanup()
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    runtime.stagedAttachments.cleanup()
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    runtime.stagedEmergencyJournals.cleanup()
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    const walCheckpoint = checkpointUserDataWal(runtime.db)
    renewClearLease(runtime, CLEAR_OPERATION_COMMITTED)
    deleteClearOperation(runtime.db, {
      operationId: runtime.operationId,
      userId: runtime.safeUserId,
      status: CLEAR_OPERATION_COMMITTED,
    })
    return {
      ok: true,
      deleted,
      accountPreserved: true,
      authenticationSessionsPreserved: true,
      retainedAccountFieldsReset: [],
      attachmentFilesRemoved: true,
      artifactFiles: catalogState.managed.stats.artifactFiles,
      managedFiles: catalogState.managed.stats.managedFiles,
      emergencyFailureJournals: runtime.stagedEmergencyJournals.stats,
      walCheckpoint,
    }
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
}

function rollbackUserDataClear(runtime, error) {
  const rollbackErrors = []
  if (runtime.operationId) {
    try {
      recoverCompactionArchiveDeletion({
        port: runtime.compactionArchivePort,
        userId: runtime.safeUserId,
        operationId: runtime.operationId,
        binding: {
          digest: runtime.archiveDeletionPreview.digest,
          stageToken: runtime.compactionStageReceipt?.stageToken || null,
        },
        databaseCommitted: false,
      })
    } catch (cause) { rollbackErrors.push(cause) }
  }
  for (const stage of [
    runtime.stagedData,
    runtime.stagedArtifacts,
    runtime.stagedAttachments,
    runtime.stagedEmergencyJournals,
  ]) {
    try { stage?.rollback() } catch (cause) { rollbackErrors.push(cause) }
  }
  let recoveryEvidence = !!error?.recoveryRequired
  if (runtime.operationId) {
    const paths = clearOperationPaths({
      userId: runtime.safeUserId, operationId: runtime.operationId, env: runtime.env,
    })
    recoveryEvidence ||= [paths.dataStagePath, paths.artifactStagePath, paths.attachmentStagePath]
      .some((target) => pathExists(runtime.fileSystem, target))
    if (!rollbackErrors.length && !recoveryEvidence) {
      const released = deleteClearOperation(runtime.db, {
        operationId: runtime.operationId,
        userId: runtime.safeUserId,
        status: CLEAR_OPERATION_STAGING,
        required: false,
      })
      if (!released && error?.code !== 'USER_DATA_CLEAR_LEASE_LOST') recoveryEvidence = true
    }
  }
  if (!rollbackErrors.length && !recoveryEvidence) return error
  return governanceError(
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

export function clearAuthoritativeUserData(options = {}, dependencies = {}) {
  const runtime = prepareClearRuntime({
    userId: options.userId,
    confirmation: options.confirmation,
    previewToken: options.previewToken,
    requirePreview: options.requirePreview === undefined ? true : options.requirePreview,
    previewNow: options.previewNow === undefined ? Date.now() : options.previewNow,
    db: options.db === undefined ? getDb() : options.db,
    env: options.env === undefined ? process.env : options.env,
    cwd: options.cwd === undefined ? process.cwd() : options.cwd,
    tempDir: options.tempDir,
    fileSystem: options.fileSystem === undefined ? fs : options.fileSystem,
  }, {
    acquireGovernanceLease: dependencies.acquireGovernanceLease
      || acquireCompactionArchiveGovernanceLease,
    attachmentGovernancePort: dependencies.attachmentGovernancePort,
  })
  activeClears.add(runtime.safeUserId)
  let terminalError = null
  let clearResult = null
  try {
    const catalogState = stageUserDataClear(runtime)
    const deleted = deleteUserRows(runtime, catalogState)
    runtime.databaseCommitted = true
    clearResult = finalizeUserDataClear(runtime, catalogState, deleted)
  } catch (error) {
    terminalError = runtime.databaseCommitted ? error : rollbackUserDataClear(runtime, error)
  } finally {
    activeClears.delete(runtime.safeUserId)
  }
  try {
    runtime.governanceLease.release()
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
