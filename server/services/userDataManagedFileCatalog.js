import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  encodeSessionContentRecord,
  resolveSessionContentPath,
  SESSION_JSONL_SCHEMA_VERSION,
} from './sessionJsonlCodec.js'
import {
  assertUserDataFileSnapshot,
  captureUserDataFileSnapshot,
} from './userDataFileSnapshot.js'
import { resolveCompactionArchiveUserStorage } from './compactionArchiveStore.js'

const STAGING_FORMAT = 'gugo-user-data-clear-staging'
const STAGING_VERSION = 1
const STAGING_MANIFEST = 'manifest.json'
const STAGING_MANIFEST_TEMP = 'manifest.tmp'
const STAGING_PAYLOAD = 'payload'
const MAX_STAGING_ENTRIES = 100_000

function managedError(code, message, statusCode = 409, cause = null, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}

function fileSystemMethod(fileSystem, name) {
  const method = fileSystem?.[name] || fs[name]
  if (typeof method !== 'function') {
    throw managedError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      `Filesystem operation ${name} is unavailable`,
      500,
      null,
      { incomplete: true },
    )
  }
  return method.bind(fileSystem?.[name] ? fileSystem : fs)
}

function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function appDataRoot(env) {
  return path.resolve(String(env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')))
}

function artifactRoot(env) {
  return path.resolve(
    env.ARTIFACT_DIR && path.isAbsolute(String(env.ARTIFACT_DIR))
      ? String(env.ARTIFACT_DIR)
      : path.resolve(process.cwd(), String(env.ARTIFACT_DIR || '.artifacts')),
  )
}

function storageToken(value, length = 64) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function archiveSegment(value, fallback) {
  const raw = String(value || '').trim()
  const safe = [...path.basename(raw)]
    .map((character) => {
      const code = character.codePointAt(0)
      return code < 32 || code === 127 ? '_' : character
    })
    .join('')
    .trim()
    .slice(0, 120)
  const prefix = safe && safe !== '.' && safe !== '..' ? safe : fallback
  return `${prefix}-${storageToken(raw || fallback, 12)}`
}

function stableArchiveFilename(value, fallback) {
  const name = [...path.basename(String(value || ''))]
    .map((character) => {
      const code = character.codePointAt(0)
      return code < 32 || code === 127 ? '_' : character
    })
    .join('')
    .trim()
  return name && name !== '.' && name !== '..' ? name.slice(0, 180) : fallback
}

function archivePath(...parts) {
  return parts.map((part) => String(part).replaceAll('\\', '/')).join('/')
}

function normalizeRelative(root, fullPath, code, message) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(fullPath)
  if (!isInside(resolvedRoot, resolvedPath)) throw managedError(code, message)
  return path.relative(resolvedRoot, resolvedPath)
}

function assertSafeEntry({
  root,
  fullPath,
  expectedType,
  code,
  message,
  fileSystem = fs,
}) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(fullPath)
  normalizeRelative(resolvedRoot, resolvedPath, code, message)
  try {
    const parts = path.relative(resolvedRoot, resolvedPath).split(path.sep).filter(Boolean)
    let cursor = resolvedRoot
    for (const part of ['', ...parts]) {
      if (part) cursor = path.join(cursor, part)
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(cursor)
      if (stat.isSymbolicLink()) throw managedError(code, message)
    }
    const stat = fileSystemMethod(fileSystem, 'lstatSync')(resolvedPath)
    if (expectedType === 'file' && !stat.isFile()) throw managedError(code, message)
    if (expectedType === 'directory' && !stat.isDirectory()) throw managedError(code, message)
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedRoot))
    const realPath = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedPath))
    if (!isInside(realRoot, realPath)) throw managedError(code, message)
    return stat
  } catch (error) {
    if (error?.code === code) throw error
    throw managedError(code, message, 409, error)
  }
}

function enumerateDirectoryFiles({ root, directory, code, message, fileSystem = fs }) {
  assertSafeEntry({ root, fullPath: directory, expectedType: 'directory', code, message, fileSystem })
  const files = []
  const visit = (current) => {
    const entries = fileSystemMethod(fileSystem, 'readdirSync')(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw managedError(code, message)
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        assertSafeEntry({ root, fullPath, expectedType: 'directory', code, message, fileSystem })
        visit(fullPath)
      } else if (entry.isFile()) {
        const stat = assertSafeEntry({ root, fullPath, expectedType: 'file', code, message, fileSystem })
        files.push({ fullPath, size: stat.size, relativePath: path.relative(directory, fullPath) })
      } else {
        throw managedError(code, message)
      }
    }
  }
  visit(directory)
  return files
}

function tableSupports(catalogByName, tableName, ...columns) {
  const table = catalogByName.get(tableName)
  return !!table && columns.every((column) => table.columnNames.has(column))
}

