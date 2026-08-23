import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const JOURNAL_FILE = 'turn-emergency-failures.jsonl'
const JOURNAL_LOCK_SUFFIX = '.lock'
const JOURNAL_LOCK_STALE_MS = 5 * 60 * 1000
const LOCK_OWNER_FILE = 'owner.json'
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_ERROR_MESSAGE = 2_000

function fileSystemMethod(fileSystem, name) {
  const owner = typeof fileSystem?.[name] === 'function' ? fileSystem : fs
  const method = owner[name]
  if (typeof method !== 'function') throw new TypeError(`Filesystem operation ${name} is unavailable`)
  return method.bind(owner)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function journalLockError(filePath, cause = null) {
  return Object.assign(new Error(`Emergency failure journal is busy: ${filePath}`, {
    cause: cause || undefined,
  }), {
    code: 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
    path: filePath,
  })
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
    if (!Number.isInteger(written) || written <= 0) throw new Error('lock write made no progress')
    offset += written
  }
}

function readLockOwner(ownerPath, expectedToken, fileSystem) {
  const pathStat = fileSystemMethod(fileSystem, 'lstatSync')(ownerPath)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error('lock owner is not a regular file')
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(ownerPath, 'r')
    const descriptorStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (!descriptorStat.isFile()) throw new Error('lock owner descriptor is not a regular file')
    if (Number(pathStat.ino) && Number(descriptorStat.ino)
      && (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino)) {
      throw new Error('lock owner changed while it was opened')
    }
    const bytes = Buffer.from(fileSystemMethod(fileSystem, 'readFileSync')(descriptor))
    const finalStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (bytes.length !== finalStat.size
      || descriptorStat.size !== finalStat.size
      || descriptorStat.mtimeMs !== finalStat.mtimeMs) {
      throw new Error('lock owner changed while it was read')
    }
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const valid = metadata?.schemaVersion === 1
      && typeof metadata.token === 'string' && metadata.token.length > 0
      && LOCK_TOKEN_PATTERN.test(metadata.token)
      && (!expectedToken || metadata.token === expectedToken)
      && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
      && typeof metadata.hostname === 'string' && metadata.hostname.length > 0
      && Number.isSafeInteger(metadata.acquiredAt) && metadata.acquiredAt >= 0
    if (!valid) throw new Error('lock owner metadata is invalid')
    return { metadata, stat: finalStat }
  } finally {
    if (descriptor !== undefined) fileSystemMethod(fileSystem, 'closeSync')(descriptor)
  }
}

function sameFileIdentity(left, right) {
  if (Number(left?.ino) && Number(right?.ino)) {
    return left.dev === right.dev && left.ino === right.ino
  }
  return left?.dev === right?.dev && left?.birthtimeMs === right?.birthtimeMs
}

function readLockDirectory(lockDirectory, expectedToken, fileSystem) {
  const directoryStat = fileSystemMethod(fileSystem, 'lstatSync')(lockDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('journal lock is not a safe directory')
  }
  const ownerPath = path.join(lockDirectory, LOCK_OWNER_FILE)
  const owner = readLockOwner(ownerPath, expectedToken, fileSystem)
  const entries = fileSystemMethod(fileSystem, 'readdirSync')(lockDirectory)
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw new Error('journal lock directory contains unexpected entries')
  }
  return { directoryStat, owner, ownerPath }
}

function removeProvenStaleLock({ lockDirectory, token, snapshot, fileSystem }) {
  const confirmed = readLockDirectory(lockDirectory, token, fileSystem)
  if (!sameFileIdentity(snapshot.directoryStat, confirmed.directoryStat)
    || !sameFileIdentity(snapshot.owner.stat, confirmed.owner.stat)) {
    throw new Error('journal lock identity changed before stale cleanup')
  }
  const quarantinePath = `${lockDirectory}.${token}.${randomUUID()}.stale`
  fileSystemMethod(fileSystem, 'renameSync')(lockDirectory, quarantinePath)
  try {
    const quarantined = readLockDirectory(quarantinePath, token, fileSystem)
    if (!sameFileIdentity(snapshot.directoryStat, quarantined.directoryStat)
      || !sameFileIdentity(snapshot.owner.stat, quarantined.owner.stat)) {
      throw new Error('journal lock identity changed during stale cleanup')
    }
    fileSystemMethod(fileSystem, 'unlinkSync')(quarantined.ownerPath)
    fileSystemMethod(fileSystem, 'rmdirSync')(quarantinePath)
  } catch (error) {
    if (!fileSystemMethod(fileSystem, 'existsSync')(lockDirectory)
      && fileSystemMethod(fileSystem, 'existsSync')(quarantinePath)) {
      try { fileSystemMethod(fileSystem, 'renameSync')(quarantinePath, lockDirectory) } catch { /* fail closed */ }
    }
    throw error
  }
}

