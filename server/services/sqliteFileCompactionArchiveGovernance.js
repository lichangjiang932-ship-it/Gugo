import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from '../db.js'
import {
  readCompactionArchiveBody,
  resolveCompactionArchiveStorage,
  resolveCompactionArchiveUserStorage,
} from './compactionArchiveStore.js'
import {
  compactionGovernanceError,
  compactionGovernancePayloadName,
  createSqliteFileCompactionArchiveGovernanceStorage,
} from './sqliteFileCompactionArchiveGovernanceStorage.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function fileSystemMethod(fileSystem, name) {
  const value = fileSystem?.[name] || fs[name]
  if (typeof value !== 'function') {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNAVAILABLE',
      `Filesystem operation ${name} is unavailable`,
    )
  }
  return value.bind(fileSystem?.[name] ? fileSystem : fs)
}

function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function scopePredicate(scope) {
  return scope.kind === 'session'
    ? { sql: 'user_id = ? AND session_id = ?', parameters: [scope.sessionId] }
    : { sql: 'user_id = ?', parameters: [] }
}

function rowsForScope(db, userId, scope) {
  const predicate = scopePredicate(scope)
  return db.prepare(`
    SELECT id, user_id, session_id, replaced_message_count,
           archived_messages_json, summary_text, created_at,
           storage_path, size_bytes, sha256
    FROM compaction_archive
    WHERE ${predicate.sql}
    ORDER BY id ASC
  `).all(userId, ...predicate.parameters)
}

function normalizedRecord(row, userId, env) {
  if (String(row.user_id) !== userId) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_IDENTITY_MISMATCH',
      'Compaction archive metadata crossed its owner boundary',
    )
  }
  const noPath = row.storage_path === null || row.storage_path === undefined
  const noSize = row.size_bytes === null || row.size_bytes === undefined
  const noDigest = row.sha256 === null || row.sha256 === undefined
  const record = {
    id: String(row.id),
    sessionId: String(row.session_id),
    storagePath: null,
    sizeBytes: null,
    sha256: null,
  }
  if (noPath && noSize && noDigest) return record
  if (noPath || noSize || noDigest) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_INVALID',
      'Compaction archive metadata is only partially file-backed',
    )
  }
  const sizeBytes = Number(row.size_bytes)
  const digest = String(row.sha256 || '').toLowerCase()
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !SHA256_PATTERN.test(digest)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_INVALID',
      'Compaction archive file metadata is invalid',
    )
  }
  const resolved = resolveCompactionArchiveStorage({
    userId,
    id: record.id,
    storagePath: String(row.storage_path),
    env,
  })
  return {
    ...record,
    storagePath: resolved.storagePath,
    sizeBytes,
    sha256: digest,
  }
}

function assertSafeOwnerBucket(owner, fileSystem) {
  for (const directory of [owner.root, owner.versionRoot, owner.bucketPath]) {
    const stat = fileSystemMethod(fileSystem, 'lstatSync')(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
        'The compaction archive owner bucket contains an unsafe directory',
      )
    }
  }
  const canonicalRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(owner.root))
  const canonicalBucket = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(owner.bucketPath))
  if (!isInside(canonicalRoot, canonicalBucket)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
      'The compaction archive owner bucket escaped managed storage',
    )
  }
}

function collectUserBucketOrphans({ userId, env, fileSystem, referencedStoragePaths }) {
  const owner = resolveCompactionArchiveUserStorage({ userId, env })
  if (!pathExists(fileSystem, owner.bucketPath)) return []
  assertSafeOwnerBucket(owner, fileSystem)
  const names = fileSystemMethod(fileSystem, 'readdirSync')(owner.bucketPath)
    .map((name) => String(name))
    .sort((left, right) => left.localeCompare(right))
  const files = []
  for (const name of names) {
    if (!name || path.basename(name) !== name || path.win32.basename(name) !== name) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
        'The compaction archive owner bucket contains an unsafe entry name',
      )
    }
    const storagePath = path.posix.join('v1', owner.bucket, name)
    if (referencedStoragePaths.has(storagePath)) continue
    const fullPath = path.resolve(owner.bucketPath, name)
    if (path.dirname(fullPath) !== path.resolve(owner.bucketPath)) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
        'A compaction archive orphan escaped its owner bucket',
      )
    }
    const stat = fileSystemMethod(fileSystem, 'lstatSync')(fullPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
        'The compaction archive owner bucket contains a non-regular entry',
      )
    }
    const bytes = fileSystemMethod(fileSystem, 'readFileSync')(fullPath)
    if (bytes.length !== stat.size) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_PREVIEW_CHANGED',
        'A compaction archive orphan changed during deletion preview',
      )
    }
    files.push({
      kind: 'orphan',
      storagePath,
      payloadName: compactionGovernancePayloadName({
        userId,
        id: 'orphan',
        storagePath,
      }),
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    })
  }
  return files
}