function otherUserReferenceCount(db, catalogByName, column, value, userId) {
  let count = 0
  for (const tableName of ['job_artifacts', 'turn_artifacts']) {
    if (!tableSupports(catalogByName, tableName, column, 'user_id')) continue
    count += Number(db.prepare(`
      SELECT COUNT(*) AS count FROM "${tableName}"
      WHERE "${column}" IS ? AND "user_id" IS NOT ?
    `).get(value, userId)?.count) || 0
  }
  return count
}

function addArchiveFile(files, seenArchivePaths, descriptor) {
  if (seenArchivePaths.has(descriptor.archivePath)) {
    throw managedError(
      'USER_DATA_EXPORT_ARCHIVE_CONFLICT',
      `Two managed files resolve to ${descriptor.archivePath}`,
    )
  }
  seenArchivePaths.add(descriptor.archivePath)
  files.push(descriptor)
}

function addDeletionEntry(entries, seenPaths, descriptor) {
  const key = `${path.resolve(descriptor.root)}\0${path.resolve(descriptor.fullPath)}`
  if (seenPaths.has(key)) return
  seenPaths.add(key)
  entries.push(descriptor)
}

function managedFileDescriptor({
  kind,
  id,
  archiveName,
  root,
  fullPath,
  code,
  message,
  sha256 = null,
  fileSystem = fs,
}) {
  const stat = assertSafeEntry({ root, fullPath, expectedType: 'file', code, message, fileSystem })
  return {
    kind,
    id,
    archivePath: archiveName,
    root: path.resolve(root),
    fullPath: path.resolve(fullPath),
    code,
    message,
    size: stat.size,
    device: stat.dev,
    inode: stat.ino,
    sha256,
  }
}

function parsedModelContext(value) {
  if (!value) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).length > 0
      ? parsed
      : null
  } catch (cause) {
    throw managedError(
      'USER_DATA_EXPORT_SESSION_CONTENT_INVALID',
      'A stored message model context is not valid JSON',
      409,
      cause,
    )
  }
}

function storedTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

function eventTimestamp(value) {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0
}

function canonicalSessionContentFiles({ records, userId, env }) {
  const messagesBySession = new Map()
  for (const row of records.messages || []) {
    if (String(row.user_id) !== userId) continue
    const sessionId = String(row.session_id || '')
    const messages = messagesBySession.get(sessionId) || []
    messages.push(row)
    messagesBySession.set(sessionId, messages)
  }
  return (records.sessions || []).map((session) => {
    const sessionId = String(session.token || session.id || '').trim()
    if (!sessionId || String(session.user_id) !== userId) {
      throw managedError(
        'USER_DATA_EXPORT_SESSION_CONTENT_INVALID',
        'A stored session cannot be represented in the authoritative content export',
      )
    }
    const identity = crypto.createHash('sha256')
      .update(`${userId}\0${sessionId}`)
      .digest('hex')
    const rows = [...(messagesBySession.get(sessionId) || [])]
      .sort((left, right) => (
        storedTimestamp(left.created_at) - storedTimestamp(right.created_at)
        || String(left.id).localeCompare(String(right.id))
      ))
    const encoded = [encodeSessionContentRecord({
      id: 1,
      eventId: `authoritative-export:${identity}:baseline`,
      userId,
      sessionId,
      eventType: 'session.replace',
      payload: { messages: [] },
      createdAt: eventTimestamp(session.created_at),
    })]
    rows.forEach((row, index) => {
      encoded.push(encodeSessionContentRecord({
        id: index + 2,
        eventId: `authoritative-export:${identity}:message:${index + 1}`,
        userId,
        sessionId,
        eventType: 'message.upsert',
        payload: {
          message: {
            id: row.id,
            role: row.role,
            content: String(row.content ?? ''),
            modelContext: parsedModelContext(row.model_context_json),
            createdAt: storedTimestamp(row.created_at),
            updatedAt: storedTimestamp(row.updated_at),
          },
        },
        createdAt: eventTimestamp(row.updated_at),
      }))
    })
    const bytes = Buffer.from(encoded.join(''), 'utf8')
    const paths = resolveSessionContentPath({ userId, sessionId, env })
    return {
      kind: 'session-content',
      id: sessionId,
      archivePath: archivePath('sessions', path.basename(paths.filePath)),
      bytes,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }
  })
}

function deletionEntry({
  kind,
  id,
  domain,
  root,
  fullPath,
  type = 'file',
  expectedPresent = true,
  code,
  message,
}) {
  return {
    kind,
    id,
    domain,
    root: path.resolve(root),
    fullPath: path.resolve(fullPath),
    relativePath: path.relative(path.resolve(root), path.resolve(fullPath)),
    type,
    expectedPresent,
    code,
    message,
  }
}