function serializable(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      typeof item === 'bigint' ? String(item) : item
    )))
  } catch {
    return { serializationError: true }
  }
}

function normalizedPath(value, cwd) {
  const input = String(value || '').trim()
  if (!input) return null
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(cwd, input)
}

export function resolveTurnEmergencyFailureLogPaths({
  env = process.env,
  cwd = process.cwd(),
  tempDir = os.tmpdir(),
} = {}) {
  const explicit = normalizedPath(env?.TURN_EMERGENCY_FAILURE_LOG_PATH, cwd)
  const dataDir = normalizedPath(env?.APP_DATA_DIR, cwd) || path.resolve(cwd, 'server-data')
  const primary = explicit || path.join(dataDir, JOURNAL_FILE)
  const fallback = path.join(path.resolve(tempDir), `gugo-${JOURNAL_FILE}`)
  return Object.freeze([...new Set([primary, fallback])])
}

export function createTurnEmergencyFailureRecord({
  batch = [],
  error = null,
  errorMessage = null,
  attempts = 1,
  failedAt = Date.now(),
  blocked = false,
  journalError = null,
} = {}) {
  const sourceError = error?.cause || error
  return Object.freeze({
    schemaVersion: 1,
    id: randomUUID(),
    failedAt: Math.max(0, Math.floor(Number(failedAt) || Date.now())),
    attempts: Math.max(1, Math.floor(Number(attempts) || 1)),
    blocked: blocked === true,
    error: {
      name: String(sourceError?.name || 'Error').slice(0, 160),
      code: sourceError?.code ? String(sourceError.code).slice(0, 160) : null,
      message: String(errorMessage || sourceError?.message || sourceError || 'event write failed')
        .slice(0, MAX_ERROR_MESSAGE),
    },
    journalError: journalError ? {
      code: journalError?.code ? String(journalError.code).slice(0, 160) : null,
      message: String(journalError?.message || journalError).slice(0, MAX_ERROR_MESSAGE),
    } : null,
    entries: (Array.isArray(batch) ? batch : []).map((item) => ({
      userId: item?.userId ? String(item.userId) : null,
      event: serializable(item?.event),
      checkpointState: serializable(item?.checkpointState),
    })),
  })
}

function appendRecord(filePath, record, fileSystem) {
  const directory = path.dirname(filePath)
  fileSystemMethod(fileSystem, 'mkdirSync')(directory, { recursive: true, mode: 0o700 })
  const lock = acquireTurnEmergencyFailureJournalLock(filePath, { fileSystem })
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(filePath, 'a', 0o600)
    fileSystemMethod(fileSystem, 'writeSync')(
      descriptor,
      `${JSON.stringify(record)}\n`,
      null,
      'utf8',
    )
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
  } finally {
    try {
      if (descriptor !== undefined) fileSystemMethod(fileSystem, 'closeSync')(descriptor)
    } finally {
      lock.release()
    }
  }
  try { fileSystemMethod(fileSystem, 'chmodSync')(filePath, 0o600) } catch { /* Windows may ignore modes. */ }
}

