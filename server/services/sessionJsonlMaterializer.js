import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  decodeSessionContentRecord,
  encodeSessionContentRecord,
  normalizeSessionContentEvent,
  projectSessionContentEvents,
  resolveSessionContentPath,
} from './sessionJsonlCodec.js'

const DEFAULT_BATCH_SIZE = 16
const DEFAULT_LEASE_MS = 60_000
const MAX_ERROR_LENGTH = 2_000

function fileSystemMethod(fileSystem, name) {
  const owner = typeof fileSystem?.[name] === 'function' ? fileSystem : fs
  const method = owner[name]
  if (typeof method !== 'function') throw new TypeError(`Filesystem operation ${name} is unavailable`)
  return method.bind(owner)
}

function unsafePath(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'SESSION_JSONL_PATH_UNSAFE',
  })
}

function isMissingPath(error) {
  return error?.code === 'ENOENT'
}

function lstatIfPresent(fileSystem, target) {
  try {
    return fileSystemMethod(fileSystem, 'lstatSync')(target)
  } catch (error) {
    if (isMissingPath(error)) return null
    throw error
  }
}

function sameFile(left, right) {
  if (!left || !right) return false
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function assertSafeDirectoryStat(stat) {
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()) {
    throw unsafePath('session JSONL directory is not a safe directory')
  }
}

function assertSafeFileStat(stat) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.() || Number(stat.nlink) !== 1) {
    throw unsafePath('session JSONL target is not a single-linked regular file')
  }
}

function ensureDirectory(fileSystem, directory, { recursive = false, mode = 0o700 } = {}) {
  const before = lstatIfPresent(fileSystem, directory)
  if (!before) {
    try {
      fileSystemMethod(fileSystem, 'mkdirSync')(directory, { recursive, mode })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  const stat = fileSystemMethod(fileSystem, 'lstatSync')(directory)
  assertSafeDirectoryStat(stat)
  return { directory, created: !before, stat }
}

function safeDirectoryChain(fileSystem, paths, { create = false } = {}) {
  const directories = [...new Set([
    paths.dataRoot,
    path.dirname(paths.root),
    paths.root,
    paths.userDirectory,
  ].map((entry) => path.resolve(entry)))]
  const chain = []
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]
    if (create) {
      chain.push(ensureDirectory(fileSystem, directory, { recursive: index === 0 }))
      continue
    }
    const stat = lstatIfPresent(fileSystem, directory)
    if (!stat) return null
    assertSafeDirectoryStat(stat)
    chain.push({ directory, created: false, stat })
  }
  return chain
}

function assertDirectoryChainUnchanged(fileSystem, chain) {
  for (const entry of chain || []) {
    const current = fileSystemMethod(fileSystem, 'lstatSync')(entry.directory)
    assertSafeDirectoryStat(current)
    if (!sameFile(entry.stat, current)) {
      throw unsafePath('session JSONL directory changed during access')
    }
  }
}

function syncDirectory(fileSystem, directory) {
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      directory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
    )
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
    return true
  } catch (error) {
    if (process.platform === 'win32'
      && ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      return false
    }
    throw error
  } finally {
    if (descriptor !== undefined) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve the sync error */ }
    }
  }
}

function syncCreatedDirectories(fileSystem, chain) {
  for (const entry of chain || []) {
    if (!entry.created) continue
    syncDirectory(fileSystem, entry.directory)
    const parent = path.dirname(entry.directory)
    if (parent !== entry.directory) syncDirectory(fileSystem, parent)
  }
}

function writeAll(fileSystem, descriptor, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const written = fileSystemMethod(fileSystem, 'writeSync')(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    )
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('session JSONL append made no progress')
    }
    offset += written
  }
}

function truncatePartialTail(fileSystem, descriptor) {
  const stat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
  assertSafeFileStat(stat)
  if (stat.size === 0) return false
  const chunkSize = 64 * 1024
  let cursor = stat.size
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunkSize)
    const bytes = Buffer.alloc(cursor - start)
    const read = fileSystemMethod(fileSystem, 'readSync')(
      descriptor,
      bytes,
      0,
      bytes.length,
      start,
    )
    if (read !== bytes.length) throw new Error('session JSONL tail changed while it was inspected')
    const newline = bytes.lastIndexOf(0x0a)
    if (newline >= 0) {
      const length = start + newline + 1
      if (length < stat.size) fileSystemMethod(fileSystem, 'ftruncateSync')(descriptor, length)
      return length < stat.size
    }
    cursor = start
  }
  fileSystemMethod(fileSystem, 'ftruncateSync')(descriptor, 0)
  return true
}