function assertUserBucketEmpty({ userId, env, fileSystem }) {
  const owner = resolveCompactionArchiveUserStorage({ userId, env })
  if (!pathExists(fileSystem, owner.bucketPath)) return true
  assertSafeOwnerBucket(owner, fileSystem)
  if (fileSystemMethod(fileSystem, 'readdirSync')(owner.bucketPath).length !== 0) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
      'A compaction archive appeared after user deletion was staged',
    )
  }
  return true
}

function collectDeletionState({ db, userId, scope, env, fileSystem }) {
  const rows = rowsForScope(db, userId, scope)
  const records = []
  const files = []
  let alreadyMissing = 0
  for (const row of rows) {
    const record = normalizedRecord(row, userId, env)
    records.push(record)
    if (record.storagePath === null) continue
    const resolved = resolveCompactionArchiveStorage({
      userId,
      id: record.id,
      storagePath: record.storagePath,
      env,
    })
    if (!pathExists(fileSystem, resolved.fullPath)) {
      alreadyMissing += 1
      continue
    }
    const body = readCompactionArchiveBody({ row, userId, env, fileSystem })
    files.push({
      id: record.id,
      storagePath: record.storagePath,
      payloadName: compactionGovernancePayloadName({
        userId,
        id: record.id,
        storagePath: record.storagePath,
      }),
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
    })
  }
  if (scope.kind === 'user') {
    const referencedStoragePaths = new Set(records
      .map((record) => record.storagePath)
      .filter((storagePath) => storagePath !== null))
    files.push(...collectUserBucketOrphans({
      userId,
      env,
      fileSystem,
      referencedStoragePaths,
    }))
  }
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0)
  if (!Number.isSafeInteger(totalBytes)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_INVALID',
      'Compaction archive deletion size exceeds safe accounting',
    )
  }
  const digest = sha256(JSON.stringify({ scope, records, files, alreadyMissing }))
  return {
    records,
    files,
    alreadyMissing,
    totalBytes,
    digest,
    fileCount: files.length,
  }
}

function sameScope(left, right) {
  return left?.kind === right?.kind
    && (left?.kind !== 'session' || left.sessionId === right.sessionId)
}

function assertReceipt(context, input) {
  if (!context.manifest
    || context.manifest.stageToken !== input.stageToken
    || context.manifest.digest !== input.digest) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
      'The compaction archive deletion stage is stale',
    )
  }
}

function stageOutput(manifest) {
  return {
    userId: manifest.userId,
    operationId: manifest.operationId,
    stageToken: manifest.stageToken,
    digest: manifest.digest,
    state: 'staged',
  }
}

function operationInput(manifest) {
  return {
    userId: manifest.userId,
    operationId: manifest.operationId,
    stageToken: manifest.stageToken,
    digest: manifest.digest,
  }
}

function commitOutput(manifest) {
  return {
    ...operationInput(manifest),
    state: 'committed',
    removedFiles: manifest.files.length,
    removedBytes: manifest.totalBytes,
    alreadyMissing: manifest.alreadyMissing,
  }
}

function rollbackOutput(manifest) {
  return {
    ...operationInput(manifest),
    state: 'rolled_back',
    restoredFiles: manifest.files.length,
    removedBytes: 0,
    alreadyMissing: manifest.alreadyMissing,
  }
}

