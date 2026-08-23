import crypto from 'node:crypto'
import fs from 'node:fs'

import {
  acquireTurnEmergencyFailureJournalLock,
  resolveTurnEmergencyFailureLogPaths,
} from './turnEmergencyFailureJournal.js'

const ARCHIVE_DIRECTORY = 'turn-emergency-failures'

function fileSystemMethod(fileSystem, name) {
  const owner = typeof fileSystem?.[name] === 'function' ? fileSystem : fs
  const method = owner[name]
  if (typeof method !== 'function') {
    throw new TypeError(`Filesystem operation ${name} is unavailable`)
  }
  return method.bind(owner)
}

function governanceError({ purpose, kind, message, cause = null, recovery = false }) {
  const prefix = purpose === 'export' ? 'USER_DATA_EXPORT' : 'USER_DATA_CLEAR'
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = `${prefix}_EMERGENCY_JOURNAL_${kind}`
  error.statusCode = 500
  if (purpose === 'clear') {
    error.incomplete = true
    error.databaseCleared = false
    error.cleanupPending = recovery
  }
  return error
}

function assertJournalFile(stat, filePath, purpose) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw governanceError({
      purpose,
      kind: 'INVALID',
      message: `Emergency failure journal is not a safe regular file: ${filePath}`,
    })
  }
}

function readJournalSnapshot(filePath, { purpose, fileSystem }) {
  const existsSync = fileSystemMethod(fileSystem, 'existsSync')
  if (!existsSync(filePath)) return null
  let descriptor
  try {
    const pathStat = fileSystemMethod(fileSystem, 'lstatSync')(filePath)
    assertJournalFile(pathStat, filePath, purpose)
    descriptor = fileSystemMethod(fileSystem, 'openSync')(filePath, 'r')
    const descriptorStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (!descriptorStat.isFile()) {
      throw governanceError({
        purpose,
        kind: 'INVALID',
        message: `Emergency failure journal is not a regular file: ${filePath}`,
      })
    }
    if (Number(pathStat.ino) && Number(descriptorStat.ino)
      && (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino)) {
      throw governanceError({
        purpose,
        kind: 'INVALID',
        message: `Emergency failure journal changed while it was opened: ${filePath}`,
      })
    }
    const bytes = Buffer.from(fileSystemMethod(fileSystem, 'readFileSync')(descriptor))
    const finalStat = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (bytes.length !== finalStat.size
      || descriptorStat.size !== finalStat.size
      || descriptorStat.mtimeMs !== finalStat.mtimeMs) {
      throw governanceError({
        purpose,
        kind: 'UNAVAILABLE',
        message: `Emergency failure journal changed while it was being read: ${filePath}`,
      })
    }
    return { bytes, stat: finalStat }
  } catch (cause) {
    if (cause?.code?.startsWith('USER_DATA_')) throw cause
    throw governanceError({
      purpose,
      kind: 'UNAVAILABLE',
      message: `Emergency failure journal could not be read: ${filePath}`,
      cause,
    })
  } finally {
    if (descriptor !== undefined) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* best effort */ }
    }
  }
}

function parseJournalRecords(snapshot, filePath, purpose) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
  } catch (cause) {
    throw governanceError({
      purpose,
      kind: 'INVALID',
      message: `Emergency failure journal is not valid UTF-8: ${filePath}`,
      cause,
    })
  }
  const records = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (cause) {
      throw governanceError({
        purpose,
        kind: 'INVALID',
        message: `Emergency failure journal contains invalid JSON on line ${index + 1}: ${filePath}`,
        cause,
      })
    }
    const validRecord = record && typeof record === 'object' && !Array.isArray(record)
      && typeof record.id === 'string' && record.id.length > 0
      && Array.isArray(record.entries)
      && record.entries.every((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry)
        && Object.hasOwn(entry, 'userId')
        && (entry.userId === null || typeof entry.userId === 'string')
      ))
    if (!validRecord) {
      throw governanceError({
        purpose,
        kind: 'INVALID',
        message: `Emergency failure journal contains an invalid record on line ${index + 1}: ${filePath}`,
      })
    }
    records.push(record)
  }
  return records
}

function serializeRecords(records) {
  if (!records.length) return Buffer.alloc(0)
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
}

function recordsForUser(records, userId) {
  return records.flatMap((record) => {
    const entries = record.entries.filter((entry) => entry.userId === userId)
    return entries.length ? [{ ...record, entries }] : []
  })
}

function recordsWithoutUser(records, userId) {
  let entriesRemoved = 0
  const filtered = records.flatMap((record) => {
    const entries = record.entries.filter((entry) => {
      const remove = entry.userId === userId
      if (remove) entriesRemoved += 1
      return !remove
    })
    return entries.length ? [{ ...record, entries }] : []
  })
  return { records: filtered, entriesRemoved }
}

function journalLocations(options) {
  return resolveTurnEmergencyFailureLogPaths(options).map((filePath, index) => ({
    filePath,
    id: index === 0 ? 'primary' : 'fallback',
  }))
}

