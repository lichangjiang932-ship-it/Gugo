import fs from 'node:fs'
import JSZip from 'jszip'

import { getDb } from '../db.js'
import { createCompactionArchiveExportSnapshot } from './compactionArchiveExportRuntime.js'
import { acquireCompactionArchiveGovernanceLease } from './compactionArchiveGovernanceRuntime.js'
import { collectTurnEmergencyFailureExportFiles } from './turnEmergencyFailureDataGovernance.js'
import {
  buildManagedUserFileCatalog,
  openManagedFileDescriptor,
} from './userDataManagedFileCatalog.js'
import { createUserDataGovernanceError } from './userDataGovernanceError.js'
import {
  collectDatabaseRows,
  sanitizeExportDatabase,
} from './userDataRecordGraph.js'

const EXPORT_FORMAT = 'gugo-authoritative-user-data'
const EXPORT_VERSION = 1

function tableExists(db, name) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name)
}

function assertUserSessionContentExportReady(db, userId) {
  if (!tableExists(db, 'session_content_outbox')) return
  const pending = db.prepare(`
    SELECT session_id, status
    FROM session_content_outbox
    WHERE user_id = ? AND status <> 'materialized'
    ORDER BY id ASC LIMIT 1
  `).get(userId)
  if (!pending) return
  throw createUserDataGovernanceError(
    'USER_DATA_EXPORT_MATERIALIZATION_PENDING',
    'Session content is still being committed to local storage; retry the export shortly',
    409,
    null,
    { sessionId: pending.session_id, materializationStatus: pending.status },
  )
}

export function buildAuthoritativeUserDataSnapshot({
  userId,
  db = getDb(),
  env = process.env,
  now = Date.now(),
  cwd = process.cwd(),
  tempDir,
  fileSystem = fs,
  compactionArchivePort,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) {
    throw createUserDataGovernanceError('UNAUTHORIZED', 'User is required', 401)
  }
  const compactionExport = createCompactionArchiveExportSnapshot({
    userId: safeUserId,
    port: compactionArchivePort,
  })
  try {
    return db.transaction(() => {
      assertUserSessionContentExportReady(db, safeUserId)
      const collected = collectDatabaseRows(db, safeUserId, {
        excludedTables: ['compaction_archive'],
      })
      const {
        records,
        redactedFields,
        excludedTables,
      } = sanitizeExportDatabase(collected)
      const { catalog } = collected
      const managed = buildManagedUserFileCatalog({
        records,
        userId: safeUserId,
        db,
        catalogByName: new Map(catalog.map((table) => [table.name, table])),
        env,
        purpose: 'export',
        fileSystem,
      })
      const emergencyJournalFiles = collectTurnEmergencyFailureExportFiles({
        userId: safeUserId,
        env,
        cwd,
        tempDir,
        fileSystem,
      })
      const files = [...managed.files, ...emergencyJournalFiles, ...compactionExport.files]
      const tableCounts = Object.fromEntries(
        Object.entries(records).map(([name, rows]) => [name, rows.length]),
      )
      const manifest = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: new Date(now).toISOString(),
        userId: safeUserId,
        credentialKeyIncluded: false,
        authenticationSessionsIncluded: false,
        database: { tableCounts, redactedFields, excludedTables, tables: records },
        compactionArchiveSource: {
          portId: compactionExport.portId,
          governanceApiVersion: compactionExport.governanceApiVersion,
        },
        compactionArchives: compactionExport.manifestEntries,
        files: files.map((file) => ({
          kind: file.kind,
          id: file.id,
          archivePath: file.archivePath,
          size: file.size,
          sha256: file.sha256,
        })),
      }
      return { manifest, files, compactionExport }
    }).immediate()
  } catch (error) {
    try {
      compactionExport.releaseSnapshot()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export snapshot creation failed and compaction cleanup also failed',
        { cause: releaseError },
      )
    }
    throw error
  }
}

export function createAuthoritativeUserDataArchive(options = {}, {
  acquireGovernanceLease = acquireCompactionArchiveGovernanceLease,
  buildSnapshot = buildAuthoritativeUserDataSnapshot,
  createZip = () => new JSZip(),
} = {}) {
  const lease = acquireGovernanceLease()
  let compactionExport = null
  let resourcesReleased = false
  let resourceReleaseError = null
  const releaseResources = () => {
    if (resourcesReleased) {
      if (resourceReleaseError) throw resourceReleaseError
      return false
    }
    resourcesReleased = true
    const errors = []
    try { compactionExport?.releaseSnapshot() } catch (error) { errors.push(error) }
    try { lease.release() } catch (error) { errors.push(error) }
    if (errors.length === 1) {
      resourceReleaseError = errors[0]
      throw resourceReleaseError
    }
    if (errors.length > 1) {
      resourceReleaseError = new AggregateError(
        errors,
        'User-data export resources could not be released',
      )
      throw resourceReleaseError
    }
    return true
  }
  let snapshot
  try {
    snapshot = buildSnapshot({
      ...options,
      compactionArchivePort: lease.port,
    })
    compactionExport = snapshot.compactionExport
  } catch (error) {
    try {
      releaseResources()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export setup failed and its governance lease could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
  const { manifest, files } = snapshot
  const fileStreams = []
  let filename
  let stream
  try {
    const zip = createZip()
    zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    zip.file('README.txt', [
      'Gugo authoritative local user-data export',
      'The archive contains user-owned database records and managed file contents.',
      'Authentication session tokens and the credential-vault key are intentionally excluded.',
      'Encrypted credential envelopes remain encrypted; keep the original vault key separately if they must be restored.',
      '',
    ].join('\n'))
    for (const file of files) {
      if (typeof file.createReadStream === 'function') {
        const fileStream = file.createReadStream()
        fileStreams.push(fileStream)
        zip.file(file.archivePath, fileStream)
        continue
      }
      if (Buffer.isBuffer(file.bytes)) {
        zip.file(file.archivePath, file.bytes)
        continue
      }
      const descriptor = openManagedFileDescriptor(file)
      if (file.size === 0) {
        fs.closeSync(descriptor)
        zip.file(file.archivePath, Buffer.alloc(0))
        continue
      }
      const stream = fs.createReadStream(file.fullPath, {
        fd: descriptor,
        autoClose: true,
        start: 0,
        end: file.size - 1,
      })
      fileStreams.push(stream)
      zip.file(file.archivePath, stream)
    }
    const stamp = manifest.exportedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
    filename = `gugo-user-data-${stamp}.zip`
    stream = zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' })
  } catch (error) {
    for (const stream of fileStreams) stream.destroy()
    try {
      releaseResources()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'User-data export archive setup failed and its resources could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
  stream.once('error', (error) => {
    for (const fileStream of fileStreams) fileStream.destroy()
    try {
      releaseResources()
    } catch (releaseError) {
      error.cleanupError = releaseError
    }
  })
  stream.once('end', () => {
    try {
      releaseResources()
    } catch (error) {
      stream.destroy(error)
    }
  })
  stream.once('close', () => {
    if (resourcesReleased) return
    for (const fileStream of fileStreams) fileStream.destroy()
    try {
      releaseResources()
    } catch (error) {
      stream.cleanupError = error
    }
  })
  const dispose = () => {
    for (const fileStream of fileStreams) fileStream.destroy()
    if (!stream.destroyed) stream.destroy()
    return releaseResources()
  }
  return {
    filename,
    manifest,
    stream,
    dispose,
  }
}