export function buildManagedUserFileCatalog({
  records,
  userId,
  db,
  catalogByName,
  env = process.env,
  purpose = 'export',
  fileSystem = fs,
  includeCompactionArchives = true,
} = {}) {
  const exporting = purpose === 'export'
  const dataRoot = appDataRoot(env)
  const artifacts = artifactRoot(env)
  const attachments = path.join(dataRoot, 'attachments')
  const backgroundLogs = path.join(dataRoot, 'background-logs')
  const snapshots = path.join(dataRoot, 'snapshots')
  const browserProfiles = path.join(dataRoot, 'browser-profiles')
  const sessionContent = path.join(dataRoot, 'session-content', `v${SESSION_JSONL_SCHEMA_VERSION}`)
  const files = []
  const dataEntries = []
  const artifactEntries = []
  const seenArchivePaths = new Set()
  const seenDeletionPaths = new Set()
  const stats = {
    artifactFiles: { removed: 0, preservedShared: 0, alreadyMissing: 0 },
    managedFiles: { removable: 0, preservedShared: 0, alreadyMissing: 0 },
  }

  for (const row of exporting ? (records.managed_attachments || []) : []) {
    if (row.status !== 'ready') continue
    const fullPath = path.resolve(attachments, String(row.storage_path || ''))
    const code = 'USER_DATA_EXPORT_ATTACHMENT_UNAVAILABLE'
    const message = `Managed attachment ${row.id} is missing or outside its storage root`
    addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
      kind: 'attachment',
      id: row.id,
      archiveName: archivePath(
        'attachments',
        stableArchiveFilename(row.id, 'attachment'),
        stableArchiveFilename(row.original_name, 'file'),
      ),
      root: attachments,
      fullPath,
      code,
      message,
      sha256: row.sha256 || null,
      fileSystem,
    }))
  }

  if (!exporting && includeCompactionArchives) {
    const compactionStorage = resolveCompactionArchiveUserStorage({ userId, env })
    const compactionPresent = pathExists(fileSystem, compactionStorage.bucketPath)
    const code = 'USER_DATA_CLEAR_COMPACTION_ARCHIVE_UNSAFE'
    const message = 'Managed compaction archives cannot be safely accessed'
    if (compactionPresent) {
      enumerateDirectoryFiles({
        root: dataRoot,
        directory: compactionStorage.bucketPath,
        code,
        message,
        fileSystem,
      })
    }
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'compaction-archive',
      id: userId,
      domain: 'data',
      root: dataRoot,
      fullPath: compactionStorage.bucketPath,
      type: 'directory',
      expectedPresent: compactionPresent,
      code,
      message,
    }))
    if (compactionPresent) stats.managedFiles.removable += 1
  }

  const artifactRows = [
    ...(records.job_artifacts || []),
    ...(records.turn_artifacts || []),
  ]
  const filenames = new Set(artifactRows.map((row) => row.filename).filter(Boolean))
  for (const rawName of filenames) {
    const filename = String(rawName)
    const fullPath = path.resolve(artifacts, filename)
    const code = exporting
      ? 'USER_DATA_EXPORT_ARTIFACT_UNAVAILABLE'
      : 'USER_DATA_CLEAR_ARTIFACT_UNSAFE'
    const message = `Managed artifact ${filename} is missing or outside its storage root`
    if (path.basename(filename) !== filename || !isInside(artifacts, fullPath)) {
      throw managedError(code, message, 409, null, exporting
        ? {}
        : { incomplete: true, databaseCleared: false })
    }
    const shared = otherUserReferenceCount(db, catalogByName, 'filename', filename, userId) > 0
    if (!pathExists(fileSystem, fullPath)) {
      if (exporting) throw managedError(code, message)
      stats.artifactFiles.alreadyMissing += 1
      stats.managedFiles.alreadyMissing += 1
      if (!shared) {
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts,
          fullPath, expectedPresent: false, code, message,
        }))
      }
    } else {
      const descriptor = managedFileDescriptor({
        kind: 'artifact',
        id: filename,
        archiveName: archivePath('artifacts', filename),
        root: artifacts,
        fullPath,
        code,
        message,
        fileSystem,
      })
      addArchiveFile(files, seenArchivePaths, descriptor)
      if (!exporting) {
        if (shared) {
          stats.artifactFiles.preservedShared += 1
          stats.managedFiles.preservedShared += 1
        } else {
          addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
            kind: 'artifact', id: filename, domain: 'artifacts', root: artifacts, fullPath, code, message,
          }))
          stats.artifactFiles.removed += 1
          stats.managedFiles.removable += 1
        }
      }
    }
  }

  const artifactIds = new Set(artifactRows.map((row) => row.id).filter(Boolean))
  for (const rawId of artifactIds) {
    const id = String(rawId)
    const digest = storageToken(id)
    const shared = otherUserReferenceCount(db, catalogByName, 'id', id, userId) > 0
    const sourceRoot = path.join(artifacts, '.artifact-sources')
    const sourcePath = path.join(sourceRoot, `${digest}.json`)
    const sourceCode = exporting
      ? 'USER_DATA_EXPORT_ARTIFACT_SOURCE_UNAVAILABLE'
      : 'USER_DATA_CLEAR_ARTIFACT_SOURCE_UNSAFE'
    const sourceMessage = `Managed source for artifact ${id} cannot be safely accessed`
    const sourcePresent = pathExists(fileSystem, sourcePath)
    if (sourcePresent) {
      addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
        kind: 'artifact-source',
        id,
        archiveName: archivePath('artifact-sources', archiveSegment(id, 'artifact'), 'source.json'),
        root: artifacts,
        fullPath: sourcePath,
        code: sourceCode,
        message: sourceMessage,
        fileSystem,
      }))
    }
    if (!exporting) {
      if (shared) {
        if (sourcePresent) stats.managedFiles.preservedShared += 1
      } else {
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'artifact-source', id, domain: 'artifacts', root: artifacts,
          fullPath: sourcePath, expectedPresent: sourcePresent,
          code: sourceCode, message: sourceMessage,
        }))
        if (sourcePresent) stats.managedFiles.removable += 1
      }
    }

    const bundleRoot = path.join(artifacts, '.html-artifact-assets')
    const bundlePath = path.join(bundleRoot, digest)
    const bundleCode = exporting
      ? 'USER_DATA_EXPORT_HTML_ASSETS_UNAVAILABLE'
      : 'USER_DATA_CLEAR_HTML_ASSETS_UNSAFE'
    const bundleMessage = `Managed HTML assets for artifact ${id} cannot be safely accessed`
    const bundlePresent = pathExists(fileSystem, bundlePath)
    if (bundlePresent) {
      const prefix = archivePath('html-artifact-assets', archiveSegment(id, 'artifact'))
      for (const file of enumerateDirectoryFiles({
        root: artifacts,
        directory: bundlePath,
        code: bundleCode,
        message: bundleMessage,
        fileSystem,
      })) {
        addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
          kind: 'html-artifact-asset',
          id,
          archiveName: archivePath(prefix, file.relativePath),
          root: artifacts,
          fullPath: file.fullPath,
          code: bundleCode,
          message: bundleMessage,
          fileSystem,
        }))
      }
    }
    if (!exporting) {
      if (shared) {
        if (bundlePresent) stats.managedFiles.preservedShared += 1
      } else {
        addDeletionEntry(artifactEntries, seenDeletionPaths, deletionEntry({
          kind: 'html-artifact-assets', id, domain: 'artifacts', root: artifacts,
          fullPath: bundlePath, type: 'directory', expectedPresent: bundlePresent,
          code: bundleCode, message: bundleMessage,
        }))
        if (bundlePresent) stats.managedFiles.removable += 1
      }
    }
  }

  const rowFileGroups = [
    {
      rows: records.background_processes || [],
      value: (row) => row.log_path,
      root: backgroundLogs,
      kind: 'background-log',
      archiveRoot: 'background-logs',
      exportCode: 'USER_DATA_EXPORT_BACKGROUND_LOG_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_BACKGROUND_LOG_UNSAFE',
    },
    {
      rows: records.file_snapshots || [],
      value: (row) => row.before_path,
      root: snapshots,
      kind: 'file-snapshot',
      archiveRoot: 'file-snapshots',
      exportCode: 'USER_DATA_EXPORT_FILE_SNAPSHOT_UNAVAILABLE',
      clearCode: 'USER_DATA_CLEAR_FILE_SNAPSHOT_UNSAFE',
    },
  ]
  for (const group of rowFileGroups) {
    for (const row of group.rows) {
      const storedPath = group.value(row)
      if (!storedPath) continue
      const fullPath = path.resolve(String(storedPath))
      const code = exporting ? group.exportCode : group.clearCode
      const message = `${group.kind} ${row.id} is missing or outside its managed root`
      if (!isInside(path.resolve(group.root), fullPath)) throw managedError(code, message)
      if (!pathExists(fileSystem, fullPath)) {
        if (exporting) throw managedError(code, message)
        stats.managedFiles.alreadyMissing += 1
        addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: dataRoot, fullPath,
          expectedPresent: false, code, message,
        }))
        continue
      }
      const descriptor = managedFileDescriptor({
        kind: group.kind,
        id: row.id,
        archiveName: archivePath(
          group.archiveRoot,
          archiveSegment(row.id, group.kind),
          path.basename(fullPath),
        ),
        root: group.root,
        fullPath,
        code,
        message,
        fileSystem,
      })
      addArchiveFile(files, seenArchivePaths, descriptor)
      if (!exporting) {
        addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
          kind: group.kind, id: row.id, domain: 'data', root: dataRoot, fullPath, code, message,
        }))
        stats.managedFiles.removable += 1
      }
    }
  }

  const browserPath = path.join(browserProfiles, storageToken(userId, 32))
  const browserPresent = pathExists(fileSystem, browserPath)
  const browserCode = exporting
    ? 'USER_DATA_EXPORT_BROWSER_PROFILE_UNAVAILABLE'
    : 'USER_DATA_CLEAR_BROWSER_PROFILE_UNSAFE'
  const browserMessage = 'The managed browser profile cannot be safely accessed'
  if (browserPresent) {
    for (const file of enumerateDirectoryFiles({
      root: dataRoot,
      directory: browserPath,
      code: browserCode,
      message: browserMessage,
      fileSystem,
    })) {
      addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
        kind: 'browser-profile',
        id: userId,
        archiveName: archivePath('browser-profile', file.relativePath),
        root: dataRoot,
        fullPath: file.fullPath,
        code: browserCode,
        message: browserMessage,
        fileSystem,
      }))
    }
  }
  if (!exporting) {
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'browser-profile', id: userId, domain: 'data', root: dataRoot,
      fullPath: browserPath, type: 'directory', expectedPresent: browserPresent,
      code: browserCode, message: browserMessage,
    }))
    if (browserPresent) stats.managedFiles.removable += 1
  }

  const sessionContentPath = path.join(sessionContent, storageToken(userId, 32))
  if (exporting) {
    for (const descriptor of canonicalSessionContentFiles({ records, userId, env })) {
      addArchiveFile(files, seenArchivePaths, descriptor)
    }
  } else {
    const sessionContentPresent = pathExists(fileSystem, sessionContentPath)
    const code = 'USER_DATA_CLEAR_SESSION_CONTENT_UNSAFE'
    const message = 'The managed session content cannot be safely accessed'
    if (sessionContentPresent) {
      for (const file of enumerateDirectoryFiles({
        root: dataRoot,
        directory: sessionContentPath,
        code,
        message,
        fileSystem,
      })) {
        addArchiveFile(files, seenArchivePaths, managedFileDescriptor({
          kind: 'session-content',
          id: userId,
          archiveName: archivePath('sessions', file.relativePath),
          root: dataRoot,
          fullPath: file.fullPath,
          code,
          message,
          fileSystem,
        }))
      }
    }
    addDeletionEntry(dataEntries, seenDeletionPaths, deletionEntry({
      kind: 'session-content',
      id: userId,
      domain: 'data',
      root: dataRoot,
      fullPath: sessionContentPath,
      type: 'directory',
      expectedPresent: sessionContentPresent,
      code,
      message,
    }))
    if (sessionContentPresent) stats.managedFiles.removable += 1
  }

  return {
    files,
    deletion: {
      data: { root: dataRoot, entries: dataEntries },
      artifacts: { root: artifacts, entries: artifactEntries },
    },
    stats,
  }
}

