import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getDb } from '../db.js'
import { assertUserDataMutationAllowed } from './userDataClearGuard.js'

const STORAGE_DIRECTORY = 'compaction-archives'
const STORAGE_VERSION = 'v1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

function archiveError(code, message, statusCode = 409, cause = null, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  Object.assign(error, details)
  return error
}

function fileSystemMethod(fileSystem, name) {
  const method = fileSystem?.[name] || fs[name]
  if (typeof method !== 'function') {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_UNAVAILABLE',
      `Filesystem operation ${name} is unavailable`,
      500,
    )
  }
  return method.bind(fileSystem?.[name] ? fileSystem : fs)
}

function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function dataRoot(env = process.env) {
  return path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function ownerBucket(userId) {
  return digest(userId).slice(0, 32)
}

function archiveFilename(userId, id) {
  return `${digest(`${userId}\0${id}`)}.json`
}

function requiredIdentity(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw archiveError('COMPACTION_ARCHIVE_INVALID', `${label} is required`, 400)
  return normalized
}

function expectedStoragePath(userId, id) {
  return path.posix.join(
    STORAGE_VERSION,
    ownerBucket(userId),
    archiveFilename(userId, id),
  )
}

export function resolveCompactionArchiveUserStorage({ userId, env = process.env } = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  const root = path.join(dataRoot(env), STORAGE_DIRECTORY)
  const versionRoot = path.join(root, STORAGE_VERSION)
  const bucket = ownerBucket(ownerId)
  return {
    root,
    versionRoot,
    bucket,
    bucketPath: path.join(versionRoot, bucket),
  }
}

export function resolveCompactionArchiveStorage({
  userId,
  id,
  storagePath,
  env = process.env,
} = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  const archiveId = requiredIdentity(id, 'archive id')
  const expected = expectedStoragePath(ownerId, archiveId)
  if (storagePath !== expected || storagePath.includes('\\')) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive storage metadata is invalid',
    )
  }
  const owner = resolveCompactionArchiveUserStorage({ userId: ownerId, env })
  const fullPath = path.resolve(owner.root, ...expected.split('/'))
  if (!isInside(owner.root, fullPath) || !isInside(owner.bucketPath, fullPath)) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive storage path escaped its managed root',
    )
  }
  return { ...owner, storagePath: expected, fullPath }
}

function assertDirectory(fileSystem, root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (resolvedCandidate !== resolvedRoot && !isInside(resolvedRoot, resolvedCandidate)) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive directory escaped its managed root',
    )
  }
  try {
    const parts = path.relative(resolvedRoot, resolvedCandidate).split(path.sep).filter(Boolean)
    let cursor = resolvedRoot
    for (const part of ['', ...parts]) {
      if (part) cursor = path.join(cursor, part)
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw archiveError(
          'COMPACTION_ARCHIVE_STORAGE_INVALID',
          'Compaction archive directory is unsafe',
        )
      }
    }
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedRoot))
    const realCandidate = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedCandidate))
    if (realCandidate !== realRoot && !isInside(realRoot, realCandidate)) {
      throw archiveError(
        'COMPACTION_ARCHIVE_STORAGE_INVALID',
        'Compaction archive directory escaped its canonical root',
      )
    }
  } catch (cause) {
    if (cause?.code?.startsWith('COMPACTION_ARCHIVE_')) throw cause
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive directory cannot be safely accessed',
      409,
      cause,
    )
  }
}

function ensureStorageDirectories({ userId, env, fileSystem }) {
  const owner = resolveCompactionArchiveUserStorage({ userId, env })
  const rootData = dataRoot(env)
  fileSystemMethod(fileSystem, 'mkdirSync')(rootData, { recursive: true, mode: 0o700 })
  assertDirectory(fileSystem, rootData, rootData)
  for (const directory of [owner.root, owner.versionRoot, owner.bucketPath]) {
    if (!pathExists(fileSystem, directory)) {
      fileSystemMethod(fileSystem, 'mkdirSync')(directory, { recursive: false, mode: 0o700 })
    }
    assertDirectory(fileSystem, rootData, directory)
  }
  return owner
}

function syncDirectory(fileSystem, directory) {
  let descriptor = null
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(directory, 'r')
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
  } catch {
    // Windows may reject directory handles. The file itself was fsynced before
    // the same-directory atomic rename, which remains the required barrier.
  } finally {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* best effort */ }
    }
  }
}

function serializeArchive(messages) {
  if (!Array.isArray(messages)) {
    throw archiveError('COMPACTION_ARCHIVE_INVALID', 'archivedMessages must be an array', 400)
  }
  let json
  try {
    json = JSON.stringify(messages)
  } catch (cause) {
    throw archiveError(
      'COMPACTION_ARCHIVE_INVALID',
      'archivedMessages cannot be serialized',
      400,
      cause,
    )
  }
  const bytes = Buffer.from(json, 'utf8')
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw archiveError(
      'COMPACTION_ARCHIVE_TOO_LARGE',
      `Compaction archive exceeds ${MAX_ARCHIVE_BYTES} bytes`,
      413,
    )
  }
  return {
    bytes,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
}

