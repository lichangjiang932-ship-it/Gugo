import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const DEFAULT_USER_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT_PER_TURN = 32
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_STALE_UPLOAD_MS = 60 * 60 * 1000
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000
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

export function attachmentError(message, statusCode = 400, code = 'ATTACHMENT_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

export function attachmentRoot(env = process.env) {
  const dataDir = path.resolve(String(env.APP_DATA_DIR || DEFAULT_DATA_DIR))
  return path.join(dataDir, 'attachments')
}

export function userBucket(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)
}

export function normalizeAttachmentId(value) {
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

export function configuredMaxBytes(env = process.env) {
  const parsed = Number(env.ATTACHMENT_MAX_BYTES)
  if (!Number.isSafeInteger(parsed) || parsed < 1024) return DEFAULT_MAX_ATTACHMENT_BYTES
  return Math.min(parsed, 1024 * 1024 * 1024)
}

export function configuredUserQuotaBytes(env = process.env) {
  const parsed = Number(env.ATTACHMENT_USER_QUOTA_BYTES)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_USER_QUOTA_BYTES
  return Math.min(parsed, 100 * 1024 * 1024 * 1024)
}

export function configuredMaxPerTurn(env = process.env) {
  const parsed = Number(env.ATTACHMENT_MAX_PER_TURN)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return MAX_ATTACHMENT_COUNT_PER_TURN
  return Math.min(parsed, MAX_ATTACHMENT_COUNT_PER_TURN)
}

export function configuredDuration(env, key, fallback) {
  const parsed = Number(env?.[key])
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return fallback
  return Math.min(parsed, 365 * 24 * 60 * 60 * 1000)
}

export function safeUnlink(fullPath) {
  try {
    fs.unlinkSync(fullPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function fileAgeMs(fullPath, now) {
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

export function resolvedMimeType(claimed, prefix, name) {
  const detected = detectedMimeType(prefix, name)
  if (detected) return detected
  if (claimed !== 'application/octet-stream') return claimed
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || claimed
}

export function rowPath(row, env = process.env) {
  const root = path.resolve(attachmentRoot(env))
  const fullPath = path.resolve(root, row.storage_path)
  const relative = path.relative(root, fullPath)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw attachmentError('附件存储路径无效', 500, 'ATTACHMENT_STORAGE_INVALID')
  }
  return fullPath
}

export function mapAttachment(row) {
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