export function openManagedFileDescriptor(file, fileSystem = fs) {
  assertSafeEntry({ ...file, expectedType: 'file', fileSystem })
  let descriptor = null
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      file.fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const descriptorStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const finalStat = assertSafeEntry({ ...file, expectedType: 'file', fileSystem })
    const sameFile = descriptorStat.dev === finalStat.dev && descriptorStat.ino === finalStat.ino
    const sameSnapshotFile = descriptorStat.dev === file.device && descriptorStat.ino === file.inode
    const sizeMatches = file.kind === 'session-content'
      ? descriptorStat.size >= file.size
      : descriptorStat.size === file.size
    if (!descriptorStat.isFile() || !sameFile || !sameSnapshotFile || !sizeMatches) {
      throw managedError(file.code, file.message)
    }
    return descriptor
  } catch (error) {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve error */ }
    }
    if (error?.code === file.code) throw error
    throw managedError(file.code, file.message, 409, error)
  }
}

function manifestEntry(root, entry) {
  const relative = normalizeRelative(root, entry.fullPath, entry.code, entry.message)
  return {
    kind: entry.kind,
    id: String(entry.id),
    relativePath: relative.split(path.sep).join('/'),
    type: entry.type,
    expectedPresent: entry.expectedPresent !== false,
  }
}

