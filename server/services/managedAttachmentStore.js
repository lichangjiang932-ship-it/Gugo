import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import {
  assertUserDataMutationAllowed,
  userDataClearInProgress,
} from './userDataClearGuard.js'
import {
  acquireManagedAttachmentUploadLease,
  finalizeManagedAttachmentUploadLease,
  holdManagedAttachmentUploadLease,
  managedAttachmentUploadLeaseDuration,
  releaseManagedAttachmentUploadLease,
} from './managedAttachmentUploadLease.js'

const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ATTACHMENT_COUNT_PER_TURN = 32
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_STALE_UPLOAD_MS = 60 * 60 * 1000
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/vnd.microsoft.icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.rtf': 'application/rtf',
  '.zip': 'application/zip',
})

function attachmentError(message, statusCode = 400, code = 'ATTACHMENT_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function attachmentRoot(env = process.env) {
  const dataDir = path.resolve(String(env.APP_DATA_DIR || DEFAULT_DATA_DIR))
  return path.join(dataDir, 'attachments')
}

function userBucket(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
}

function normalizeAttachmentId(value) {
  const id = String(value || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id)) {
    throw attachmentError('附件 ID 无效', 400, 'INVALID_ATTACHMENT_ID')
  }
  return id
}

export function normalizeAttachmentName(value) {
  const input = String(value || '').normalize('NFC').replace(/[\\]/g, '/')
  const printableName = [...(input.split('/').pop() || '')]
    .map((character) => {
      const code = character.codePointAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
  const name = printableName
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!name || name === '.' || name === '..') {
    throw attachmentError('filename 必填', 400, 'ATTACHMENT_NAME_REQUIRED')
  }
  return name.slice(0, 240)
}

export function normalizeAttachmentMimeType(value) {
  const mimeType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (!mimeType) return 'application/octet-stream'
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
    throw attachmentError('mimeType 无效', 400, 'INVALID_ATTACHMENT_MIME')
  }
  return mimeType.slice(0, 160)
}

function configuredMaxBytes(env = process.env) {
  const parsed = Number(env.ATTACHMENT_MAX_BYTES)
  if (!Number.isSafeInteger(parsed) || parsed < 1024) return DEFAULT_MAX_ATTACHMENT_BYTES
  return Math.min(parsed, 1024 * 1024 * 1024)
}

function configuredUserQuotaBytes(env = process.env) {
  const parsed = Number(env.ATTACHMENT_USER_QUOTA_BYTES)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_USER_QUOTA_BYTES
  return Math.min(parsed, 100 * 1024 * 1024 * 1024)
}

function configuredMaxPerTurn(env = process.env) {
  const parsed = Number(env.ATTACHMENT_MAX_PER_TURN)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return MAX_ATTACHMENT_COUNT_PER_TURN
  return Math.min(parsed, MAX_ATTACHMENT_COUNT_PER_TURN)
}

function configuredDuration(env, key, fallback) {
  const parsed = Number(env?.[key])
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return fallback
  return Math.min(parsed, 365 * 24 * 60 * 60 * 1000)
}