function openExistingFile(fileSystem, filePath, flags) {
  const before = lstatIfPresent(fileSystem, filePath)
  if (!before) return null
  assertSafeFileStat(before)
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      filePath,
      flags | (fs.constants.O_NOFOLLOW || 0),
    )
    const opened = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const after = fileSystemMethod(fileSystem, 'lstatSync')(filePath)
    assertSafeFileStat(opened)
    assertSafeFileStat(after)
    if (!sameFile(before, opened) || !sameFile(opened, after)) {
      throw unsafePath('session JSONL target changed while it was opened')
    }
    return { descriptor, created: false, stat: opened }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve open failure */ }
    }
    if (error?.code === 'SESSION_JSONL_PATH_UNSAFE') throw error
    throw unsafePath('session JSONL target could not be opened safely', error)
  }
}

function openWritableFile(fileSystem, filePath, { append = false } = {}) {
  const writeFlags = fs.constants.O_RDWR | (append ? fs.constants.O_APPEND : 0)
  const existing = openExistingFile(fileSystem, filePath, writeFlags)
  if (existing) return existing
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      filePath,
      writeFlags | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    const opened = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const after = fileSystemMethod(fileSystem, 'lstatSync')(filePath)
    assertSafeFileStat(opened)
    assertSafeFileStat(after)
    if (!sameFile(opened, after)) throw unsafePath('session JSONL target changed while it was created')
    return { descriptor, created: true, stat: opened }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve create failure */ }
    }
    if (error?.code === 'EEXIST') return openExistingFile(fileSystem, filePath, writeFlags)
    if (error?.code === 'SESSION_JSONL_PATH_UNSAFE') throw error
    throw unsafePath('session JSONL target could not be created safely', error)
  }
}

function openRepairFile(fileSystem, filePath) {
  return openWritableFile(fileSystem, filePath)
}

function openAppendFile(fileSystem, filePath) {
  return openWritableFile(fileSystem, filePath, { append: true })
}

export function appendSessionContentRecord(input, {
  env = process.env,
  cwd = process.cwd(),
  fileSystem = fs,
} = {}) {
  const event = normalizeSessionContentEvent(input)
  const paths = resolveSessionContentPath({
    userId: event.userId,
    sessionId: event.sessionId,
    env,
    cwd,
  })
  const directoryChain = safeDirectoryChain(fileSystem, paths, { create: true })
  let repairDescriptor
  let descriptor
  let created
  try {
    // Windows rejects ftruncate on an O_APPEND handle. Repair through a
    // separately validated O_RDWR descriptor, then reopen the same inode with
    // O_APPEND so a stale writer can never overwrite a later complete record.
    const repair = openRepairFile(fileSystem, paths.filePath)
    if (!repair) throw unsafePath('session JSONL target disappeared while it was opened')
    repairDescriptor = repair.descriptor
    created = repair.created
    assertDirectoryChainUnchanged(fileSystem, directoryChain)
    const repaired = truncatePartialTail(fileSystem, repairDescriptor)
    if (repaired) fileSystemMethod(fileSystem, 'fsyncSync')(repairDescriptor)
    const repairedStat = fileSystemMethod(fileSystem, 'fstatSync')(repairDescriptor)
    assertSafeFileStat(repairedStat)
    fileSystemMethod(fileSystem, 'closeSync')(repairDescriptor)
    repairDescriptor = undefined

    const opened = openAppendFile(fileSystem, paths.filePath)
    if (!opened || !sameFile(repairedStat, opened.stat)) {
      throw unsafePath('session JSONL target changed between repair and append')
    }
    descriptor = opened.descriptor
    assertDirectoryChainUnchanged(fileSystem, directoryChain)
    writeAll(
      fileSystem,
      descriptor,
      Buffer.from(encodeSessionContentRecord(event), 'utf8'),
    )
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
    const finalStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const finalPathStat = fileSystemMethod(fileSystem, 'lstatSync')(paths.filePath)
    assertSafeFileStat(finalStat)
    assertSafeFileStat(finalPathStat)
    if (!sameFile(finalStat, finalPathStat)) {
      throw unsafePath('session JSONL target changed before append completed')
    }
    try { fileSystemMethod(fileSystem, 'fchmodSync')(descriptor, 0o600) } catch { /* Windows may ignore modes. */ }
  } finally {
    if (repairDescriptor !== undefined) fileSystemMethod(fileSystem, 'closeSync')(repairDescriptor)
    if (descriptor !== undefined) fileSystemMethod(fileSystem, 'closeSync')(descriptor)
  }
  if (created) syncDirectory(fileSystem, paths.userDirectory)
  syncCreatedDirectories(fileSystem, directoryChain)
  return Object.freeze({ event, path: paths.filePath })
}

