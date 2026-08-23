import crypto from 'node:crypto'
import { Readable } from 'node:stream'

import { assertCompactionArchiveGovernancePort } from '../core/compactionArchivePort.js'

export const COMPACTION_ARCHIVE_EXPORT_CHUNK_BYTES = 256 * 1024

function exportError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = 500
  return error
}

function archivePathFor(entry) {
  const token = crypto.createHash('sha256')
    .update(String(entry.id))
    .update('\0')
    .update(String(entry.contentToken))
    .digest('hex')
  return `compaction-archives/${token}.json`
}

function assertChunkProgress({ chunk, entry, offset }) {
  if (chunk.nextOffset > entry.sizeBytes) {
    throw exportError(
      'USER_DATA_EXPORT_COMPACTION_SIZE_MISMATCH',
      'A compaction archive export exceeded its declared size',
    )
  }
  const reachedEnd = chunk.nextOffset === entry.sizeBytes
  if (chunk.done !== reachedEnd) {
    throw exportError(
      'USER_DATA_EXPORT_COMPACTION_TRUNCATED',
      'A compaction archive export ended at an unexpected offset',
    )
  }
  if (!chunk.done && chunk.nextOffset === offset) {
    throw exportError(
      'USER_DATA_EXPORT_COMPACTION_STALLED',
      'A compaction archive export made no progress',
    )
  }
}

function createEntryStream({ userId, snapshotToken, entry, port, chunkBytes, isReleased }) {
  function* readChunks() {
    if (isReleased()) {
      throw exportError(
        'USER_DATA_EXPORT_COMPACTION_SNAPSHOT_RELEASED',
        'The compaction archive export snapshot is no longer available',
      )
    }
    const digest = crypto.createHash('sha256')
    let offset = 0
    let readOnce = false
    while (!readOnce || offset < entry.sizeBytes) {
      readOnce = true
      if (isReleased()) {
        throw exportError(
          'USER_DATA_EXPORT_COMPACTION_SNAPSHOT_RELEASED',
          'The compaction archive export snapshot was released while it was being read',
        )
      }
      const remaining = Math.max(1, entry.sizeBytes - offset)
      const chunk = port.readExportChunk({
        userId,
        snapshotToken,
        contentToken: entry.contentToken,
        offset,
        maxBytes: Math.min(chunkBytes, remaining),
      })
      assertChunkProgress({ chunk, entry, offset })
      const bytes = Buffer.from(chunk.dataBase64, 'base64')
      digest.update(bytes)
      offset = chunk.nextOffset
      if (bytes.length > 0) yield bytes
      if (chunk.done) break
    }
    if (offset !== entry.sizeBytes || digest.digest('hex') !== entry.sha256) {
      throw exportError(
        'USER_DATA_EXPORT_COMPACTION_INTEGRITY_FAILED',
        'A compaction archive export failed its integrity check',
      )
    }
  }

  return Readable.from(readChunks())
}

/**
 * Capture one adapter-owned compaction export snapshot.
 *
 * The caller owns the governance-port lease and must keep it alive until every
 * returned stream is complete. releaseSnapshot() is intentionally separate so
 * the outer archive lifecycle can release the snapshot before releasing its
 * port lease.
 */
export function createCompactionArchiveExportSnapshot({
  userId,
  port,
  chunkBytes = COMPACTION_ARCHIVE_EXPORT_CHUNK_BYTES,
} = {}) {
  const safeUserId = String(userId || '').trim()
  if (!safeUserId) {
    const error = exportError('UNAUTHORIZED', 'User is required')
    error.statusCode = 401
    throw error
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > (1024 * 1024)) {
    throw exportError(
      'USER_DATA_EXPORT_COMPACTION_CHUNK_SIZE_INVALID',
      'The compaction archive export chunk size is invalid',
    )
  }
  const trustedPort = assertCompactionArchiveGovernancePort(port)
  let snapshot = null
  let released = false
  const releaseSnapshot = () => {
    if (released || !snapshot) return false
    released = true
    const result = trustedPort.releaseExportSnapshot({
      userId: safeUserId,
      snapshotToken: snapshot.snapshotToken,
    })
    if (!result.released) {
      throw exportError(
        'USER_DATA_EXPORT_COMPACTION_RELEASE_FAILED',
        'The compaction archive export snapshot could not be released',
      )
    }
    return true
  }

  try {
    snapshot = trustedPort.createExportSnapshot({ userId: safeUserId })
    const listed = trustedPort.listExportEntries({
      userId: safeUserId,
      snapshotToken: snapshot.snapshotToken,
    })
    if (listed.entries.length !== snapshot.entryCount) {
      throw exportError(
        'USER_DATA_EXPORT_COMPACTION_SNAPSHOT_CHANGED',
        'The compaction archive export snapshot changed while it was listed',
      )
    }
    const manifestEntries = listed.entries.map((entry) => Object.freeze({
      id: entry.id,
      sessionId: entry.sessionId,
      archivePath: archivePathFor(entry),
      size: entry.sizeBytes,
      sha256: entry.sha256,
    }))
    const files = listed.entries.map((entry, index) => Object.freeze({
      kind: 'compaction-archive',
      id: entry.id,
      archivePath: manifestEntries[index].archivePath,
      size: entry.sizeBytes,
      sha256: entry.sha256,
      createReadStream: () => createEntryStream({
        userId: safeUserId,
        snapshotToken: snapshot.snapshotToken,
        entry,
        port: trustedPort,
        chunkBytes,
        isReleased: () => released,
      }),
    }))
    return Object.freeze({
      portId: trustedPort.id,
      governanceApiVersion: trustedPort.governanceApiVersion,
      snapshotToken: snapshot.snapshotToken,
      manifestEntries: Object.freeze(manifestEntries),
      files: Object.freeze(files),
      releaseSnapshot,
    })
  } catch (error) {
    if (!snapshot) throw error
    try {
      releaseSnapshot()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'Compaction archive export setup failed and its snapshot could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
}
