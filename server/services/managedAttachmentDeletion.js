import crypto from 'node:crypto'
import fs from 'node:fs'
import { getDb } from '../db.js'
import { assertUserDataMutationAllowed } from './userDataClearGuard.js'
import { rowPath, safeUnlink } from './managedAttachmentStoreSupport.js'

function attachmentSnapshotParams(row) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    sessionId: row.session_id,
    messageId: row.message_id,
    updatedAt: row.updated_at,
    storagePath: row.storage_path,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
  }
}

function restoreQuarantinedFiles(items, originalError) {
  const restoreErrors = []
  for (const item of [...items].reverse()) {
    try {
      if (!fs.existsSync(item.tombstone)) {
        if (fs.existsSync(item.fullPath)) continue
        throw new Error(`Cannot restore quarantined attachment because both paths are missing: ${item.fullPath}`)
      }
      if (fs.existsSync(item.fullPath)) {
        throw new Error(`Cannot restore quarantined attachment because its destination exists: ${item.fullPath}`)
      }
      fs.renameSync(item.tombstone, item.fullPath)
    } catch (error) {
      restoreErrors.push(error)
    }
  }
  if (restoreErrors.length) {
    throw new AggregateError(
      [originalError, ...restoreErrors].filter(Boolean),
      'Failed to restore quarantined managed attachments',
      { cause: originalError },
    )
  }
}

export function deleteManagedAttachmentRows(
  rows,
  { env = process.env, requireSnapshotMatch = false } = {},
) {
  const candidates = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!candidates.length) return 0
  const db = getDb()
  const ownerIds = new Set(candidates.map((row) => row.user_id))
  for (const ownerId of ownerIds) {
    assertUserDataMutationAllowed(db, ownerId, 'Attachments cannot change while local data is being cleared')
  }

  const quarantined = []
  try {
    for (const row of candidates) {
      let fullPath = null
      try { fullPath = rowPath(row, env) } catch { /* bad DB row: remove metadata only */ }
      if (!fullPath || !fs.existsSync(fullPath)) continue
      const tombstone = `${fullPath}.deleting-${crypto.randomUUID()}`
      fs.renameSync(fullPath, tombstone)
      quarantined.push({ row, fullPath, tombstone })
    }
  } catch (error) {
    restoreQuarantinedFiles(quarantined, error)
    throw error
  }

  const remove = requireSnapshotMatch
    ? db.prepare(`
        DELETE FROM managed_attachments
        WHERE id = @id AND user_id = @userId
          AND status IS @status
          AND session_id IS @sessionId
          AND message_id IS @messageId
          AND updated_at IS @updatedAt
          AND storage_path IS @storagePath
          AND created_at IS @createdAt
          AND size_bytes IS @sizeBytes
          AND sha256 IS @sha256
      `)
    : db.prepare('DELETE FROM managed_attachments WHERE id = ? AND user_id = ?')
  const removedById = new Map()
  let removed = 0
  try {
    db.transaction(() => {
      for (const ownerId of ownerIds) {
        assertUserDataMutationAllowed(db, ownerId, 'Attachments cannot change while local data is being cleared')
      }
      for (const row of candidates) {
        const changes = requireSnapshotMatch
          ? remove.run(attachmentSnapshotParams(row)).changes
          : remove.run(row.id, row.user_id).changes
        removedById.set(row.id, changes)
        removed += changes
      }
    })()
  } catch (error) {
    restoreQuarantinedFiles(quarantined, error)
    throw error
  }

  const rowStillExists = requireSnapshotMatch
    ? db.prepare('SELECT 1 FROM managed_attachments WHERE id = ? AND user_id = ?')
    : null
  const restoreErrors = []
  for (const item of quarantined) {
    const snapshotMissed = requireSnapshotMatch && removedById.get(item.row.id) === 0
    if (snapshotMissed && rowStillExists.get(item.row.id, item.row.user_id)) {
      try {
        restoreQuarantinedFiles([item])
      } catch (error) {
        restoreErrors.push(error)
      }
    } else {
      safeUnlink(item.tombstone)
    }
  }
  if (restoreErrors.length) {
    throw new AggregateError(restoreErrors, 'Failed to restore attachments whose cleanup snapshot changed')
  }
  return removed
}
