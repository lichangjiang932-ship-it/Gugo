import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'
import { validateLocalHtmlDelivery } from './localHtmlDeliveryValidation.js'
import { getVerifiedLocalFile, localFileMimeType } from './verifiedLocalFileService.js'

const SESSION_TTL_MS = 30 * 60 * 1_000
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1_000
const MAX_ACTIVE_SESSIONS = 256
const MAX_ACTIVE_SESSIONS_PER_USER = 8
const previewSessions = new Map()

function serviceError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function insideDirectory(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function sweepExpired(now) {
  for (const [ticket, session] of previewSessions) {
    if (session.expiresAt <= now || session.maxExpiresAt <= now) previewSessions.delete(ticket)
  }
}

function normalizedPathKey(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function evictOldestSession(predicate = () => true) {
  for (const [ticket, session] of previewSessions) {
    if (!predicate(session)) continue
    previewSessions.delete(ticket)
    return true
  }
  return false
}

function enforceSessionLimits(userId) {
  let userSessionCount = 0
  for (const session of previewSessions.values()) {
    if (session.userId === userId) userSessionCount += 1
  }
  while (userSessionCount >= MAX_ACTIVE_SESSIONS_PER_USER) {
    if (!evictOldestSession((session) => session.userId === userId)) break
    userSessionCount -= 1
  }
  while (previewSessions.size >= MAX_ACTIVE_SESSIONS) {
    if (!evictOldestSession()) break
  }
}

export async function createLocalHtmlPreviewSession({
  userId,
  sessionId,
  turnId,
  fileId,
  now = Date.now,
} = {}) {
  const file = getVerifiedLocalFile({ userId, sessionId, turnId, fileId })
  if (!/^text\/html(?:;|$)/i.test(file.mimeType)) {
    throw serviceError('只有 HTML 文件可以创建网页预览', 400, 'LOCAL_HTML_PREVIEW_TYPE_REQUIRED')
  }

  const delivery = await validateLocalHtmlDelivery({
    filePath: file.fullPath,
    decodeImages: false,
    resolveReadPath: (candidatePath) => resolveAuthorizedLocalPath({
      userId,
      rawPath: candidatePath,
      write: false,
      allowWorkspace: true,
    }).fullPath,
  })

  const issuedAt = now()
  sweepExpired(issuedAt)
  enforceSessionLimits(userId)
  const ticket = randomBytes(24).toString('base64url')
  const entryPath = fs.realpathSync(delivery.filePath)
  const entryCanonicalKey = normalizedPathKey(entryPath)
  const rootPath = fs.realpathSync(path.dirname(entryPath))
  const allowedRequestPaths = new Set([
    normalizedPathKey(entryPath),
    ...delivery.resources.map((resource) => normalizedPathKey(resource.requestPath || resource.path)),
  ])
  const allowedCanonicalPaths = new Set([
    entryCanonicalKey,
    ...delivery.resources.map((resource) => normalizedPathKey(resource.path)),
  ])
  const frameTargetCanonicalPaths = new Set(delivery.resources
    .filter((resource) => resource.kind === 'html')
    .map((resource) => normalizedPathKey(resource.path)))
  const maxExpiresAt = issuedAt + SESSION_MAX_AGE_MS
  previewSessions.set(ticket, {
    userId,
    rootPath,
    entryCanonicalKey,
    frameTargetCanonicalPaths,
    allowedRequestPaths,
    allowedCanonicalPaths,
    issuedAt,
    expiresAt: Math.min(issuedAt + SESSION_TTL_MS, maxExpiresAt),
    maxExpiresAt,
  })

  return {
    ticket,
    expiresAt: Math.min(issuedAt + SESSION_TTL_MS, maxExpiresAt),
    url: `/api/local-files/previews/${ticket}/${encodeURIComponent(path.basename(entryPath))}`,
  }
}

export function getLocalHtmlPreviewResource({ ticket, resourcePath, now = Date.now } = {}) {
  const checkedAt = now()
  sweepExpired(checkedAt)
  const session = previewSessions.get(String(ticket || ''))
  if (!session) throw serviceError('网页预览已过期，请重新打开文件', 404, 'LOCAL_HTML_PREVIEW_EXPIRED')

  let decodedPath
  try {
    decodedPath = String(resourcePath || '')
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join(path.sep)
  } catch {
    throw serviceError('网页资源路径无效', 400, 'LOCAL_HTML_PREVIEW_PATH_INVALID')
  }
  if (!decodedPath || decodedPath.includes('\0')) {
    throw serviceError('网页资源路径无效', 400, 'LOCAL_HTML_PREVIEW_PATH_INVALID')
  }

  const candidatePath = path.resolve(session.rootPath, decodedPath)
  if (!insideDirectory(session.rootPath, candidatePath)) {
    throw serviceError('网页资源不能超出 HTML 所在目录', 403, 'LOCAL_HTML_PREVIEW_PATH_OUTSIDE_ROOT')
  }
  if (!session.allowedRequestPaths.has(normalizedPathKey(candidatePath))) {
    throw serviceError('网页资源未在 HTML 中声明', 403, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_DECLARED')
  }

  // Re-check the user's current grant for every resource. Revoking a path or
  // all-files access therefore invalidates an already-issued preview ticket.
  const authorized = resolveAuthorizedLocalPath({
    userId: session.userId,
    rawPath: candidatePath,
    write: false,
    allowWorkspace: true,
  })
  let fullPath
  let stat
  try {
    fullPath = fs.realpathSync(authorized.fullPath)
    stat = fs.statSync(fullPath)
  } catch {
    throw serviceError('网页资源不存在或无法读取', 404, 'LOCAL_HTML_PREVIEW_RESOURCE_MISSING')
  }
  if (!insideDirectory(session.rootPath, fullPath)) {
    throw serviceError('网页资源不能通过链接跳出 HTML 所在目录', 403, 'LOCAL_HTML_PREVIEW_SYMLINK_OUTSIDE_ROOT')
  }
  if (!session.allowedCanonicalPaths.has(normalizedPathKey(fullPath))) {
    throw serviceError('网页资源未在 HTML 中声明', 403, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_DECLARED')
  }
  if (!stat.isFile()) throw serviceError('网页资源不是文件', 404, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_FILE')

  session.expiresAt = Math.min(checkedAt + SESSION_TTL_MS, session.maxExpiresAt)
  const filename = path.basename(fullPath)
  const canonicalKey = normalizedPathKey(fullPath)
  return {
    fullPath,
    filename,
    mimeType: localFileMimeType(filename),
    size: stat.size,
    etag: `"local-preview-${ticket}-${stat.size}-${Math.floor(stat.mtimeMs)}"`,
    isEntryDocument: canonicalKey === session.entryCanonicalKey,
    isFrameTarget: session.frameTargetCanonicalPaths.has(canonicalKey),
  }
}

export function isLocalHtmlPreviewTicketActive(ticket, { now = Date.now } = {}) {
  sweepExpired(now())
  return previewSessions.has(String(ticket || ''))
}

export function revokeLocalHtmlPreviewSession({ userId, ticket } = {}) {
  const key = String(ticket || '')
  const session = previewSessions.get(key)
  if (!session || session.userId !== userId) return false
  previewSessions.delete(key)
  return true
}

export function clearLocalHtmlPreviewSessions() {
  previewSessions.clear()
}
