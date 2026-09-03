import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getArtifactDir } from './artifactStorage.js'
import { getHtmlArtifactAsset, htmlArtifactAssetIds } from './htmlArtifactAssets.js'
import { getArtifactById, listArtifactsByFilename } from './jobStore.js'
import { getTurnArtifactByIdForUser, listTurnArtifactsByFilename } from './turnArtifactStore.js'
import { htmlPreviewRemoteImageOrigins } from './htmlPreviewRemoteImagePolicy.js'

const SESSION_TTL_MS = 10 * 60 * 1_000
const SESSION_MAX_AGE_MS = 60 * 60 * 1_000
const MAX_ACTIVE_SESSIONS = 128
const MAX_ACTIVE_SESSIONS_PER_USER = 8
const MAX_HTML_BYTES = 16 * 1024 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const previewSessions = new Map()

export function artifactHtmlPreviewCsp(env = process.env) {
  const remoteImageSources = htmlPreviewRemoteImageOrigins(env).join(' ')
  return [
    'sandbox allow-scripts',
    "frame-ancestors 'self'",
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
    `img-src 'self' data: blob:${remoteImageSources ? ` ${remoteImageSources}` : ''}`,
    "media-src 'self' data: blob:",
    'font-src data:',
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join('; ')
}

export const ARTIFACT_HTML_PREVIEW_CSP = artifactHtmlPreviewCsp({})

function previewError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function normalizedPathKey(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function hashFileDescriptor(fileDescriptor, size) {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)))
  let offset = 0
  while (offset < size) {
    const bytesRead = fs.readSync(
      fileDescriptor,
      chunk,
      0,
      Math.min(chunk.length, size - offset),
      offset,
    )
    if (bytesRead < 1) {
      throw previewError('网页资源读取不完整', 409, 'ARTIFACT_HTML_PREVIEW_RESOURCE_CHANGED')
    }
    hash.update(chunk.subarray(0, bytesRead))
    offset += bytesRead
  }
  return hash.digest('hex')
}

function fileStatFingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

function insideDirectory(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath)
  return relative !== '' && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative)
}