function manifestPath(stagePath) {
  return path.join(stagePath, STAGING_MANIFEST)
}

function payloadPath(stagePath) {
  return path.join(stagePath, STAGING_PAYLOAD)
}

function relativeFsPath(value) {
  const normalized = String(value || '')
  if (!normalized || normalized.includes('\\') || path.posix.isAbsolute(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return path.join(...parts)
}

function ensureSafeParentDirectory({ root, fullPath, code, message, fileSystem = fs }) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(fullPath)
  normalizeRelative(resolvedRoot, resolvedPath, code, message)
  try {
    const rootStat = fileSystemMethod(fileSystem, 'lstatSync')(resolvedRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw managedError(code, message)
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(resolvedRoot))
    const parent = path.dirname(resolvedPath)
    const parts = path.relative(resolvedRoot, parent).split(path.sep).filter(Boolean)
    let cursor = resolvedRoot
    for (const part of parts) {
      cursor = path.join(cursor, part)
      if (!pathExists(fileSystem, cursor)) {
        fileSystemMethod(fileSystem, 'mkdirSync')(cursor, { recursive: false })
      }
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw managedError(code, message)
      const realCursor = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(cursor))
      if (realCursor !== realRoot && !isInside(realRoot, realCursor)) throw managedError(code, message)
    }
    return parent
  } catch (error) {
    if (error?.code === code) throw error
    throw managedError(code, message, 500, error, { incomplete: true })
  }
}

