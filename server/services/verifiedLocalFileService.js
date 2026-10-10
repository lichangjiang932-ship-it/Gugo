import fs from 'node:fs'
import path from 'node:path'
import { getMessage } from './sessionStore.js'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'
import { extractVerifiedLocalFiles, recoverLegacyVerifiedLocalFiles } from './turnMessageContext.js'
import { getArtifactDir, isSafeArtifactFilename } from './artifactStorage.js'
import { listTurnArtifacts } from './turnArtifactStore.js'

const MIME_TYPES = Object.freeze({
  '.aac': 'audio/aac',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.eot': 'application/vnd.ms-fontobject',
  '.gif': 'image/gif',
  '.flac': 'audio/flac',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.jfif': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.opus': 'audio/ogg',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
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
  '.xls': 'application/vnd.ms-excel',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
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

function verifiedReceiptList(message, { userId } = {}) {
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

function retainedReceiptList(message) {
  const context = message?.modelContext
  if (!context || typeof context !== 'object' || !Object.hasOwn(context, 'retainedLocalFiles')) return []
  return Array.isArray(context.retainedLocalFiles) ? context.retainedLocalFiles : []
}

/**
 * The copy this app kept of a receipt's file, for when the file itself has been
 * moved or deleted. A delivered file is also published to the artifact store
 * and recorded against the same turn; the receipt names that artifact (or, for
 * older receipts, shares its name), and the copy must have the very byte size
 * the receipt recorded, so a different file of the same name never stands in.
 * The copy is only ever read: opening "in its folder" shows the store's copy.
 */
function storedCopyOfReceipt({ userId, sessionId, turnId, receipt }) {
  const expectedSize = Number(receipt?.size)
  if (!sessionId || !Number.isSafeInteger(expectedSize) || expectedSize < 0) return null
  const related = new Set(Array.isArray(receipt.relatedArtifactIds) ? receipt.relatedArtifactIds.map(String) : [])
  const wantedName = String(receipt.filename || path.basename(String(receipt.path || '')))
  const stem = wantedName.replace(/.[^.]+$/u, '')
  const extension = path.extname(wantedName).toLowerCase()
  const candidates = listTurnArtifacts({ userId, sessionId, turnId }).filter((artifact) => {
    const filename = String(artifact?.filename || '')
    if (!filename || path.extname(filename).toLowerCase() !== extension) return false
    return related.has(String(artifact.id)) || filename === wantedName || filename.startsWith(`${stem}-`)
  })
  const root = getArtifactDir()
  for (const artifact of candidates) {
    if (!isSafeArtifactFilename(artifact.filename)) continue
    const fullPath = path.join(root, artifact.filename)
    let stat
    try { stat = fs.statSync(fullPath) } catch { continue }
    if (!stat.isFile() || stat.size !== expectedSize) continue
    return {
      fullPath,
      filename: wantedName,
      mimeType: localFileMimeType(wantedName),
      size: stat.size,
      etag: `"stored-${encodeURIComponent(String(artifact.id))}-${stat.size}-${Math.floor(stat.mtimeMs)}"`,
      storedCopy: true,
    }
  }
  return null
}

function getReceiptLocalFile({
  userId,
  sessionId,
  turnId,
  fileId,
  receiptKind = 'verified',
} = {}) {
  const retained = receiptKind === 'retained'
  const codePrefix = retained ? 'RETAINED_FILE' : 'VERIFIED_FILE'
  if (!turnId || !fileId) {
    throw serviceError('turnId 和 fileId 必填', 400, `${codePrefix}_ID_REQUIRED`)
  }
  const message = getMessage({ userId, sessionId, messageId: `${turnId}:assistant` })
  const receipt = (retained ? retainedReceiptList(message) : verifiedReceiptList(message, { userId }))
    .find((item) => String(item?.id || '') === String(fileId))
  if (!receipt) throw serviceError('文件链接不存在或无权访问', 404, `${codePrefix}_NOT_FOUND`)
  const receiptPath = String(receipt.path || '').trim()
  if (!path.isAbsolute(receiptPath)) {
    throw serviceError('文件链接无效', 404, `${codePrefix}_PATH_INVALID`)
  }
  // Only a file that is gone falls back to the kept copy; a path the user no
  // longer authorizes is still refused.
  const missing = () => {
    const stored = storedCopyOfReceipt({ userId, sessionId: message?.sessionId || sessionId, turnId, receipt })
    if (stored) return stored
    throw serviceError('原文件已被移动或删除，也没有保存过它的副本', 404, `${codePrefix}_MISSING`)
  }
  let resolved
  try {
    resolved = resolveAuthorizedLocalPath({
      userId,
      rawPath: receiptPath,
      write: false,
      allowWorkspace: true,
    })
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') return missing()
    throw error
  }
  let stat
  try {
    stat = fs.statSync(resolved.fullPath)
  } catch {
    return missing()
  }
  if (!stat.isFile()) throw serviceError('链接目标不是文件', 400, `${codePrefix}_NOT_FILE`)
  const filename = path.basename(resolved.fullPath)
  return {
    fullPath: resolved.fullPath,
    filename,
    mimeType: localFileMimeType(filename),
    size: stat.size,
    etag: `"local-${encodeURIComponent(String(fileId))}-${stat.size}-${Math.floor(stat.mtimeMs)}"`,
  }
}

export function getVerifiedLocalFile(options = {}) {
  return getReceiptLocalFile({ ...options, receiptKind: 'verified' })
}

export function getRetainedLocalFile(options = {}) {
  return getReceiptLocalFile({ ...options, receiptKind: 'retained' })
}