function withJournalLock(location, { purpose, fileSystem }, callback) {
  let lock
  try {
    lock = acquireTurnEmergencyFailureJournalLock(location.filePath, { fileSystem })
  } catch (cause) {
    throw governanceError({
      purpose,
      kind: 'UNAVAILABLE',
      message: `Emergency failure journal is busy: ${location.filePath}`,
      cause,
    })
  }
  let result
  let callbackError = null
  try {
    result = callback()
  } catch (error) {
    callbackError = error
  }
  let releaseError = null
  try {
    lock.release()
  } catch (cause) {
    releaseError = governanceError({
      purpose,
      kind: 'UNAVAILABLE',
      message: `Emergency failure journal lock could not be released: ${location.filePath}`,
      cause,
    })
  }
  if (callbackError) {
    if (releaseError) callbackError.lockReleaseError = releaseError
    throw callbackError
  }
  if (releaseError) throw releaseError
  return result
}

export function collectTurnEmergencyFailureExportFiles({
  userId,
  env = process.env,
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}) {
  const files = []
  for (const location of journalLocations({ env, cwd, tempDir })) {
    withJournalLock(location, { purpose: 'export', fileSystem }, () => {
      const snapshot = readJournalSnapshot(location.filePath, { purpose: 'export', fileSystem })
      if (!snapshot) return
      const records = recordsForUser(
        parseJournalRecords(snapshot, location.filePath, 'export'),
        userId,
      )
      if (!records.length) return
      const bytes = serializeRecords(records)
      files.push({
        kind: 'turn-emergency-failure-journal',
        id: location.id,
        archivePath: `${ARCHIVE_DIRECTORY}/${location.id}.jsonl`,
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes,
      })
    })
  }
  return files
}

function stagingPaths(filePath, operationId) {
  return {
    backupPath: `${filePath}.${operationId}.user-data-backup`,
    currentPath: `${filePath}.${operationId}.user-data-current`,
    nextPath: `${filePath}.${operationId}.user-data-next`,
  }
}

function removeFileIfPresent(fileSystem, filePath) {
  if (!fileSystemMethod(fileSystem, 'existsSync')(filePath)) return
  fileSystemMethod(fileSystem, 'unlinkSync')(filePath)
}

function writePrivateFile(fileSystem, filePath, bytes) {
  let descriptor
  try {
    descriptor = fileSystemMethod(fileSystem, 'openSync')(filePath, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = fileSystemMethod(fileSystem, 'writeSync')(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      )
      if (!Number.isInteger(written) || written <= 0) throw new Error('journal write made no progress')
      offset += written
    }
    fileSystemMethod(fileSystem, 'fsyncSync')(descriptor)
  } finally {
    if (descriptor !== undefined) fileSystemMethod(fileSystem, 'closeSync')(descriptor)
  }
  try { fileSystemMethod(fileSystem, 'chmodSync')(filePath, 0o600) } catch { /* Windows may ignore modes. */ }
}

function mergeRecordsForRollback(backupRecords, currentRecords) {
  const originalIds = new Set(backupRecords.map((record) => record.id))
  return [
    ...backupRecords,
    ...currentRecords.filter((record) => !originalIds.has(record.id)),
  ]
}

function normalizeInterruptedRollback(location, fileSystem) {
  const { filePath, currentPath, nextPath } = location
  removeFileIfPresent(fileSystem, nextPath)
  if (!fileSystemMethod(fileSystem, 'existsSync')(currentPath)) return
  if (fileSystemMethod(fileSystem, 'existsSync')(filePath)) {
    removeFileIfPresent(fileSystem, currentPath)
  } else {
    fileSystemMethod(fileSystem, 'renameSync')(currentPath, filePath)
  }
}

function rollbackStagedLocation(location, fileSystem) {
  const { filePath, backupPath, currentPath, nextPath } = location
  normalizeInterruptedRollback(location, fileSystem)
  if (!fileSystemMethod(fileSystem, 'existsSync')(backupPath)) return
  const backupSnapshot = readJournalSnapshot(backupPath, { purpose: 'clear', fileSystem })
  const currentSnapshot = readJournalSnapshot(filePath, { purpose: 'clear', fileSystem })
  const backupRecords = parseJournalRecords(backupSnapshot, backupPath, 'clear')
  const currentRecords = currentSnapshot
    ? parseJournalRecords(currentSnapshot, filePath, 'clear')
    : []
  const mergedBytes = serializeRecords(mergeRecordsForRollback(backupRecords, currentRecords))
  writePrivateFile(fileSystem, nextPath, mergedBytes)
  let movedCurrent = false
  try {
    if (currentSnapshot) {
      fileSystemMethod(fileSystem, 'renameSync')(filePath, currentPath)
      movedCurrent = true
    }
    fileSystemMethod(fileSystem, 'renameSync')(nextPath, filePath)
    removeFileIfPresent(fileSystem, currentPath)
    removeFileIfPresent(fileSystem, backupPath)
  } catch (cause) {
    removeFileIfPresent(fileSystem, nextPath)
    if (movedCurrent
      && !fileSystemMethod(fileSystem, 'existsSync')(filePath)
      && fileSystemMethod(fileSystem, 'existsSync')(currentPath)) {
      fileSystemMethod(fileSystem, 'renameSync')(currentPath, filePath)
    }
    throw cause
  }
}