function assertSafeStageDirectory({ root, stagePath, fileSystem = fs }) {
  if (!pathExists(fileSystem, stagePath)) return false
  assertSafeEntry({
    root,
    fullPath: stagePath,
    expectedType: 'directory',
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A user-data clear staging path is unsafe',
    fileSystem,
  })
  return true
}

function readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem = fs }) {
  if (!assertSafeStageDirectory({ root, stagePath, fileSystem })) return null
  const target = manifestPath(stagePath)
  if (!pathExists(fileSystem, target)) {
    const entries = fileSystemMethod(fileSystem, 'readdirSync')(stagePath)
    const payload = payloadPath(stagePath)
    const allowed = new Set([STAGING_PAYLOAD, STAGING_MANIFEST_TEMP])
    if (entries.every((name) => allowed.has(name))) {
      if (pathExists(fileSystem, payload)) {
        assertSafeEntry({
          root: stagePath,
          fullPath: payload,
          expectedType: 'directory',
          code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
          message: 'A user-data clear staging payload is unsafe',
          fileSystem,
        })
      }
      const temporary = path.join(stagePath, STAGING_MANIFEST_TEMP)
      if (pathExists(fileSystem, temporary)) {
        assertSafeEntry({
          root: stagePath,
          fullPath: temporary,
          expectedType: 'file',
          code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
          message: 'A user-data clear temporary manifest is unsafe',
          fileSystem,
        })
      }
      const payloadEmpty = !pathExists(fileSystem, payload)
        || fileSystemMethod(fileSystem, 'readdirSync')(payload).length === 0
      if (payloadEmpty) return { empty: true, entries: [] }
    }
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is missing',
      500,
      null,
      { incomplete: true },
    )
  }
  assertSafeEntry({
    root: stagePath,
    fullPath: target,
    expectedType: 'file',
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A user-data clear staging manifest is unsafe',
    fileSystem,
  })
  let parsed
  try {
    parsed = JSON.parse(fileSystemMethod(fileSystem, 'readFileSync')(target, 'utf8'))
  } catch (cause) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is unreadable',
      500,
      cause,
      { incomplete: true },
    )
  }
  if (parsed?.format !== STAGING_FORMAT
    || parsed?.version !== STAGING_VERSION
    || parsed?.domain !== domain
    || parsed?.operationId !== operationId
    || parsed?.userToken !== storageToken(userId, 32)
    || !Array.isArray(parsed?.entries)
    || parsed.entries.length > MAX_STAGING_ENTRIES) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_INVALID',
      'A user-data clear staging manifest is invalid',
      500,
      null,
      { incomplete: true },
    )
  }
  const seen = new Set()
  const entries = parsed.entries.map((entry) => {
    const relativePath = relativeFsPath(entry?.relativePath)
    if (!relativePath
      || !['file', 'directory'].includes(entry?.type)
      || (entry?.expectedPresent !== undefined && typeof entry.expectedPresent !== 'boolean')
      || seen.has(entry.relativePath)) {
      throw managedError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A user-data clear staging entry is invalid',
        500,
        null,
        { incomplete: true },
      )
    }
    seen.add(entry.relativePath)
    const activePath = path.resolve(root, relativePath)
    const stagedPath = path.resolve(payloadPath(stagePath), relativePath)
    if (!isInside(path.resolve(root), activePath)
      || !isInside(path.resolve(payloadPath(stagePath)), stagedPath)) {
      throw managedError(
        'USER_DATA_CLEAR_JOURNAL_INVALID',
        'A user-data clear staging entry escaped its managed root',
        500,
        null,
        { incomplete: true },
      )
    }
    return {
      ...entry,
      expectedPresent: entry.expectedPresent !== false,
      relativePath,
      activePath,
      stagedPath,
    }
  })
  return { ...parsed, entries }
}

