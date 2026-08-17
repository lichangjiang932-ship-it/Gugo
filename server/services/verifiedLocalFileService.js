import fs from 'node:fs'
import path from 'node:path'
import { getMessage } from './sessionStore.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'
import { extractVerifiedLocalFiles, recoverLegacyVerifiedLocalFiles } from './turnMessageContext.js'

const MIME_TYPES = Object.freeze({
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
})

export function localFileMimeType(filename = '') {
  return MIME_TYPES[path.extname(String(filename)).toLowerCase()] || 'application/octet-stream'
}

function serviceError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function receiptList(message, { userId } = {}) {
  const context = message?.modelContext
  if (!context || typeof context !== 'object') return []
  if (Object.hasOwn(context, 'verifiedLocalFiles')) {
    return Array.isArray(context.verifiedLocalFiles) ? context.verifiedLocalFiles : []
  }
  // Legacy completed turns can be upgraded without trusting assistant prose:
  // require the same stored successful mutation + complete readback evidence
  // used for new receipts. The path is authorized again below before reading.
  const options = {
    userId,
    verifiedAt: context.turnCompletedAt || message.updatedAt || message.createdAt,
  }
  const verifiedLocalFiles = extractVerifiedLocalFiles(context.toolTrace, options)
  return verifiedLocalFiles.length > 0
    ? verifiedLocalFiles
    : recoverLegacyVerifiedLocalFiles(context.toolTrace, options)
}

export function getVerifiedLocalFile({ userId, sessionId, turnId, fileId } = {}) {
  if (!turnId || !fileId) {
    throw serviceError('turnId 和 fileId 必填', 400, 'VERIFIED_FILE_ID_REQUIRED')
  }
  const message = getMessage({ userId, sessionId, messageId: `${turnId}:assistant` })
  const receipt = receiptList(message, { userId })
    .find((item) => String(item?.id || '') === String(fileId))
  if (!receipt) throw serviceError('文件链接不存在或无权访问', 404, 'VERIFIED_FILE_NOT_FOUND')
  const receiptPath = String(receipt.path || '').trim()
  if (!path.isAbsolute(receiptPath)) {
    throw serviceError('文件链接无效', 404, 'VERIFIED_FILE_PATH_INVALID')
  }
  const resolved = resolveAuthorizedLocalPath({
    userId,
    rawPath: receiptPath,
    write: false,
    allowWorkspace: true,
  })
  let stat
  try {
    stat = fs.statSync(resolved.fullPath)
  } catch {
    throw serviceError('文件不存在或无法读取', 404, 'VERIFIED_FILE_MISSING')
  }
  if (!stat.isFile()) throw serviceError('链接目标不是文件', 400, 'VERIFIED_FILE_NOT_FILE')
  const filename = path.basename(resolved.fullPath)
  return {
    fullPath: resolved.fullPath,
    filename,
    mimeType: localFileMimeType(filename),
    size: stat.size,
    etag: `"local-${encodeURIComponent(String(fileId))}-${stat.size}-${Math.floor(stat.mtimeMs)}"`,
  }
}