export function acquireTurnEmergencyFailureJournalLock(filePath, {
  fileSystem = fs,
  now = Date.now(),
  hostname = os.hostname(),
  staleMs = JOURNAL_LOCK_STALE_MS,
  isProcessAlive = processIsAlive,
} = {}) {
  const lockDirectory = `${filePath}${JOURNAL_LOCK_SUFFIX}`
  const token = randomUUID()
  const ownerPath = path.join(lockDirectory, LOCK_OWNER_FILE)
  fileSystemMethod(fileSystem, 'mkdirSync')(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  })
  const numericNow = Number(now)
  const safeNow = Number.isFinite(numericNow) ? Math.max(0, Math.floor(numericNow)) : Date.now()
  const safeStaleMs = Math.max(1, Math.floor(Number(staleMs) || JOURNAL_LOCK_STALE_MS))
  const safeHostname = String(hostname || os.hostname())
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor
    let createdDirectoryStat = null
    try {
      fileSystemMethod(fileSystem, 'mkdirSync')(lockDirectory, { mode: 0o700 })
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw journalLockError(filePath, cause)
      let snapshot
      try {
        snapshot = readLockDirectory(lockDirectory, null, fileSystem)
      } catch (error) {
        throw journalLockError(filePath, error)
      }
      const age = safeNow - snapshot.owner.metadata.acquiredAt
      let alive = true
      if (snapshot.owner.metadata.hostname === safeHostname && age >= safeStaleMs) {
        try { alive = isProcessAlive(snapshot.owner.metadata.pid) !== false } catch { alive = true }
      }
      const provenStale = snapshot.owner.metadata.hostname === safeHostname
        && age >= safeStaleMs
        && alive === false
      if (!provenStale) throw journalLockError(filePath)
      try {
        removeProvenStaleLock({
          lockDirectory,
          token: snapshot.owner.metadata.token,
          snapshot,
          fileSystem,
        })
      } catch (error) {
        throw journalLockError(filePath, error)
      }
      continue
    }

    try {
      createdDirectoryStat = fileSystemMethod(fileSystem, 'lstatSync')(lockDirectory)
      if (!createdDirectoryStat.isDirectory() || createdDirectoryStat.isSymbolicLink()) {
        throw new Error('new journal lock is not a safe directory')
      }
      descriptor = fileSystemMethod(fileSystem, 'openSync')(ownerPath, 'wx', 0o600)
      createdDirectoryStat = fileSystemMethod(fileSystem, 'lstatSync')(lockDirectory)
      const payload = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        token,
        pid: process.pid,
        hostname: safeHostname,
        acquiredAt: safeNow,
      })}\n`, 'utf8')
      writeAll(fileSystem, descriptor, payload)
      fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
      fileSystemMethod(fileSystem, 'closeSync')(descriptor)
      descriptor = undefined
      try { fileSystemMethod(fileSystem, 'chmodSync')(ownerPath, 0o600) } catch { /* Windows may ignore modes. */ }
      const owned = readLockDirectory(lockDirectory, token, fileSystem)
      if (!sameFileIdentity(createdDirectoryStat, owned.directoryStat)) {
        throw new Error('new journal lock directory changed during acquisition')
      }
      let released = false
      return Object.freeze({
        path: ownerPath,
        directory: lockDirectory,
        release() {
          if (released) return
          released = true
          try {
            const current = readLockDirectory(lockDirectory, token, fileSystem)
            if (!sameFileIdentity(owned.directoryStat, current.directoryStat)
              || !sameFileIdentity(owned.owner.stat, current.owner.stat)) return
            fileSystemMethod(fileSystem, 'unlinkSync')(ownerPath)
            fileSystemMethod(fileSystem, 'rmdirSync')(lockDirectory)
          } catch { /* Leave an unverified or ABA-replaced lock in place. */ }
        },
      })
    } catch (cause) {
      if (descriptor !== undefined) {
        try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* best effort */ }
      }
      try {
        const currentDirectoryStat = fileSystemMethod(fileSystem, 'lstatSync')(lockDirectory)
        if (!createdDirectoryStat
          || !sameFileIdentity(createdDirectoryStat, currentDirectoryStat)
          || !currentDirectoryStat.isDirectory()
          || currentDirectoryStat.isSymbolicLink()) {
          throw new Error('new journal lock directory identity changed', { cause })
        }
        const entries = fileSystemMethod(fileSystem, 'readdirSync')(lockDirectory)
        if (entries.length > 1 || (entries.length === 1 && entries[0] !== LOCK_OWNER_FILE)) {
          throw new Error('new journal lock directory contains unexpected entries', { cause })
        }
        if (entries.length === 1) {
          const ownerStat = fileSystemMethod(fileSystem, 'lstatSync')(ownerPath)
          if (ownerStat.isDirectory() && !ownerStat.isSymbolicLink()) {
            throw new Error('new journal lock owner path is a directory', { cause })
          }
          fileSystemMethod(fileSystem, 'unlinkSync')(ownerPath)
        }
        fileSystemMethod(fileSystem, 'rmdirSync')(lockDirectory)
      } catch { /* Leave an unverifiable lock in place. */ }
      throw journalLockError(filePath, cause)
    }
  }
  throw journalLockError(filePath)
}

/**
 * Last-resort, database-independent failure journal. The primary location is
 * configurable and a process-local OS data location remains available when
 * the application data directory itself cannot be written.
 */
export function recordTurnEmergencyFailure(input = {}, {
  env = process.env,
  cwd = process.cwd(),
  tempDir = os.tmpdir(),
  fileSystem = fs,
} = {}) {
  const record = createTurnEmergencyFailureRecord(input)
  const failures = []
  for (const filePath of resolveTurnEmergencyFailureLogPaths({ env, cwd, tempDir })) {
    try {
      appendRecord(filePath, record, fileSystem)
      return Object.freeze({ path: filePath, record })
    } catch (error) {
      failures.push(error)
    }
  }
  throw Object.assign(new Error('could not persist emergency turn failure journal', {
    cause: failures.at(-1),
  }), {
    code: 'TURN_EMERGENCY_FAILURE_JOURNAL_FAILED',
    failures,
  })
}
