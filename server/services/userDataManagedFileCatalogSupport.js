import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  encodeSessionContentRecord,
  resolveSessionContentPath,
} from './sessionJsonlCodec.js'

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


export {
  addArchiveFile,
  addDeletionEntry,
  appDataRoot,
  archivePath,
  archiveSegment,
  artifactRoot,
  assertSafeEntry,
  canonicalSessionContentFiles,
  deletionEntry,
  enumerateDirectoryFiles,
  fileSystemMethod,
  isInside,
  managedError,
  managedFileDescriptor,
  normalizeRelative,
  otherUserReferenceCount,
  pathExists,
  stableArchiveFilename,
  storageToken,
}