function createArchiveExportSnapshot(runtime, { userId }) {
  const { db, env, fileSystem, nextToken, exportSnapshots } = runtime
  const entries = rowsForScope(db, userId, { kind: 'user' }).map((row) => {
    const body = readCompactionArchiveBody({ row, userId, env, fileSystem })
    return {
      descriptor: {
        id: String(row.id), userId, sessionId: String(row.session_id),
        contentToken: nextToken(), sizeBytes: body.sizeBytes, sha256: body.sha256,
      },
      bytes: Buffer.from(body.bytes),
    }
  })
  const snapshotToken = nextToken()
  exportSnapshots.set(snapshotToken, { userId, entries })
  return { userId, snapshotToken, entryCount: entries.length }
}

function readArchiveExportChunk(runtime, { userId, snapshotToken, contentToken, offset, maxBytes }) {
  const snapshot = runtime.requireSnapshot(userId, snapshotToken)
  const entry = snapshot.entries.find((candidate) => candidate.descriptor.contentToken === contentToken)
  if (!entry) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_EXPORT_CONTENT_NOT_FOUND',
      'The compaction archive export content is unavailable',
    )
  }
  const end = Math.min(entry.bytes.length, offset + maxBytes)
  const bytes = entry.bytes.subarray(offset, end)
  return {
    userId, snapshotToken, contentToken, dataBase64: bytes.toString('base64'),
    byteLength: bytes.length, nextOffset: offset + bytes.length,
    done: offset + bytes.length >= entry.bytes.length,
  }
}

function releaseArchiveExportSnapshot(runtime, { userId, snapshotToken }) {
  const { exportSnapshots, issuedTokens } = runtime
  const snapshot = exportSnapshots.get(snapshotToken)
  const released = !!snapshot && snapshot.userId === userId
  if (released) {
    exportSnapshots.delete(snapshotToken)
    issuedTokens.delete(snapshotToken)
    for (const entry of snapshot.entries) issuedTokens.delete(entry.descriptor.contentToken)
  }
  return { userId, snapshotToken, released }
}

function stageArchiveDeletion(runtime, { userId, scope, operationId, expectedDigest }) {
  const { storage, db, env, fileSystem } = runtime
  let context = storage.read({ userId, operationId })
  if (context.manifest) {
    if (context.manifest.digest === expectedDigest
      && sameScope(context.manifest.scope, scope)
      && context.manifest.state === 'staged') return stageOutput(context.manifest)
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CONFLICT',
      'A different or completed compaction archive deletion uses this operation',
    )
  }
  context = storage.beginStage({ userId, scope, operationId, expectedDigest })
  if (context.manifest.state !== 'staging') {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CONFLICT',
      'A compaction archive deletion operation changed while its fence was established',
    )
  }
  try {
    const state = collectDeletionState({ db, userId, scope, env, fileSystem })
    if (state.digest !== expectedDigest) {
      storage.rollbackFiles(context)
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_PREVIEW_CHANGED',
        'Compaction archives changed after deletion preview',
      )
    }
    storage.save(context, {
      ...context.manifest,
      records: state.records,
      files: state.files,
      alreadyMissing: state.alreadyMissing,
      totalBytes: state.totalBytes,
    })
    storage.stageFiles(context)
    return stageOutput(context.manifest)
  } catch (cause) {
    if (['staging', 'staged'].includes(context.manifest.state)) {
      try { storage.rollbackFiles(context) }
      catch (rollbackCause) {
        throw new AggregateError(
          [cause, rollbackCause],
          'Compaction archive staging failed',
          { cause: rollbackCause },
        )
      }
    }
    throw cause
  }
}

function assertArchiveDeletionStable(runtime, input) {
  const { readContext, storage, env, fileSystem, db } = runtime
  const context = readContext(input)
  assertReceipt(context, input)
  storage.assertFilesStaged(context)
  if (context.manifest.scope.kind === 'user') {
    assertUserBucketEmpty({ userId: input.userId, env, fileSystem })
  }
  const records = rowsForScope(db, input.userId, context.manifest.scope)
    .map((row) => normalizedRecord(row, input.userId, env))
  if (JSON.stringify(records) !== JSON.stringify(context.manifest.records)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
      'Compaction archive metadata changed before database commit',
    )
  }
  return { ...input, state: 'staged', stable: true }
}

