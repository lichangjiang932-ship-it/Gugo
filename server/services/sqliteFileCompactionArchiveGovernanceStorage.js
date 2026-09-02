import crypto from 'node:crypto'
import fs from 'node:fs'

import { compactionGovernanceError } from './sqliteFileCompactionArchiveGovernanceManifest.js'
import {
  SAFE_TERMINAL_RETENTION_MS,
  TERMINAL_STATES,
  assertDirectory,
  assertReceipt,
  assertTerminalStorage,
  conflict,
  ensureUserRoot,
  exists,
  journalSchemaAvailable,
  listGovernanceContexts,
  listUserManifests,
  method,
  readBoundJournal,
  readOperation,
  removeTerminalContext,
  resolvedFiles,
  storagePaths,
  syncDirectory,
  updateContext,
  verifyRegularFile,
  writeManifest,
} from './sqliteFileCompactionArchiveGovernanceStorageSupport.js'

export {
  compactionGovernanceError,
  compactionGovernancePayloadName,
} from './sqliteFileCompactionArchiveGovernanceManifest.js'
export function createSqliteFileCompactionArchiveGovernanceStorage({
  db,
  env = process.env,
  fileSystem = fs,
  now = Date.now,
  tokenFactory = crypto.randomUUID,
  terminalRetentionMs = SAFE_TERMINAL_RETENTION_MS,
} = {}) {
  if (!Number.isSafeInteger(terminalRetentionMs) || terminalRetentionMs < 0) {
    throw new TypeError('Compaction governance terminal retention must be a safe duration')
  }

  const sweepTerminalOperations = () => {
    if (!journalSchemaAvailable(db)) return { finalized: 0 }
    let finalized = 0
    for (const context of listGovernanceContexts({ env, fileSystem })) {
      if (context.manifest.scope.kind !== 'session'
        || !TERMINAL_STATES.has(context.manifest.state)) continue
      const receipt = context.manifest.terminalReceipt
      if (!receipt) continue
      if (readBoundJournal(db, context.manifest)) continue
      if (now() - receipt.completedAt < terminalRetentionMs) continue
      assertTerminalStorage(context, fileSystem)
      removeTerminalContext(context, fileSystem)
      finalized += 1
    }
    return { finalized }
  }

  sweepTerminalOperations()

  const nextStageToken = () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const value = String(tokenFactory()).trim()
      if (value) return value
    }
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_TOKEN_INVALID',
      'A compaction archive deletion stage token could not be created',
    )
  }

  const assertMutationAllowed = ({ userId, sessionId }, { excludeOperationId = null } = {}) => {
    for (const manifest of listUserManifests({ userId, env, fileSystem })) {
      if (manifest.operationId === excludeOperationId) continue
      if (conflict(manifest, { userId, sessionId })) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_DELETION_IN_PROGRESS',
          'Compaction archives cannot change while deletion is being staged',
        )
      }
    }
    return true
  }

  const save = (context, manifest) => {
    writeManifest(context.paths, manifest, fileSystem)
    context.manifest = manifest
    return context
  }

  const read = ({ userId, operationId }) => readOperation({
    userId,
    operationId,
    env,
    fileSystem,
  })

  const beginStage = ({ userId, scope, operationId, expectedDigest }) => {
    const current = read({ userId, operationId })
    if (current.manifest) return current
    assertMutationAllowed({ userId, sessionId: scope.sessionId })
    const paths = { ...storagePaths({ userId, operationId, env }), env }
    ensureUserRoot(paths, fileSystem)
    try {
      method(fileSystem, 'mkdirSync')(paths.operationRoot, { recursive: false, mode: 0o700 })
      assertDirectory(fileSystem, paths.root, paths.operationRoot)
      method(fileSystem, 'mkdirSync')(paths.payloadRoot, { recursive: false, mode: 0o700 })
      assertDirectory(fileSystem, paths.root, paths.payloadRoot)
    } catch (cause) {
      if (cause?.code === 'EEXIST') return read({ userId, operationId })
      throw cause
    }
    const context = {
      paths,
      manifest: {
        version: 1,
        userId,
        operationId,
        stageToken: nextStageToken(),
        scope,
        digest: expectedDigest,
        records: [],
        files: [],
        alreadyMissing: 0,
        totalBytes: 0,
        state: 'staging',
        createdAt: now(),
      },
    }
    writeManifest(paths, context.manifest, fileSystem, { create: true })
    try {
      assertMutationAllowed(
        { userId, sessionId: scope.sessionId },
        { excludeOperationId: operationId },
      )
    } catch (cause) {
      updateContext(context, 'rolled_back', fileSystem, now)
      throw cause
    }
    return context
  }

  const stageFiles = (context) => {
    const moved = []
    try {
      for (const entry of resolvedFiles(context, fileSystem)) {
        if (!exists(fileSystem, entry.source.fullPath)) {
          throw compactionGovernanceError(
            'COMPACTION_ARCHIVE_GOVERNANCE_PREVIEW_CHANGED',
            'A compaction archive disappeared while deletion was staged',
          )
        }
        verifyRegularFile(fileSystem, entry.source.fullPath, entry.file)
        if (exists(fileSystem, entry.stagedPath)) {
          throw compactionGovernanceError(
            'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
            'A compaction archive deletion payload already exists',
          )
        }
        method(fileSystem, 'renameSync')(entry.source.fullPath, entry.stagedPath)
        syncDirectory(fileSystem, entry.source.bucketPath)
        syncDirectory(fileSystem, context.paths.payloadRoot)
        moved.push(entry)
      }
      updateContext(context, 'staged', fileSystem, now)
      return context
    } catch (cause) {
      for (const entry of moved.reverse()) {
        if (exists(fileSystem, entry.stagedPath) && !exists(fileSystem, entry.source.fullPath)) {
          assertDirectory(fileSystem, context.paths.root, entry.source.bucketPath)
          method(fileSystem, 'renameSync')(entry.stagedPath, entry.source.fullPath)
          syncDirectory(fileSystem, entry.source.bucketPath)
          syncDirectory(fileSystem, context.paths.payloadRoot)
        }
      }
      updateContext(context, 'rolled_back', fileSystem, now)
      throw cause
    }
  }

  const assertFilesStaged = (context) => {
    if (context.manifest.state !== 'staged') {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'The compaction archive deletion stage is not stable',
      )
    }
    for (const entry of resolvedFiles(context, fileSystem)) {
      if (exists(fileSystem, entry.source.fullPath) || !exists(fileSystem, entry.stagedPath)) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
          'A staged compaction archive changed before commit',
        )
      }
      verifyRegularFile(fileSystem, entry.stagedPath, entry.file)
    }
    return true
  }

  const commitFiles = (context, input) => {
    assertReceipt(context, input)
    if (context.manifest.state === 'committed') return context
    if (context.manifest.state === 'rolled_back' || context.manifest.state === 'rolling_back') {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'A rolled-back compaction archive deletion cannot be committed',
      )
    }
    const entries = resolvedFiles(context, fileSystem)
    if (context.manifest.state === 'staged') assertFilesStaged(context)
    if (!['staged', 'committing'].includes(context.manifest.state)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'The compaction archive deletion cannot be committed from its current state',
      )
    }
    updateContext(context, 'committing', fileSystem, now)
    for (const entry of entries) {
      if (exists(fileSystem, entry.source.fullPath)) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
          'A staged compaction archive unexpectedly reappeared',
        )
      }
      if (!exists(fileSystem, entry.stagedPath)) continue
      verifyRegularFile(fileSystem, entry.stagedPath, entry.file)
      method(fileSystem, 'unlinkSync')(entry.stagedPath)
    }
    syncDirectory(fileSystem, context.paths.payloadRoot)
    updateContext(context, 'committed', fileSystem, now)
    if (exists(fileSystem, context.paths.payloadRoot)
      && method(fileSystem, 'readdirSync')(context.paths.payloadRoot).length === 0) {
      method(fileSystem, 'rmdirSync')(context.paths.payloadRoot)
    }
    return context
  }

  const rollbackFiles = (context, input = null) => {
    if (input) assertReceipt(context, input)
    if (context.manifest.state === 'rolled_back') return context
    if (context.manifest.state === 'committed' || context.manifest.state === 'committing') {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'A committed compaction archive deletion cannot be rolled back',
      )
    }
    if (!['staging', 'staged', 'rolling_back'].includes(context.manifest.state)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'The compaction archive deletion cannot be rolled back from its current state',
      )
    }
    const entries = resolvedFiles(context, fileSystem)
    updateContext(context, 'rolling_back', fileSystem, now)
    for (const entry of entries.reverse()) {
      const sourceExists = exists(fileSystem, entry.source.fullPath)
      const stagedExists = exists(fileSystem, entry.stagedPath)
      if (sourceExists && stagedExists) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_ROLLBACK_CONFLICT',
          'A compaction archive exists in both staged and managed storage',
        )
      }
      if (!sourceExists && !stagedExists) {
        throw compactionGovernanceError(
          'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
          'A compaction archive disappeared during rollback',
        )
      }
      if (sourceExists) {
        verifyRegularFile(fileSystem, entry.source.fullPath, entry.file)
        continue
      }
      verifyRegularFile(fileSystem, entry.stagedPath, entry.file)
      assertDirectory(fileSystem, context.paths.root, entry.source.bucketPath)
      method(fileSystem, 'renameSync')(entry.stagedPath, entry.source.fullPath)
      syncDirectory(fileSystem, entry.source.bucketPath)
    }
    updateContext(context, 'rolled_back', fileSystem, now)
    if (exists(fileSystem, context.paths.payloadRoot)
      && method(fileSystem, 'readdirSync')(context.paths.payloadRoot).length === 0) {
      method(fileSystem, 'rmdirSync')(context.paths.payloadRoot)
    }
    return context
  }

  return Object.freeze({
    assertMutationAllowed,
    assertFilesStaged,
    beginStage,
    commitFiles,
    read,
    rollbackFiles,
    save,
    stageFiles,
    sweepTerminalOperations,
  })
}