function safeUnlink(fullPath) {
  try {
    fs.unlinkSync(fullPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function fileAgeMs(fullPath, now) {
  try { return Math.max(0, now - fs.statSync(fullPath).mtimeMs) } catch { return Number.POSITIVE_INFINITY }
}

function detectedMimeType(prefix, name) {
  const extMime = MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || null
  if (prefix.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg'
  if (prefix.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'image/gif'
  if (prefix.length >= 2 && prefix.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/vnd.microsoft.icon'
  if (prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brands = prefix.subarray(8).toString('ascii')
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif'
    if (brands.startsWith('M4A ') || brands.startsWith('M4B ')) return 'audio/mp4'
    if (brands.startsWith('qt  ')) return 'video/quicktime'
    return extMime && /^(?:audio|video)\//.test(extMime) ? extMime : 'video/mp4'
  }
  if (prefix.subarray(0, 4).toString('ascii') === 'RIFF') {
    if (prefix.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (prefix.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
    if (prefix.subarray(8, 12).toString('ascii') === 'AVI ') return 'video/x-msvideo'
  }
  if (prefix.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac'
  if (prefix.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg'
  if (prefix.subarray(0, 4).toString('ascii') === 'OggS') {
    return extMime === 'video/ogg' ? extMime : 'audio/ogg'
  }
  if (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1] & 0xf6) === 0xf0) return 'audio/aac'
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return extMime === 'video/webm' ? extMime : 'video/x-matroska'
  }
  if (prefix.subarray(0, 4).toString('binary') === 'PK\u0003\u0004') {
    return extMime === 'application/zip' || extMime?.includes('officedocument')
      ? extMime
      : 'application/zip'
  }
  return null
}

function resolvedMimeType(claimed, prefix, name) {
  const detected = detectedMimeType(prefix, name)
  if (detected) return detected
  if (claimed !== 'application/octet-stream') return claimed
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || claimed
}

function rowPath(row, env = process.env) {
  const root = path.resolve(attachmentRoot(env))
  const fullPath = path.resolve(root, row.storage_path)
  const relative = path.relative(root, fullPath)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw attachmentError('附件存储路径无效', 500, 'ATTACHMENT_STORAGE_INVALID')
  }
  return fullPath
}

function mapAttachment(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    size: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
    sessionId: row.session_id || null,
    messageId: row.message_id || null,
    uri: `attachment://${row.id}`,
    downloadUrl: `/api/attachments/${encodeURIComponent(row.id)}/content`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function deleteCorruptAttachmentMetadata(db, userId, id) {
  db.transaction(() => {
    assertUserDataMutationAllowed(
      db,
      userId,
      'Attachment metadata cannot be repaired while local data is being cleared',
    )
    db.prepare('DELETE FROM managed_attachments WHERE id = ? AND user_id = ?').run(id, userId)
  })()
}

async function writeChunk(file, chunk) {
  let offset = 0
  while (offset < chunk.length) {
    const result = await file.write(chunk, offset, chunk.length - offset)
    if (!result.bytesWritten) throw attachmentError('附件写入中断', 500, 'ATTACHMENT_WRITE_FAILED')
    offset += result.bytesWritten
  }
}

export async function createManagedAttachment({
  userId,
  name,
  mimeType,
  sessionId = null,
  messageId = null,
  source,
  contentLength = null,
  now = Date.now(),
  id = crypto.randomUUID(),
  env = process.env,
  onUploadLeaseAcquired = null,
} = {}) {
  if (!userId) throw attachmentError('userId 必填', 401, 'UNAUTHORIZED')
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw attachmentError('附件内容必填', 400, 'ATTACHMENT_BODY_REQUIRED')
  }
  const safeId = normalizeAttachmentId(id)
  const safeName = normalizeAttachmentName(name)
  const claimedMimeType = normalizeAttachmentMimeType(mimeType)
  let safeSessionId = String(sessionId || '').trim().slice(0, 512) || null
  const safeMessageId = String(messageId || '').trim().slice(0, 512) || null
  const db = getDb()
  assertUserDataMutationAllowed(db, userId, 'Attachments cannot change while local data is being cleared')
  cleanupManagedAttachments({ userId, now, env })
  if (safeSessionId) {
    const session = db.prepare(`
      SELECT user_id FROM sessions
      WHERE token = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(safeSessionId)
    if (session && session.user_id !== userId) {
      throw attachmentError('会话不存在或无权访问', 404, 'ATTACHMENT_SESSION_NOT_FOUND')
    }
  }
  if (safeMessageId) {
    const message = db.prepare(
      'SELECT user_id, session_id FROM messages WHERE id = ?',
    ).get(safeMessageId)
    if (!message || message.user_id !== userId) {
      throw attachmentError('消息不存在或无权访问', 404, 'ATTACHMENT_MESSAGE_NOT_FOUND')
    }
    if (safeSessionId && message.session_id !== safeSessionId) {
      throw attachmentError('消息不属于指定会话', 409, 'ATTACHMENT_SESSION_CONFLICT')
    }
    safeSessionId = message.session_id
  }
  const maxPerTurn = configuredMaxPerTurn(env)
  if (safeMessageId || safeSessionId) {
    const count = safeMessageId
      ? db.prepare(`
          SELECT COUNT(*) AS count FROM managed_attachments
          WHERE user_id = ? AND message_id = ? AND status = 'ready'
        `).get(userId, safeMessageId)?.count
      : db.prepare(`
          SELECT COUNT(*) AS count FROM managed_attachments
          WHERE user_id = ? AND session_id = ? AND message_id IS NULL AND status = 'ready'
        `).get(userId, safeSessionId)?.count
    if ((Number(count) || 0) >= maxPerTurn) {
      throw attachmentError(`单次最多使用 ${maxPerTurn} 个附件`, 409, 'ATTACHMENT_COUNT_EXCEEDED')
    }
  }
  const maxBytes = configuredMaxBytes(env)
  const userQuotaBytes = configuredUserQuotaBytes(env)
  const announcedBytes = Number(contentLength)
  if (Number.isFinite(announcedBytes) && announcedBytes > maxBytes) {
    throw attachmentError(`附件超过 ${maxBytes} 字节限制`, 413, 'ATTACHMENT_TOO_LARGE')
  }

  if (Number.isFinite(announcedBytes) && announcedBytes > 0) {
    const usedBytes = Number(db.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS total
      FROM managed_attachments WHERE user_id = ? AND status = 'ready'
    `).get(userId)?.total) || 0
    if (usedBytes + announcedBytes > userQuotaBytes) {
      throw attachmentError('附件总配额不足，请删除不再需要的附件后重试', 413, 'ATTACHMENT_USER_QUOTA_EXCEEDED')
    }
  }

  const relativePath = path.posix.join(userBucket(userId), safeId)
  const root = attachmentRoot(env)
  const bucketDir = path.join(root, userBucket(userId))
  const finalPath = path.join(root, ...relativePath.split('/'))
  const temporaryPath = `${finalPath}.uploading`
  const uploadLease = acquireManagedAttachmentUploadLease({
    db,
    uploadId: safeId,
    userId,
    leaseMs: managedAttachmentUploadLeaseDuration(env.ATTACHMENT_UPLOAD_LEASE_MS),
  })
  const leaseHold = holdManagedAttachmentUploadLease({ db, lease: uploadLease })

  let file = null
  let total = 0
  let finalPublished = false
  let metadataCommitted = false
  const hash = crypto.createHash('sha256')
  try {
    if (typeof onUploadLeaseAcquired === 'function') {
      await onUploadLeaseAcquired({ uploadId: safeId, userId })
    }
    fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 })
    file = await fs.promises.open(temporaryPath, 'wx', 0o600)
    for await (const value of source) {
      leaseHold.assertActive()
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) {
        throw attachmentError(`附件超过 ${maxBytes} 字节限制`, 413, 'ATTACHMENT_TOO_LARGE')
      }
      hash.update(chunk)
      await writeChunk(file, chunk)
      leaseHold.assertActive()
    }
    if (total === 0) throw attachmentError('附件内容不能为空', 400, 'ATTACHMENT_EMPTY')
    await file.sync()
    await file.close()
    file = null

    const prefix = Buffer.alloc(Math.min(total, 32))
    const descriptor = fs.openSync(temporaryPath, 'r')
    try { fs.readSync(descriptor, prefix, 0, prefix.length, 0) } finally { fs.closeSync(descriptor) }
    const finalMimeType = resolvedMimeType(claimedMimeType, prefix, safeName)
    leaseHold.assertActive()
    await fs.promises.rename(temporaryPath, finalPath)
    finalPublished = true
    const digest = hash.digest('hex')
    finalizeManagedAttachmentUploadLease({
      db,
      lease: uploadLease,
      commit() {
        db.prepare(`
          INSERT INTO managed_attachments
            (id, user_id, session_id, message_id, original_name, mime_type, size_bytes,
             sha256, storage_path, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
        `).run(
          safeId, userId, safeSessionId, safeMessageId, safeName, finalMimeType, total,
          digest, relativePath, now, now,
        )
        const usedBytes = Number(db.prepare(`
          SELECT COALESCE(SUM(size_bytes), 0) AS total
          FROM managed_attachments WHERE user_id = ? AND status = 'ready'
        `).get(userId)?.total) || 0
        if (usedBytes > userQuotaBytes) {
          throw attachmentError('附件总配额不足，请删除不再需要的附件后重试', 413, 'ATTACHMENT_USER_QUOTA_EXCEEDED')
        }
      },
    })
    metadataCommitted = true
    return getManagedAttachment({ userId, id: safeId })
  } catch (error) {
    if (file) {
      try { await file.close() } catch { /* best effort */ }
    }
    try { await fs.promises.unlink(temporaryPath) } catch { /* best effort */ }
    if (finalPublished && !metadataCommitted) {
      try { await fs.promises.unlink(finalPath) } catch { /* best effort */ }
    }
    throw error
  } finally {
    leaseHold.stop()
    try { releaseManagedAttachmentUploadLease({ db, lease: uploadLease }) } catch { /* best effort */ }
  }
}

export function getManagedAttachment({ userId, id, env = process.env } = {}) {
  if (!userId) return null
  const safeId = normalizeAttachmentId(id)
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM managed_attachments WHERE id = ? AND user_id = ?',
  ).get(safeId, userId)
  if (!row) return null
  let fullPath
  try {
    fullPath = rowPath(row, env)
  } catch {
    deleteCorruptAttachmentMetadata(db, userId, safeId)
    throw attachmentError('附件存储记录损坏，已自动清理', 410, 'ATTACHMENT_STORAGE_INVALID')
  }
  if (!fs.existsSync(fullPath)) {
    deleteCorruptAttachmentMetadata(db, userId, safeId)
    throw attachmentError('附件内容不存在', 410, 'ATTACHMENT_CONTENT_MISSING')
  }
  return { ...mapAttachment(row), fullPath }
}

export function listManagedAttachments({ userId, sessionId = null, messageId = null, limit = 100 } = {}) {
  if (!userId) return []
  const clauses = ['user_id = @userId']
  const params = { userId, limit: Math.min(500, Math.max(1, Number(limit) || 100)) }
  if (sessionId) {
    clauses.push('session_id = @sessionId')
    params.sessionId = String(sessionId)
  }
  if (messageId) {
    clauses.push('message_id = @messageId')
    params.messageId = String(messageId)
  }
  return getDb().prepare(`
    SELECT * FROM managed_attachments
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    LIMIT @limit
  `).all(params).map(mapAttachment)
}

export function validateManagedAttachmentsForTurn({ userId, sessionId, attachmentIds, env = process.env } = {}) {
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : [])
    .map((value) => typeof value === 'object' ? value?.id : value)
    .filter(Boolean)
    .map(normalizeAttachmentId))]
  const maxPerTurn = configuredMaxPerTurn(env)
  if (ids.length > maxPerTurn) {
    throw attachmentError(`单次最多使用 ${maxPerTurn} 个附件`, 400, 'ATTACHMENT_COUNT_EXCEEDED')
  }
  if (!ids.length) return []
  const rowsById = new Map(getDb().prepare(`
    SELECT * FROM managed_attachments
    WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
  `).all(userId, ...ids).map((row) => [row.id, row]))
  return ids.map((id) => {
    const row = rowsById.get(id)
    if (!row) throw attachmentError('附件不存在或无权访问', 404, 'ATTACHMENT_NOT_FOUND')
    if (row.status !== 'ready') throw attachmentError('附件尚未就绪', 409, 'ATTACHMENT_NOT_READY')
    if (row.session_id && sessionId && row.session_id !== sessionId) {
      throw attachmentError('附件已属于其他会话', 409, 'ATTACHMENT_SESSION_CONFLICT')
    }
    return mapAttachment(row)
  })
}