function cleanupStagedLocation(location, fileSystem) {
  removeFileIfPresent(fileSystem, location.nextPath)
  removeFileIfPresent(fileSystem, location.currentPath)
  removeFileIfPresent(fileSystem, location.backupPath)
}

function assertSnapshotUnchanged(fileSystem, filePath, snapshot) {
  const stat = fileSystemMethod(fileSystem, 'lstatSync')(filePath)
  assertJournalFile(stat, filePath, 'clear')
  const sameIdentity = !Number(snapshot.stat.ino) || !Number(stat.ino)
    || (snapshot.stat.dev === stat.dev && snapshot.stat.ino === stat.ino)
  if (!sameIdentity || snapshot.stat.size !== stat.size || snapshot.stat.mtimeMs !== stat.mtimeMs) {
    throw governanceError({
      purpose: 'clear',
      kind: 'UNAVAILABLE',
      message: `Emergency failure journal changed while it was being cleared: ${filePath}`,
    })
  }
}

export function stageTurnEmergencyFailureUserClear({
  userId,
  operationId,
  env = process.env,
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}) {
  const staged = []
  const locations = journalLocations({ env, cwd, tempDir })
  const stats = { filesChanged: 0, recordsRemoved: 0, entriesRemoved: 0 }
  try {
    for (const location of locations) {
      withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
        const snapshot = readJournalSnapshot(location.filePath, { purpose: 'clear', fileSystem })
        if (!snapshot) return
        const sourceRecords = parseJournalRecords(snapshot, location.filePath, 'clear')
        const filtered = recordsWithoutUser(sourceRecords, userId)
        if (!filtered.entriesRemoved) return
        const paths = stagingPaths(location.filePath, operationId)
        if (fileSystemMethod(fileSystem, 'existsSync')(paths.backupPath)
          || fileSystemMethod(fileSystem, 'existsSync')(paths.currentPath)
          || fileSystemMethod(fileSystem, 'existsSync')(paths.nextPath)) {
          throw governanceError({
            purpose: 'clear',
            kind: 'UNAVAILABLE',
            message: `Emergency failure journal staging paths already exist: ${location.filePath}`,
          })
        }
        const nextBytes = serializeRecords(filtered.records)
        if (nextBytes.length) writePrivateFile(fileSystem, paths.nextPath, nextBytes)
        assertSnapshotUnchanged(fileSystem, location.filePath, snapshot)
        fileSystemMethod(fileSystem, 'renameSync')(location.filePath, paths.backupPath)
        const stagedLocation = { ...location, ...paths }
        staged.push(stagedLocation)
        if (nextBytes.length) fileSystemMethod(fileSystem, 'renameSync')(paths.nextPath, location.filePath)
        stats.filesChanged += 1
        stats.recordsRemoved += sourceRecords.length - filtered.records.length
        stats.entriesRemoved += filtered.entriesRemoved
      })
    }
  } catch (cause) {
    let rollbackCause = null
    try {
      for (const location of [...staged].reverse()) {
        withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
          rollbackStagedLocation(location, fileSystem)
        })
      }
      const stagedPaths = new Set(staged.map((location) => location.filePath))
      for (const location of locations.filter((entry) => !stagedPaths.has(entry.filePath))) {
        withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
          const paths = stagingPaths(location.filePath, operationId)
          removeFileIfPresent(fileSystem, paths.nextPath)
          removeFileIfPresent(fileSystem, paths.currentPath)
        })
      }
    } catch (error) {
      rollbackCause = error
    }
    if (rollbackCause) {
      throw governanceError({
        purpose: 'clear',
        kind: 'RECOVERY_INCOMPLETE',
        message: 'Emergency failure journals could not be restored after a failed clear',
        cause: rollbackCause,
        recovery: true,
      })
    }
    if (cause?.code?.startsWith('USER_DATA_')) throw cause
    throw governanceError({
      purpose: 'clear',
      kind: 'UNAVAILABLE',
      message: 'Emergency failure journals could not be staged for user-data clear',
      cause,
    })
  }
  return {
    stats: Object.freeze({ ...stats }),
    rollback() {
      for (const location of [...staged].reverse()) {
        withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
          rollbackStagedLocation(location, fileSystem)
        })
      }
    },
    cleanup() {
      for (const location of staged) {
        withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
          cleanupStagedLocation(location, fileSystem)
        })
      }
    },
  }
}

export function recoverTurnEmergencyFailureUserClear({
  operationId,
  committed,
  env = process.env,
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
} = {}) {
  for (const location of journalLocations({ env, cwd, tempDir })) {
    const paths = stagingPaths(location.filePath, operationId)
    const stagedLocation = { ...location, ...paths }
    withJournalLock(location, { purpose: 'clear', fileSystem }, () => {
      if (committed) cleanupStagedLocation(stagedLocation, fileSystem)
      else rollbackStagedLocation(stagedLocation, fileSystem)
    })
  }
}