function recoverArchiveDeletion(runtime, {
  userId,
  operationId,
  databaseCommitted,
  expectedDigest,
  expectedStageToken,
}) {
  const { storage } = runtime
  const context = storage.read({ userId, operationId })
  if (!context.manifest) {
    return { userId, operationId, recovered: false, state: 'none', digest: null, stageToken: null }
  }
  if (context.manifest.digest !== expectedDigest
    || (expectedStageToken !== null && context.manifest.stageToken !== expectedStageToken)) {
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
      'The compaction archive recovery receipt does not match its durable journal',
    )
  }
  if (!['committed', 'rolled_back'].includes(context.manifest.state)) {
    const input = operationInput(context.manifest)
    if (databaseCommitted) storage.commitFiles(context, input)
    else storage.rollbackFiles(context, input)
  }
  return {
    userId, operationId, recovered: true, state: context.manifest.state,
    digest: context.manifest.digest, stageToken: context.manifest.stageToken,
  }
}

export function createSqliteFileCompactionArchiveGovernance({
  db = getDb(),
  env = process.env,
  fileSystem = fs,
  now = Date.now,
  tokenFactory = crypto.randomUUID,
  terminalRetentionMs,
} = {}) {
  const storage = createSqliteFileCompactionArchiveGovernanceStorage({
    db,
    env,
    fileSystem,
    now,
    tokenFactory,
    terminalRetentionMs,
  })
  const exportSnapshots = new Map()
  const issuedTokens = new Set()

  const nextToken = () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const value = String(tokenFactory()).trim()
      if (value && !issuedTokens.has(value)) {
        issuedTokens.add(value)
        return value
      }
    }
    throw compactionGovernanceError(
      'COMPACTION_ARCHIVE_GOVERNANCE_TOKEN_INVALID',
      'A unique compaction archive governance token could not be created',
    )
  }

  const requireSnapshot = (userId, snapshotToken) => {
    const snapshot = exportSnapshots.get(snapshotToken)
    if (!snapshot || snapshot.userId !== userId) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_EXPORT_SNAPSHOT_NOT_FOUND',
        'The compaction archive export snapshot is unavailable',
      )
    }
    return snapshot
  }

  const readContext = ({ userId, operationId }) => {
    const context = storage.read({ userId, operationId })
    if (!context.manifest) {
      throw compactionGovernanceError(
        'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
        'The compaction archive deletion stage is unavailable',
      )
    }
    return context
  }

  const runtime = {
    db, env, fileSystem, storage, exportSnapshots, issuedTokens,
    nextToken, requireSnapshot, readContext,
  }
  return Object.freeze({
    assertMutationAllowed: storage.assertMutationAllowed,
    createExportSnapshot: (input) => createArchiveExportSnapshot(runtime, input),
    listExportEntries({ userId, snapshotToken }) {
      const snapshot = requireSnapshot(userId, snapshotToken)
      return {
        userId, snapshotToken,
        entries: snapshot.entries.map(({ descriptor }) => ({ ...descriptor })),
      }
    },
    readExportChunk: (input) => readArchiveExportChunk(runtime, input),
    releaseExportSnapshot: (input) => releaseArchiveExportSnapshot(runtime, input),
    previewDeletion({ userId, scope }) {
      const state = collectDeletionState({ db, userId, scope, env, fileSystem })
      return {
        userId, scope, digest: state.digest, fileCount: state.fileCount,
        totalBytes: state.totalBytes, alreadyMissing: state.alreadyMissing,
      }
    },
    stageDeletion: (input) => stageArchiveDeletion(runtime, input),
    assertDeletionStable: (input) => assertArchiveDeletionStable(runtime, input),
    commitDeletion(input) {
      const context = readContext(input)
      storage.commitFiles(context, input)
      return commitOutput(context.manifest)
    },
    rollbackDeletion(input) {
      const context = readContext(input)
      storage.rollbackFiles(context, input)
      return rollbackOutput(context.manifest)
    },
    recoverDeletion: (input) => recoverArchiveDeletion(runtime, input),
  })
}