function sweepExpired(now) {
  for (const [ticket, session] of previewSessions) {
    if (session.expiresAt <= now || session.maxExpiresAt <= now) previewSessions.delete(ticket)
  }
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

function normalizeArtifactSelector(value) {
  const selector = String(value || '').trim()
  if (!selector || selector.length > 512 || selector.includes('\0')
    || selector.includes('/') || selector.includes('\\')) {
    throw previewError('产物标识无效', 400, 'ARTIFACT_HTML_PREVIEW_SELECTOR_INVALID')
  }
  return selector
}

function findOwnedArtifact({ selector, userId }) {
  const idCandidates = [
    getArtifactById(selector),
    getTurnArtifactByIdForUser({ id: selector, userId }),
  ].filter(Boolean)
  const byId = idCandidates.find((artifact) => artifact.userId === userId)
  if (byId) return byId
  const filenameCandidates = [
    ...listArtifactsByFilename(selector),
    ...listTurnArtifactsByFilename(selector),
  ]
  if (filenameCandidates.some((artifact) => artifact.userId !== userId)) return null
  return filenameCandidates.find((artifact) => artifact.userId === userId) || null
}

function filenameHasCrossUserClaim(artifact) {
  const filename = String(artifact?.filename || '')
  if (!filename) return true
  return [
    ...listArtifactsByFilename(filename),
    ...listTurnArtifactsByFilename(filename),
  ].some((candidate) => candidate.userId !== artifact.userId)
}

function assertManagedHtmlArtifact({ selector, userId }) {
  const artifact = findOwnedArtifact({ selector, userId })
  if (!artifact) {
    throw previewError('HTML 产物不存在或无权访问', 404, 'ARTIFACT_HTML_PREVIEW_NOT_FOUND')
  }
  if (filenameHasCrossUserClaim(artifact)) {
    throw previewError('HTML 产物不存在或无权访问', 404, 'ARTIFACT_HTML_PREVIEW_NOT_FOUND')
  }
  const extension = path.extname(String(artifact.filename || '')).toLowerCase()
  if (String(artifact.type || '').toLowerCase() !== 'html' || !['.html', '.htm'].includes(extension)) {
    throw previewError('只有托管 HTML 产物可以创建网页预览', 400, 'ARTIFACT_HTML_PREVIEW_TYPE_REQUIRED')
  }
  return artifact
}

function readManagedHtml(artifact) {
  const filename = String(artifact.filename || '')
  if (!filename || filename !== path.basename(filename)) {
    throw previewError('HTML 产物路径无效', 409, 'ARTIFACT_HTML_PREVIEW_PATH_INVALID')
  }
  let rootPath
  let fullPath
  let stat
  try {
    rootPath = fs.realpathSync(getArtifactDir())
    fullPath = fs.realpathSync(path.resolve(rootPath, filename))
    stat = fs.statSync(fullPath)
  } catch {
    throw previewError('HTML 产物文件不可用', 404, 'ARTIFACT_HTML_PREVIEW_FILE_MISSING')
  }
  if (!insideDirectory(rootPath, fullPath) || !stat.isFile()) {
    throw previewError('HTML 产物路径无效', 409, 'ARTIFACT_HTML_PREVIEW_PATH_INVALID')
  }
  if (stat.size > MAX_HTML_BYTES) {
    throw previewError('HTML 产物超过托管预览大小限制', 413, 'ARTIFACT_HTML_PREVIEW_TOO_LARGE')
  }
  try {
    return fs.readFileSync(fullPath, 'utf8')
  } catch {
    throw previewError('HTML 产物文件不可用', 404, 'ARTIFACT_HTML_PREVIEW_FILE_MISSING')
  }
}

function collectDeclaredAssets({ artifact, html }) {
  let assetIds
  try {
    assetIds = htmlArtifactAssetIds(html)
  } catch {
    throw previewError('HTML 产物内容无法解析', 409, 'ARTIFACT_HTML_PREVIEW_DOCUMENT_INVALID')
  }
  const assets = new Map()
  for (const assetId of assetIds) {
    let asset
    try {
      asset = getHtmlArtifactAsset({
        artifactDirectory: getArtifactDir(),
        artifactId: artifact.id,
        assetId,
      })
    } catch {
      throw previewError('HTML 产物声明的资源不可用', 409, 'ARTIFACT_HTML_PREVIEW_ASSET_INVALID')
    }
    if (!asset) {
      throw previewError('HTML 产物声明的资源不存在', 409, 'ARTIFACT_HTML_PREVIEW_ASSET_MISSING')
    }
    let fileDescriptor
    let statFingerprint
    try {
      fileDescriptor = fs.openSync(asset.fullPath, 'r')
      const stat = fs.fstatSync(fileDescriptor, { bigint: true })
      const size = Number(stat.size)
      if (!stat.isFile() || !Number.isSafeInteger(size) || size !== asset.size
        || hashFileDescriptor(fileDescriptor, size) !== asset.sha256) {
        throw previewError('HTML 产物声明的资源完整性校验失败', 409, 'ARTIFACT_HTML_PREVIEW_ASSET_INVALID')
      }
      statFingerprint = fileStatFingerprint(stat)
    } catch (error) {
      if (error?.code === 'ARTIFACT_HTML_PREVIEW_ASSET_INVALID') throw error
      throw previewError('HTML 产物声明的资源不可用', 409, 'ARTIFACT_HTML_PREVIEW_ASSET_INVALID')
    } finally {
      if (fileDescriptor !== undefined) {
        try { fs.closeSync(fileDescriptor) } catch { /* already unavailable */ }
      }
    }
    assets.set(assetId, {
      ...asset,
      canonicalPathKey: normalizedPathKey(asset.fullPath),
      statFingerprint,
    })
  }
  return assets
}

function rewriteManagedAssetUrls(html, assets) {
  let rewritten = String(html || '')
  for (const assetId of assets.keys()) {
    rewritten = rewritten.replaceAll(
      `gugo-asset://${assetId}`,
      `./assets/${encodeURIComponent(assetId)}`,
    )
  }
  return rewritten
}

function activeSession(ticket, now) {
  sweepExpired(now)
  const session = previewSessions.get(String(ticket || ''))
  if (!session) {
    throw previewError('网页预览已过期，请重新打开产物', 404, 'ARTIFACT_HTML_PREVIEW_EXPIRED')
  }
  session.expiresAt = Math.min(now + SESSION_TTL_MS, session.maxExpiresAt)
  return session
}

export function createArtifactHtmlPreviewSession({ userId, artifactSelector, now = Date.now } = {}) {
  if (!userId) throw previewError('请先登录', 401, 'UNAUTHORIZED')
  const selector = normalizeArtifactSelector(artifactSelector)
  const artifact = assertManagedHtmlArtifact({ selector, userId })
  const html = readManagedHtml(artifact)
  const assets = collectDeclaredAssets({ artifact, html })
  const issuedAt = now()
  sweepExpired(issuedAt)
  enforceSessionLimits(userId)

  const ticket = randomBytes(24).toString('base64url')
  const maxExpiresAt = issuedAt + SESSION_MAX_AGE_MS
  const expiresAt = Math.min(issuedAt + SESSION_TTL_MS, maxExpiresAt)
  previewSessions.set(ticket, {
    artifactId: artifact.id,
    userId,
    assets,
    html: Buffer.from(rewriteManagedAssetUrls(html, assets), 'utf8'),
    issuedAt,
    expiresAt,
    maxExpiresAt,
  })
  return {
    ticket,
    expiresAt,
    url: `/api/artifacts/previews/${ticket}/index.html`,
  }
}

export function getArtifactHtmlPreviewDocument({ ticket, now = Date.now } = {}) {
  const session = activeSession(ticket, now())
  return {
    artifactId: session.artifactId,
    body: session.html,
    mimeType: 'text/html; charset=utf-8',
    size: session.html.length,
  }
}

export function getArtifactHtmlPreviewAsset({ ticket, assetId, now = Date.now } = {}) {
  const session = activeSession(ticket, now())
  const id = String(assetId || '')
  if (!ASSET_ID_PATTERN.test(id)) {
    throw previewError('网页资源路径无效', 404, 'ARTIFACT_HTML_PREVIEW_RESOURCE_NOT_FOUND')
  }
  const asset = session.assets.get(id)
  if (!asset) {
    throw previewError('网页资源未在 HTML 中声明', 404, 'ARTIFACT_HTML_PREVIEW_RESOURCE_NOT_FOUND')
  }
  let fullPath
  let fileDescriptor
  try {
    fullPath = fs.realpathSync(asset.fullPath)
    fileDescriptor = fs.openSync(fullPath, 'r')
    const stat = fs.fstatSync(fileDescriptor, { bigint: true })
    const size = Number(stat.size)
    const statFingerprint = fileStatFingerprint(stat)
    if (normalizedPathKey(fullPath) !== asset.canonicalPathKey || !stat.isFile()
      || !Number.isSafeInteger(size) || size !== asset.size
      || (statFingerprint !== asset.statFingerprint
        && hashFileDescriptor(fileDescriptor, size) !== asset.sha256)) {
      throw previewError('网页资源在预览期间发生变化', 409, 'ARTIFACT_HTML_PREVIEW_RESOURCE_CHANGED')
    }
    asset.statFingerprint = statFingerprint
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor) } catch { /* already unavailable */ }
    }
    if (error?.code === 'ARTIFACT_HTML_PREVIEW_RESOURCE_CHANGED') throw error
    throw previewError('网页资源不存在或无法读取', 404, 'ARTIFACT_HTML_PREVIEW_RESOURCE_MISSING')
  }
  return {
    artifactId: session.artifactId,
    fileDescriptor,
    fullPath,
    filename: asset.filename,
    mimeType: asset.mimeType,
    size: asset.size,
    etag: `"artifact-preview-${asset.sha256}"`,
  }
}

export function revokeArtifactHtmlPreviewSession({ userId, ticket, now = Date.now } = {}) {
  sweepExpired(now())
  const key = String(ticket || '')
  const session = previewSessions.get(key)
  if (!session || session.userId !== userId) return false
  previewSessions.delete(key)
  return true
}

export function isArtifactHtmlPreviewTicketActive(ticket, { now = Date.now } = {}) {
  sweepExpired(now())
  return previewSessions.has(String(ticket || ''))
}

export function clearArtifactHtmlPreviewSessions() {
  previewSessions.clear()
}