export function bindManagedAttachmentsToMessage({ userId, sessionId, messageId, attachmentIds, now = Date.now() } = {}) {
  const db = getDb()
  assertUserDataMutationAllowed(db, userId, 'Attachments cannot change while local data is being cleared')
  const attachments = validateManagedAttachmentsForTurn({ userId, sessionId, attachmentIds })
  if (!attachments.length) return []
  const message = getDb().prepare(
    'SELECT id FROM messages WHERE id = ? AND user_id = ? AND session_id = ?',
  ).get(messageId, userId, sessionId)
  if (!message) throw attachmentError('消息不存在或无权访问', 404, 'ATTACHMENT_MESSAGE_NOT_FOUND')
  db.transaction(() => {
    assertUserDataMutationAllowed(db, userId, 'Attachments cannot change while local data is being cleared')
    for (const attachment of attachments) {
      const row = db.prepare(
        'SELECT message_id FROM managed_attachments WHERE id = ? AND user_id = ?',
      ).get(attachment.id, userId)
      if (row?.message_id && row.message_id !== messageId) {
        throw attachmentError('附件已绑定到其他消息', 409, 'ATTACHMENT_MESSAGE_CONFLICT')
      }
      db.prepare(`
        UPDATE managed_attachments
        SET session_id = ?, message_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(sessionId, messageId, now, attachment.id, userId)
    }
  })()
  return validateManagedAttachmentsForTurn({ userId, sessionId, attachmentIds })
    .map((attachment) => ({ ...attachment, messageId }))
}

function deleteAttachmentRows(rows, { env = process.env } = {}) {
  const candidates = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!candidates.length) return 0
  const db = getDb()
  for (const ownerId of new Set(candidates.map((row) => row.user_id))) {
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
      quarantined.push({ fullPath, tombstone })
    }
    const remove = db.prepare('DELETE FROM managed_attachments WHERE id = ? AND user_id = ?')
    let removed = 0
    db.transaction(() => {
      for (const ownerId of new Set(candidates.map((row) => row.user_id))) {
        assertUserDataMutationAllowed(db, ownerId, 'Attachments cannot change while local data is being cleared')
      }
      for (const row of candidates) removed += remove.run(row.id, row.user_id).changes
    })()
    for (const item of quarantined) safeUnlink(item.tombstone)
    return removed
  } catch (error) {
    for (const item of quarantined.reverse()) {
      try {
        if (fs.existsSync(item.tombstone) && !fs.existsSync(item.fullPath)) {
          fs.renameSync(item.tombstone, item.fullPath)
        }
      } catch { /* best effort rollback */ }
    }
    throw error
  }
}

export function cleanupManagedAttachments({
  userId = null,
  now = Date.now(),
  env = process.env,
  maxRows = 5_000,
} = {}) {
  const db = getDb()
  if (userId && userDataClearInProgress(db, userId)) {
    return { removedRows: 0, removedFiles: 0, skippedForUserDataClear: true }
  }
  const lockedOwners = new Set(db.prepare(`
    SELECT owner_id FROM user_data_clear_operations
  `).all().map((row) => row.owner_id))
  const pendingTtlMs = configuredDuration(env, 'ATTACHMENT_PENDING_TTL_MS', DEFAULT_PENDING_TTL_MS)
  const staleUploadMs = configuredDuration(env, 'ATTACHMENT_STALE_UPLOAD_MS', DEFAULT_STALE_UPLOAD_MS)
  const orphanGraceMs = configuredDuration(env, 'ATTACHMENT_ORPHAN_GRACE_MS', DEFAULT_ORPHAN_GRACE_MS)
  const boundedLimit = Math.min(50_000, Math.max(1, Number(maxRows) || 5_000))
  const rows = (userId
    ? db.prepare('SELECT * FROM managed_attachments WHERE user_id = ? LIMIT ?').all(userId, boundedLimit)
    : db.prepare('SELECT * FROM managed_attachments LIMIT ?').all(boundedLimit))
    .filter((row) => !lockedOwners.has(row.user_id))
  const sessionExists = db.prepare(`
    SELECT 1 FROM sessions
    WHERE token = ? AND user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
  `)
  const staleBefore = now - pendingTtlMs
  const orphanedSessionBefore = now - orphanGraceMs
  const expiredRows = rows.filter((row) => {
    if (row.status !== 'ready') return true
    if (row.message_id == null && Number(row.updated_at) < staleBefore) return true
    // A browser can begin uploading immediately after dispatching NEW_SESSION,
    // before session sync has persisted that token. Keep fresh rows during the
    // same grace period used for disk orphans so concurrent uploads cannot
    // delete one another while the new session is still being created.
    if (
      row.session_id
      && Number(row.updated_at) <= orphanedSessionBefore
      && !sessionExists.get(row.session_id, row.user_id)
    ) return true
    try { return !fs.existsSync(rowPath(row, env)) } catch { return true }
  })
  const removedRows = deleteAttachmentRows(expiredRows, { env })

  const root = path.resolve(attachmentRoot(env))
  // `maxRows` bounds stale-row inspection only. Bucket scanning must compare
  // against every surviving DB row, otherwise a user with more than the
  // inspection limit can lose a valid file as a false "orphan".
  const referencedRows = userId
    ? db.prepare('SELECT storage_path FROM managed_attachments WHERE user_id = ?').all(userId)
    : db.prepare('SELECT storage_path FROM managed_attachments').all()
  const referenced = new Set(referencedRows
    .map((row) => String(row.storage_path).replaceAll('\\', '/')))
  const bucketNames = userId
    ? [userBucket(userId)]
    : (() => {
        try { return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return [] }
      })()
  const lockedBuckets = new Set([...lockedOwners].map(userBucket))
  let removedFiles = 0
  for (const bucketName of bucketNames) {
    if (lockedBuckets.has(bucketName)) continue
    const bucketDir = path.resolve(root, bucketName)
    const relativeBucket = path.relative(root, bucketDir)
    if (!relativeBucket || relativeBucket.startsWith('..') || path.isAbsolute(relativeBucket)) continue
    const entries = (() => {
      try { return fs.readdirSync(bucketDir, { withFileTypes: true }) } catch { return null }
    })()
    if (!entries) continue
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(bucketDir, entry.name)
      const relativePath = path.posix.join(bucketName, entry.name)
      const staleTemporary = (entry.name.includes('.uploading') || entry.name.includes('.deleting-'))
        && fileAgeMs(fullPath, now) >= staleUploadMs
      const orphaned = !entry.name.includes('.uploading')
        && !entry.name.includes('.deleting-')
        && !referenced.has(relativePath)
        && fileAgeMs(fullPath, now) >= orphanGraceMs
      if (staleTemporary || orphaned) {
        if (safeUnlink(fullPath)) removedFiles += 1
      }
    }
    try {
      if (fs.readdirSync(bucketDir).length === 0) fs.rmdirSync(bucketDir)
    } catch { /* bucket is not empty or was removed */ }
  }
  return { removedRows, removedFiles }
}

export function deleteManagedAttachmentsForSession({ userId, sessionId, env = process.env } = {}) {
  if (!userId || !sessionId) return 0
  assertUserDataMutationAllowed(getDb(), userId, 'Attachments cannot change while local data is being cleared')
  const rows = getDb().prepare(
    'SELECT * FROM managed_attachments WHERE user_id = ? AND session_id = ?',
  ).all(userId, String(sessionId))
  return deleteAttachmentRows(rows, { env })
}

export function deleteManagedAttachmentsForUser({ userId, env = process.env } = {}) {
  if (!userId) return 0
  assertUserDataMutationAllowed(getDb(), userId, 'Attachments cannot change while local data is being cleared')
  const rows = getDb().prepare(
    'SELECT * FROM managed_attachments WHERE user_id = ?',
  ).all(userId)
  const removed = deleteAttachmentRows(rows, { env })
  const root = path.resolve(attachmentRoot(env))
  const bucketDir = path.resolve(root, userBucket(userId))
  const relative = path.relative(root, bucketDir)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    fs.rmSync(bucketDir, { recursive: true, force: true })
  }
  return removed
}

export function deleteManagedAttachment({ userId, id, env = process.env } = {}) {
  if (!userId) return false
  assertUserDataMutationAllowed(getDb(), userId, 'Attachments cannot change while local data is being cleared')
  const safeId = normalizeAttachmentId(id)
  const row = getDb().prepare(
    'SELECT * FROM managed_attachments WHERE id = ? AND user_id = ?',
  ).get(safeId, userId)
  if (!row) return false
  return deleteAttachmentRows([row], { env }) === 1
}

export function resolveManagedAttachmentPath({ userId, rawPath, write = false, env = process.env } = {}) {
  const match = String(rawPath || '').trim().match(/^attachment:\/\/([a-zA-Z0-9][a-zA-Z0-9_-]{7,127})$/)
  if (!match) return null
  if (write) throw attachmentError('托管附件是只读资源', 403, 'ATTACHMENT_READ_ONLY')
  const attachment = getManagedAttachment({ userId, id: match[1], env })
  if (!attachment) throw attachmentError('附件不存在或无权访问', 404, 'ATTACHMENT_NOT_FOUND')
  return {
    fullPath: attachment.fullPath,
    displayPath: attachment.uri,
    source: 'attachment',
    rootPath: path.dirname(attachment.fullPath),
    attachmentId: attachment.id,
    attachment,
  }
}

export const MANAGED_ATTACHMENT_LIMITS = Object.freeze({
  defaultMaxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
  defaultUserQuotaBytes: DEFAULT_USER_QUOTA_BYTES,
  maxPerTurn: MAX_ATTACHMENT_COUNT_PER_TURN,
  pendingTtlMs: DEFAULT_PENDING_TTL_MS,
  staleUploadMs: DEFAULT_STALE_UPLOAD_MS,
  orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
})