function writeDurableFile({ userId, id, bytes, env, fileSystem }) {
  const storagePath = expectedStoragePath(userId, id)
  const resolved = resolveCompactionArchiveStorage({ userId, id, storagePath, env })
  ensureStorageDirectories({ userId, env, fileSystem })
  const temporaryPath = path.join(
    resolved.bucketPath,
    `.${path.basename(resolved.fullPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor = null
  let renamed = false
  try {
    if (pathExists(fileSystem, resolved.fullPath)) {
      throw archiveError(
        'COMPACTION_ARCHIVE_STORAGE_CONFLICT',
        'Compaction archive storage already exists',
        409,
      )
    }
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    fileSystemMethod(fileSystem, 'writeFileSync')(descriptor, bytes)
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
    fileSystemMethod(fileSystem, 'closeSync')(descriptor)
    descriptor = null
    fileSystemMethod(fileSystem, 'renameSync')(temporaryPath, resolved.fullPath)
    renamed = true
    syncDirectory(fileSystem, resolved.bucketPath)
    return resolved
  } catch (cause) {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* best effort */ }
    }
    if (!renamed && pathExists(fileSystem, temporaryPath)) {
      try { fileSystemMethod(fileSystem, 'unlinkSync')(temporaryPath) } catch { /* swept later */ }
    }
    if (cause?.code?.startsWith('COMPACTION_ARCHIVE_')) throw cause
    throw archiveError(
      'COMPACTION_ARCHIVE_WRITE_FAILED',
      'Compaction archive could not be written durably',
      500,
      cause,
    )
  }
}

function validatedMetadata(row) {
  const sizeBytes = Number(row.size_bytes)
  const sha256 = String(row.sha256 || '').toLowerCase()
  if (!Number.isSafeInteger(sizeBytes)
    || sizeBytes < 0
    || sizeBytes > MAX_ARCHIVE_BYTES
    || !SHA256_PATTERN.test(sha256)) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive integrity metadata is invalid',
    )
  }
  return { sizeBytes, sha256 }
}

function readVerifiedFile({ row, userId, env, fileSystem }) {
  if (String(row.user_id) !== userId) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive owner metadata is invalid',
    )
  }
  const metadata = validatedMetadata(row)
  const resolved = resolveCompactionArchiveStorage({
    userId,
    id: row.id,
    storagePath: row.storage_path,
    env,
  })
  assertDirectory(fileSystem, resolved.root, resolved.bucketPath)
  let descriptor = null
  try {
    const before = fileSystemMethod(fileSystem, 'lstatSync')(resolved.fullPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== metadata.sizeBytes) {
      throw archiveError(
        'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
        'Compaction archive file metadata does not match SQLite',
      )
    }
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolved.root))
    const realFile = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolved.fullPath))
    if (!isInside(realRoot, realFile)) {
      throw archiveError(
        'COMPACTION_ARCHIVE_STORAGE_INVALID',
        'Compaction archive file escaped its canonical root',
      )
    }
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      resolved.fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const opened = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (!opened.isFile()
      || opened.size !== metadata.sizeBytes
      || opened.dev !== before.dev
      || opened.ino !== before.ino) {
      throw archiveError(
        'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
        'Compaction archive changed while it was being opened',
      )
    }
    const bytes = fileSystemMethod(fileSystem, 'readFileSync')(descriptor)
    if (bytes.length !== metadata.sizeBytes
      || crypto.createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
      throw archiveError(
        'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
        'Compaction archive digest verification failed',
      )
    }
    return { bytes, ...metadata, ...resolved }
  } catch (cause) {
    if (cause?.code?.startsWith('COMPACTION_ARCHIVE_')) throw cause
    throw archiveError(
      'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
      'Compaction archive file cannot be safely read',
      409,
      cause,
    )
  } finally {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve result */ }
    }
  }
}

function parseArchivedMessages(bytes, expectedCount) {
  let messages
  try {
    messages = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes || '[]'))
  } catch (cause) {
    throw archiveError(
      'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
      'Compaction archive body is not valid JSON',
      409,
      cause,
    )
  }
  if (!Array.isArray(messages) || messages.length !== Number(expectedCount)) {
    throw archiveError(
      'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
      'Compaction archive body does not match its message count',
    )
  }
  return messages
}

function isLegacyRow(row) {
  const noPath = row.storage_path === null || row.storage_path === undefined
  const noSize = row.size_bytes === null || row.size_bytes === undefined
  const noHash = row.sha256 === null || row.sha256 === undefined
  if (noPath && noSize && noHash) return true
  if (noPath || noSize || noHash) {
    throw archiveError(
      'COMPACTION_ARCHIVE_STORAGE_INVALID',
      'Compaction archive has incomplete storage metadata',
    )
  }
  return false
}

export function readCompactionArchiveBody({
  row,
  userId,
  env = process.env,
  fileSystem = fs,
} = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  if (!row || String(row.user_id) !== ownerId) {
    throw archiveError('COMPACTION_ARCHIVE_STORAGE_INVALID', 'Compaction archive owner is invalid')
  }
  if (isLegacyRow(row)) {
    const bytes = Buffer.from(String(row.archived_messages_json || '[]'), 'utf8')
    return {
      legacy: true,
      bytes,
      messages: parseArchivedMessages(bytes, row.replaced_message_count),
      sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      storagePath: null,
      fullPath: null,
    }
  }
  const verified = readVerifiedFile({ row, userId: ownerId, env, fileSystem })
  return {
    legacy: false,
    ...verified,
    messages: parseArchivedMessages(verified.bytes, row.replaced_message_count),
  }
}

export function deleteCompactionArchiveBodies({
  rows,
  userId,
  env = process.env,
  fileSystem = fs,
} = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  if (!Array.isArray(rows)) {
    throw archiveError('COMPACTION_ARCHIVE_INVALID', 'rows must be an array', 400)
  }
  const result = {
    removedFiles: 0,
    missingFiles: 0,
    legacyRows: 0,
    unsafe: 0,
  }
  const changedBuckets = new Set()
  for (const row of rows) {
    try {
      if (!row || String(row.user_id) !== ownerId) {
        throw archiveError(
          'COMPACTION_ARCHIVE_STORAGE_INVALID',
          'Compaction archive owner metadata is invalid',
        )
      }
      if (isLegacyRow(row)) {
        result.legacyRows += 1
        continue
      }
      const resolved = resolveCompactionArchiveStorage({
        userId: ownerId,
        id: row.id,
        storagePath: row.storage_path,
        env,
      })
      if (!pathExists(fileSystem, resolved.fullPath)) {
        result.missingFiles += 1
        continue
      }
      assertDirectory(fileSystem, resolved.root, resolved.bucketPath)
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(resolved.fullPath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw archiveError(
          'COMPACTION_ARCHIVE_STORAGE_INVALID',
          'Compaction archive deletion target is unsafe',
        )
      }
      fileSystemMethod(fileSystem, 'unlinkSync')(resolved.fullPath)
      result.removedFiles += 1
      changedBuckets.add(resolved.bucketPath)
    } catch {
      result.unsafe += 1
    }
  }
  for (const bucketPath of changedBuckets) syncDirectory(fileSystem, bucketPath)
  return result
}

function publicArchive(row, body) {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    replacedMessageCount: row.replaced_message_count,
    archivedMessages: body.messages,
    summaryText: row.summary_text,
    createdAt: row.created_at,
  }
}

export function createCompactionArchiveRecord({
  userId,
  sessionId,
  archivedMessages,
  summaryText,
  id = `cmp-${crypto.randomUUID()}`,
  now = Date.now(),
  db = getDb(),
  env = process.env,
  fileSystem = fs,
} = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  const safeSessionId = requiredIdentity(sessionId, 'sessionId')
  const archiveId = requiredIdentity(id, 'archive id')
  const serialized = serializeArchive(archivedMessages)

  const stored = writeDurableFile({
    userId: ownerId,
    id: archiveId,
    bytes: serialized.bytes,
    env,
    fileSystem,
  })
  try {
    db.transaction(() => {
      assertUserDataMutationAllowed(
        db,
        ownerId,
        'Compaction archives cannot change while local data is being cleared',
      )
      db.prepare(`
        INSERT INTO compaction_archive (
          id, user_id, session_id, replaced_message_count,
          archived_messages_json, summary_text, created_at,
          storage_path, size_bytes, sha256
        ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)
      `).run(
        archiveId,
        ownerId,
        safeSessionId,
        archivedMessages.length,
        String(summaryText || ''),
        now,
        stored.storagePath,
        serialized.sizeBytes,
        serialized.sha256,
      )
    }).immediate()
  } catch (cause) {
    let cleanupCause = null
    try {
      fileSystemMethod(fileSystem, 'unlinkSync')(stored.fullPath)
      syncDirectory(fileSystem, stored.bucketPath)
    } catch (error) {
      cleanupCause = error
    }
    if (cleanupCause) {
      throw archiveError(
        'COMPACTION_ARCHIVE_DB_WRITE_FAILED',
        'Compaction archive metadata failed and its orphan file needs cleanup',
        500,
        new AggregateError([cause, cleanupCause]),
        { cleanupPending: true },
      )
    }
    throw cause
  }
  return {
    id: archiveId,
    userId: ownerId,
    sessionId: safeSessionId,
    replacedMessageCount: archivedMessages.length,
    archivedMessages,
    summaryText: String(summaryText || ''),
    createdAt: now,
  }
}

export function getCompactionArchiveRecord({
  userId,
  id,
  db = getDb(),
  env = process.env,
  fileSystem = fs,
} = {}) {
  const ownerId = requiredIdentity(userId, 'userId')
  const archiveId = requiredIdentity(id, 'archive id')
  const row = db.prepare(`
    SELECT * FROM compaction_archive WHERE user_id = ? AND id = ?
  `).get(ownerId, archiveId)
  if (!row) return null
  return publicArchive(row, readCompactionArchiveBody({
    row,
    userId: ownerId,
    env,
    fileSystem,
  }))
}

export const _testing = {
  MAX_ARCHIVE_BYTES,
  archiveFilename,
  expectedStoragePath,
  ownerBucket,
}