export function readSessionContentRecords({
  userId,
  sessionId,
  env = process.env,
  cwd = process.cwd(),
  fileSystem = fs,
  toleratePartialTail = true,
} = {}) {
  const paths = resolveSessionContentPath({ userId, sessionId, env, cwd })
  const directoryChain = safeDirectoryChain(fileSystem, paths)
  if (!directoryChain) return Object.freeze([])
  const opened = openExistingFile(fileSystem, paths.filePath, fs.constants.O_RDONLY)
  if (!opened) return Object.freeze([])
  let bytes
  try {
    assertDirectoryChainUnchanged(fileSystem, directoryChain)
    bytes = fileSystemMethod(fileSystem, 'readFileSync')(opened.descriptor)
  } finally {
    fileSystemMethod(fileSystem, 'closeSync')(opened.descriptor)
  }
  let completeBytes = bytes
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    if (!toleratePartialTail) throw new Error('session JSONL has an incomplete tail record')
    const newline = bytes.lastIndexOf(0x0a)
    completeBytes = newline < 0 ? Buffer.alloc(0) : bytes.subarray(0, newline + 1)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(completeBytes)
  const lines = text.split('\n')
  const records = lines.filter(Boolean).map((line) => decodeSessionContentRecord(line))
  return Object.freeze(records)
}

export function readSessionContentProjection(options = {}) {
  return projectSessionContentEvents(readSessionContentRecords(options))
}

function replacementEvent(event, messages) {
  return normalizeSessionContentEvent({
    ...event,
    eventType: 'session.replace',
    payload: { messages },
  })
}