function removeTree(fileSystem, target) {
  if (pathExists(fileSystem, target)) {
    fileSystemMethod(fileSystem, 'rmSync')(target, { recursive: true, force: true })
  }
}

export function stageManagedDeletionDomain({
  root,
  stagePath,
  domain,
  entries,
  operationId,
  userId,
  expectedSnapshot = null,
  fileSystem = fs,
} = {}) {
  if (!entries?.length) {
    if (expectedSnapshot?.entries?.length) {
      throw managedError(
        'USER_DATA_CLEAR_PREVIEW_CHANGED',
        'Managed local files changed after the impact preview',
        409,
        null,
        { incomplete: false, databaseCleared: false, cleanupPending: false },
      )
    }
    return {
      movedEntries: [],
      cleanup: () => true,
      rollback: () => true,
      assertStable: () => true,
    }
  }
  const resolvedRoot = path.resolve(root)
  normalizeRelative(
    resolvedRoot,
    stagePath,
    'USER_DATA_CLEAR_JOURNAL_INVALID',
    'A user-data clear staging path escaped its managed root',
  )
  if (pathExists(fileSystem, stagePath)) {
    throw managedError(
      'USER_DATA_CLEAR_JOURNAL_CONFLICT',
      'A user-data clear staging path already exists',
      500,
      null,
      { incomplete: true, databaseCleared: false },
    )
  }
  const serializedEntries = entries.map((entry) => manifestEntry(resolvedRoot, entry))
  const movedEntries = []
  const snapshotSelections = (sourceEntries, staged = false) => sourceEntries.map((entry) => ({
    fullPath: staged ? entry.stagedPath : entry.fullPath,
    type: entry.type,
    logicalPath: path.relative(
      resolvedRoot,
      staged ? entry.activePath : entry.fullPath,
    ).split(path.sep).join('/'),
  }))
  const captureActiveSnapshot = () => captureUserDataFileSnapshot({
    root: resolvedRoot,
    selections: snapshotSelections(entries),
    namespace: domain,
    fileSystem,
    code: 'USER_DATA_CLEAR_PREVIEW_CHANGED',
    message: 'Managed local files changed after the impact preview',
  })
  const captureStagedSnapshot = () => captureUserDataFileSnapshot({
    root: payloadPath(stagePath),
    selections: snapshotSelections(movedEntries, true),
    namespace: domain,
    fileSystem,
    code: 'USER_DATA_CLEAR_PREVIEW_CHANGED',
    message: 'Managed local files changed while they were being staged',
  })
  const assertStable = () => {
    if (!expectedSnapshot) return true
    if (entries.some((entry) => pathExists(fileSystem, entry.fullPath))) {
      throw managedError(
        'USER_DATA_CLEAR_PREVIEW_CHANGED',
        'Managed local files changed while they were being staged',
        409,
        null,
        { incomplete: false, databaseCleared: false, cleanupPending: false },
      )
    }
    assertUserDataFileSnapshot(expectedSnapshot, captureStagedSnapshot())
    return true
  }
  const rollback = () => {
    for (const entry of [...movedEntries].reverse()) {
      if (!pathExists(fileSystem, entry.stagedPath)) continue
      if (pathExists(fileSystem, entry.activePath)) {
        throw managedError(
          'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
          'A managed file could not be restored after a failed clear',
          500,
          null,
          { incomplete: true, databaseCleared: false },
        )
      }
      ensureSafeParentDirectory({
        root: resolvedRoot,
        fullPath: entry.activePath,
        code: 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        message: 'A managed file restore destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.stagedPath, entry.activePath)
    }
    removeTree(fileSystem, stagePath)
    return true
  }
  try {
    if (expectedSnapshot) {
      assertUserDataFileSnapshot(expectedSnapshot, captureActiveSnapshot())
    }
    fileSystemMethod(fileSystem, 'mkdirSync')(resolvedRoot, { recursive: true })
    ensureSafeParentDirectory({
      root: resolvedRoot,
      fullPath: stagePath,
      code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
      message: 'A user-data clear staging destination is unsafe',
      fileSystem,
    })
    fileSystemMethod(fileSystem, 'mkdirSync')(stagePath, { recursive: false })
    fileSystemMethod(fileSystem, 'mkdirSync')(payloadPath(stagePath), { recursive: false })
    const temporaryManifest = path.join(stagePath, STAGING_MANIFEST_TEMP)
    fileSystemMethod(fileSystem, 'writeFileSync')(temporaryManifest, JSON.stringify({
      format: STAGING_FORMAT,
      version: STAGING_VERSION,
      domain,
      operationId,
      userToken: storageToken(userId, 32),
      entries: serializedEntries,
    }), { flag: 'wx', mode: 0o600 })
    fileSystemMethod(fileSystem, 'renameSync')(temporaryManifest, manifestPath(stagePath))
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const serialized = serializedEntries[index]
      const relativePath = relativeFsPath(serialized.relativePath)
      const stagedPath = path.join(payloadPath(stagePath), relativePath)
      const activeExists = pathExists(fileSystem, entry.fullPath)
      if (!activeExists && entry.expectedPresent === false) continue
      if (activeExists && entry.expectedPresent === false) {
        throw managedError(
          'USER_DATA_CLEAR_PREVIEW_CHANGED',
          'Managed local files changed after the impact preview',
          409,
          null,
          { incomplete: false, databaseCleared: false, cleanupPending: false },
        )
      }
      assertSafeEntry({
        root: resolvedRoot,
        fullPath: entry.fullPath,
        expectedType: entry.type,
        code: entry.code,
        message: entry.message,
        fileSystem,
      })
      ensureSafeParentDirectory({
        root: payloadPath(stagePath),
        fullPath: stagedPath,
        code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
        message: 'A staged managed-file destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.fullPath, stagedPath)
      movedEntries.push({ ...entry, activePath: entry.fullPath, stagedPath })
      assertSafeEntry({
        root: payloadPath(stagePath),
        fullPath: stagedPath,
        expectedType: entry.type,
        code: entry.code,
        message: entry.message,
        fileSystem,
      })
    }
    assertStable()
  } catch (cause) {
    let rollbackCause = null
    try { rollback() } catch (error) { rollbackCause = error }
    if (rollbackCause) {
      throw managedError(
        'USER_DATA_CLEAR_RECOVERY_INCOMPLETE',
        'Managed files could not be staged or fully restored; recovery evidence was retained',
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
    if (cause?.code?.startsWith('USER_DATA_')) throw cause
    throw managedError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      'Managed files could not be staged; no database data was cleared',
      500,
      cause,
      { incomplete: true, databaseCleared: false },
    )
  }
  return {
    movedEntries,
    cleanup() {
      cleanupManagedDeletionStage({ root: resolvedRoot, stagePath, domain, operationId, userId, fileSystem })
      return true
    },
    rollback,
    assertStable,
  }
}

export function rollbackManagedDeletionStage({
  root,
  stagePath,
  domain,
  operationId,
  userId,
  fileSystem = fs,
} = {}) {
  const manifest = readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem })
  if (!manifest) return true
  if (manifest.empty) {
    removeTree(fileSystem, stagePath)
    return true
  }
  for (const entry of [...manifest.entries].reverse()) {
    const activeExists = pathExists(fileSystem, entry.activePath)
    const stagedExists = pathExists(fileSystem, entry.stagedPath)
    if (activeExists && stagedExists) {
      throw managedError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'A staged managed file conflicts with its active path',
        500,
        null,
        { incomplete: true, databaseCleared: false },
      )
    }
    if (stagedExists) {
      assertSafeEntry({
        root: payloadPath(stagePath),
        fullPath: entry.stagedPath,
        expectedType: entry.type,
        code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
        message: 'A staged managed file is unsafe',
        fileSystem,
      })
      ensureSafeParentDirectory({
        root,
        fullPath: entry.activePath,
        code: 'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        message: 'A recovered managed-file destination is unsafe',
        fileSystem,
      })
      fileSystemMethod(fileSystem, 'renameSync')(entry.stagedPath, entry.activePath)
    } else if (!activeExists && entry.expectedPresent !== false) {
      throw managedError(
        'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
        'A managed file is missing from both active and staging storage',
        500,
        null,
        { incomplete: true, databaseCleared: false },
      )
    }
  }
  removeTree(fileSystem, stagePath)
  return true
}

export function cleanupManagedDeletionStage({
  root,
  stagePath,
  domain,
  operationId,
  userId,
  fileSystem = fs,
} = {}) {
  const manifest = readStageManifest({ root, stagePath, domain, operationId, userId, fileSystem })
  if (!manifest) return true
  enumerateDirectoryFiles({
    root,
    directory: stagePath,
    code: 'USER_DATA_CLEAR_JOURNAL_INVALID',
    message: 'A committed user-data staging tree is unsafe',
    fileSystem,
  })
  removeTree(fileSystem, stagePath)
  return true
}

export const _testing = {
  appDataRoot,
  artifactRoot,
  storageToken,
}
