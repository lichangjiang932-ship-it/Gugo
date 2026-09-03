import fs from 'node:fs'
import path from 'node:path'

import { cleanupManagedDeletionStage } from './userDataManagedFileCatalog.js'
import {
  assertUserDataFileSnapshot,
  captureUserDataFileSnapshot,
} from './userDataFileSnapshot.js'
import { createUserDataGovernanceError as governanceError } from './userDataGovernanceError.js'
import {
  attachmentRoot,
  clearOperationPaths,
  clearStorageToken,
  fileSystemMethod,
  isInside,
  pathExists,
  removeTree,
} from './userDataClearJournal.js'

export function attachmentBucket(userId, env) {
  const root = path.resolve(attachmentRoot(env))
  const bucket = clearStorageToken(userId)
  return { root, path: path.join(root, bucket) }
}

export function captureAttachmentClearSnapshot({ userId, env, fileSystem = fs } = {}) {
  const bucket = attachmentBucket(userId, env)
  return captureUserDataFileSnapshot({
    root: bucket.root,
    selections: [{
      fullPath: bucket.path,
      type: 'directory',
      logicalPath: path.basename(bucket.path),
    }],
    namespace: 'attachments',
    fileSystem,
  })
}

export function stageAttachmentDeletion(
  userId,
  operationId,
  env,
  fileSystem = fs,
  expectedSnapshot = null,
) {
  const bucket = attachmentBucket(userId, env)
  const { attachmentStagePath: staged } = clearOperationPaths({ userId, operationId, env })
  const logicalPath = path.basename(bucket.path)
  const capture = (fullPath) => captureUserDataFileSnapshot({
    root: bucket.root,
    selections: [{ fullPath, type: 'directory', logicalPath }],
    namespace: 'attachments',
    fileSystem,
    code: 'USER_DATA_CLEAR_PREVIEW_CHANGED',
    message: 'Managed attachments changed after the impact preview',
  })
  if (pathExists(fileSystem, staged)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_CONFLICT',
      'The attachment clear staging path already exists',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  if (!pathExists(fileSystem, bucket.path)) {
    if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(bucket.path))
    return {
      cleanup: () => true,
      rollback: () => true,
      assertStable() {
        if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(bucket.path))
        return true
      },
    }
  }
  const activeSnapshot = capture(bucket.path)
  if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, activeSnapshot)
  const handle = {
    cleanup() {
      removeTree(fileSystem, staged)
      return true
    },
    rollback() {
      if (!pathExists(fileSystem, staged)) return true
      if (pathExists(fileSystem, bucket.path)) {
        throw governanceError(
          'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
          'The attachment bucket could not be restored because its destination exists',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      fileSystemMethod(fileSystem, 'renameSync')(staged, bucket.path)
      return true
    },
    assertStable() {
      if (pathExists(fileSystem, bucket.path)) {
        throw governanceError(
          'USER_DATA_CLEAR_PREVIEW_CHANGED',
          'Managed attachments changed while they were being staged',
          409,
          null,
          { incomplete: false, databaseCleared: false, cleanupPending: false },
        )
      }
      if (expectedSnapshot) assertUserDataFileSnapshot(expectedSnapshot, capture(staged))
      return true
    },
  }
  try {
    fileSystemMethod(fileSystem, 'renameSync')(bucket.path, staged)
    handle.assertStable()
    return handle
  } catch (cause) {
    let rollbackCause = null
    try { handle.rollback() } catch (error) { rollbackCause = error }
    if (rollbackCause) {
      throw governanceError(
        'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
        'Managed attachments could not be staged or fully restored; recovery evidence was retained',
        500,
        new AggregateError([cause, rollbackCause]),
        {
          incomplete: true,
          databaseCleared: false,
          cleanupPending: true,
          recoveryRequired: true,
        },
      )
    }
    throw cause
  }
}

export function assertSafeStagingDirectory(fileSystem, root, stagedPath) {
  if (!pathExists(fileSystem, stagedPath)) return false
  const stageStat = fileSystemMethod(fileSystem, 'lstatSync')(stagedPath)
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging path is not a safe directory',
      500,
      null,
      { incomplete: true },
    )
  }
  const realRoot = fileSystemMethod(fileSystem, 'realpathSync')(root)
  const realStage = fileSystemMethod(fileSystem, 'realpathSync')(stagedPath)
  if (!isInside(realRoot, realStage)) {
    throw governanceError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging path escaped its managed root',
      500,
      null,
      { incomplete: true },
    )
  }
  return true
}

export function rollbackRecoveredAttachmentStage(paths, fileSystem) {
  if (!assertSafeStagingDirectory(
    fileSystem,
    paths.attachmentRoot,
    paths.attachmentStagePath,
  )) return true
  if (pathExists(fileSystem, paths.attachmentActivePath)) {
    throw governanceError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'The staged attachment bucket conflicts with an active bucket',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  fileSystemMethod(fileSystem, 'renameSync')(
    paths.attachmentStagePath,
    paths.attachmentActivePath,
  )
  return true
}

export function cleanupRecoveredAttachmentStage(paths, fileSystem) {
  if (assertSafeStagingDirectory(fileSystem, paths.attachmentRoot, paths.attachmentStagePath)) {
    removeTree(fileSystem, paths.attachmentStagePath)
  }
  return true
}

export function cleanupCommittedClearOperation({
  paths,
  userId,
  operationId,
  fileSystem,
  attachmentGovernancePort,
  renewLease = () => true,
}) {
  renewLease()
  cleanupManagedDeletionStage({
    root: paths.artifactRoot,
    stagePath: paths.artifactStagePath,
    domain: 'artifacts',
    operationId,
    userId,
    fileSystem,
  })
  renewLease()
  cleanupManagedDeletionStage({
    root: paths.dataRoot,
    stagePath: paths.dataStagePath,
    domain: 'data',
    operationId,
    userId,
    fileSystem,
  })
  renewLease()
  attachmentGovernancePort.cleanupUserClear({ userId, operationId })
  renewLease()
}