export function replaceSessionContentRecord(input, {
  env = process.env,
  cwd = process.cwd(),
  fileSystem = fs,
} = {}) {
  const event = normalizeSessionContentEvent(input)
  const paths = resolveSessionContentPath({
    userId: event.userId,
    sessionId: event.sessionId,
    env,
    cwd,
  })
  const directoryChain = safeDirectoryChain(fileSystem, paths, { create: true })
  const before = lstatIfPresent(fileSystem, paths.filePath)
  if (before) assertSafeFileStat(before)
  const temporaryPath = path.join(
    paths.userDirectory,
    `.${path.basename(paths.filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor
  let temporaryStat
  let renamed = false
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      temporaryPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    temporaryStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const temporaryPathStat = fileSystemMethod(fileSystem, 'lstatSync')(temporaryPath)
    assertSafeFileStat(temporaryStat)
    assertSafeFileStat(temporaryPathStat)
    if (!sameFile(temporaryStat, temporaryPathStat)) {
      throw unsafePath('session JSONL temporary file changed while it was opened')
    }
    writeAll(fileSystem, descriptor, Buffer.from(encodeSessionContentRecord(event), 'utf8'))
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
    try { fileSystemMethod(fileSystem, 'fchmodSync')(descriptor, 0o600) } catch { /* Windows may ignore modes. */ }
    fileSystemMethod(fileSystem, 'closeSync')(descriptor)
    descriptor = undefined

    assertDirectoryChainUnchanged(fileSystem, directoryChain)
    const current = lstatIfPresent(fileSystem, paths.filePath)
    if ((before && !sameFile(before, current)) || (!before && current)) {
      throw unsafePath('session JSONL target changed before atomic replacement')
    }
    fileSystemMethod(fileSystem, 'renameSync')(temporaryPath, paths.filePath)
    renamed = true
    const finalStat = fileSystemMethod(fileSystem, 'lstatSync')(paths.filePath)
    assertSafeFileStat(finalStat)
    if (!sameFile(temporaryStat, finalStat)) {
      throw unsafePath('session JSONL atomic replacement changed identity')
    }
    syncDirectory(fileSystem, paths.userDirectory)
    syncCreatedDirectories(fileSystem, directoryChain)
    return Object.freeze({ event, path: paths.filePath, replaced: Boolean(before) })
  } finally {
    if (descriptor !== undefined) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve the write error */ }
    }
    if (!renamed && lstatIfPresent(fileSystem, temporaryPath)) {
      try { fileSystemMethod(fileSystem, 'unlinkSync')(temporaryPath) } catch { /* retry will use a fresh temp */ }
    }
  }
}

export function deleteSessionContentFile(input, {
  env = process.env,
  cwd = process.cwd(),
  fileSystem = fs,
} = {}) {
  const event = normalizeSessionContentEvent(input)
  const paths = resolveSessionContentPath({
    userId: event.userId,
    sessionId: event.sessionId,
    env,
    cwd,
  })
  const directoryChain = safeDirectoryChain(fileSystem, paths)
  if (!directoryChain) return Object.freeze({ event, path: paths.filePath, deleted: false })
  const opened = openExistingFile(fileSystem, paths.filePath, fs.constants.O_RDWR)
  if (!opened) return Object.freeze({ event, path: paths.filePath, deleted: false })
  try {
    assertDirectoryChainUnchanged(fileSystem, directoryChain)
    fileSystemMethod(fileSystem, 'ftruncateSync')(opened.descriptor, 0)
    fileSystemMethod(fileSystem, 'fsyncSync')(opened.descriptor)
    const current = lstatIfPresent(fileSystem, paths.filePath)
    if (!sameFile(opened.stat, current)) {
      throw unsafePath('session JSONL target changed before deletion')
    }
  } finally {
    fileSystemMethod(fileSystem, 'closeSync')(opened.descriptor)
  }
  try {
    fileSystemMethod(fileSystem, 'unlinkSync')(paths.filePath)
  } catch (error) {
    if (!isMissingPath(error)) throw error
  }
  syncDirectory(fileSystem, paths.userDirectory)
  return Object.freeze({ event, path: paths.filePath, deleted: true })
}

export function materializeSessionContentEvent(input, options = {}) {
  const event = normalizeSessionContentEvent(input)
  if (event.eventType === 'session.delete') return deleteSessionContentFile(event, options)
  if (event.eventType === 'session.replace') return replaceSessionContentRecord(event, options)
  const records = readSessionContentRecords({
    userId: event.userId,
    sessionId: event.sessionId,
    ...options,
  })
  const projection = projectSessionContentEvents([...records, event])
  if (event.eventType === 'message.delete') {
    if (records.length === 0) return Object.freeze({ event, path: null, replaced: false })
    return replaceSessionContentRecord(replacementEvent(event, projection.messages), options)
  }
  const previous = projectSessionContentEvents(records).messages
    .find((message) => message.id === event.payload.message.id)
  if (previous) {
    return replaceSessionContentRecord(replacementEvent(event, projection.messages), options)
  }
  return appendSessionContentRecord(event, options)
}

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized <= 0) return fallback
  return Math.min(normalized, maximum)
}

function errorMessage(error) {
  return String(error?.message || error || 'session JSONL materialization failed').slice(0, MAX_ERROR_LENGTH)
}

export function createSessionJsonlMaterializer({
  claim,
  acknowledge,
  materialize = null,
  releaseFailure,
  append = appendSessionContentRecord,
  ownerId,
  batchSize = DEFAULT_BATCH_SIZE,
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now,
} = {}) {
  if (typeof claim !== 'function') throw new TypeError('claim is required')
  if (typeof materialize !== 'function' && typeof acknowledge !== 'function') {
    throw new TypeError('materialize or acknowledge is required')
  }
  if (typeof releaseFailure !== 'function') throw new TypeError('releaseFailure is required')
  const safeOwnerId = String(ownerId || '').trim()
  if (!safeOwnerId) throw new TypeError('ownerId is required')
  const safeBatchSize = boundedPositiveInteger(batchSize, DEFAULT_BATCH_SIZE, 1_000)
  const safeLeaseMs = boundedPositiveInteger(leaseMs, DEFAULT_LEASE_MS, 60 * 60 * 1_000)
  let draining = null

  const drainInternal = async () => {
    const claimed = await claim({
      ownerId: safeOwnerId,
      limit: safeBatchSize,
      leaseMs: safeLeaseMs,
      now: now(),
    })
    const rows = Array.isArray(claimed) ? claimed : []
    const results = []
    for (const row of rows) {
      try {
        let written
        if (typeof materialize === 'function') {
          const committed = await materialize({
            id: row.id,
            eventId: row.eventId ?? row.event_id,
            ownerId: safeOwnerId,
            now: now(),
          }, (leasedEvent) => append(leasedEvent))
          written = committed && Object.hasOwn(committed, 'written')
            ? committed.written
            : committed
        } else {
          written = await append(row)
          const acknowledged = await acknowledge({
            id: row.id,
            eventId: row.eventId ?? row.event_id,
            ownerId: safeOwnerId,
            now: now(),
          })
          if (acknowledged !== true && Number(acknowledged?.changes || 0) !== 1) {
            throw Object.assign(new Error('session content outbox acknowledgement lost its lease'), {
              code: 'SESSION_CONTENT_OUTBOX_ACK_LOST',
            })
          }
        }
        results.push(Object.freeze({ id: row.id, ok: true, written }))
      } catch (error) {
        await releaseFailure({
          id: row.id,
          eventId: row.eventId ?? row.event_id,
          ownerId: safeOwnerId,
          error: errorMessage(error),
          now: now(),
        })
        results.push(Object.freeze({ id: row.id, ok: false, error }))
      }
    }
    return Object.freeze(results)
  }

  return Object.freeze({
    drainOnce() {
      if (draining) return draining
      draining = Promise.resolve()
        .then(drainInternal)
        .finally(() => { draining = null })
      return draining
    },
  })
}
