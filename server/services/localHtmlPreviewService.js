import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { resolveAuthorizedLocalPath } from './localFileAccessService.js'
import { validateLocalHtmlDelivery } from './localHtmlDeliveryValidation.js'
import {
  getRetainedLocalFile,
  getVerifiedLocalFile,
  localFileMimeType,
} from './verifiedLocalFileService.js'

const SESSION_TTL_MS = 30 * 60 * 1_000
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1_000
const MAX_ACTIVE_SESSIONS = 256
const MAX_ACTIVE_SESSIONS_PER_USER = 8
const RETAINED_MAX_HTML_BYTES = 16 * 1024 * 1024
const RETAINED_MAX_TEXT_DEPENDENCY_BYTES = 8 * 1024 * 1024
const RETAINED_MAX_RESOURCE_COUNT = 2_000
const TEXT_DEPENDENCY_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.cjs', '.htm', '.html'])
const HTML_EXTENSIONS = new Set(['.htm', '.html'])
const HTML_RESOURCE_ATTRIBUTES = Object.freeze([
  ['audio', 'src', 'media'],
  ['embed', 'src', 'resource'],
  ['iframe', 'src', 'html'],
  ['img', 'src', 'image'],
  ['input[type="image"]', 'src', 'image'],
  ['object', 'data', 'resource'],
  ['script', 'src', 'script'],
  ['source', 'src', 'resource'],
  ['track', 'src', 'resource'],
  ['video', 'src', 'media'],
  ['video', 'poster', 'image'],
  ['svg image', 'href', 'image'],
  ['svg image', 'xlink:href', 'image'],
  ['svg use', 'href', 'resource'],
  ['svg use', 'xlink:href', 'resource'],
])
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

function stripQueryAndFragment(value) {
  const text = String(value || '').trim()
  const marker = text.search(/[?#]/)
  return marker >= 0 ? text.slice(0, marker) : text
}

function srcsetReferences(value) {
  const source = String(value || '').trim()
  if (!source || /^data:/i.test(source)) return []
  return source.split(',').map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean)
}

function cssReferences(source) {
  const clean = String(source || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const references = []
  for (const match of clean.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi)) {
    references.push({ value: match[1] ?? match[2] ?? match[3], kind: 'resource' })
  }
  for (const match of clean.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s)'";]+))(?:\s*\))?/gi)) {
    references.push({ value: match[1] ?? match[2] ?? match[3], kind: 'style' })
  }
  return references
}

function scriptReferences(source) {
  const references = []
  const patterns = [
    [/\b(?:import\s+(?:[^"'();]*?\s+from\s+)?|export\s+[^"'();]*?\s+from\s+)["']([^"']+)["']/gi, 'script'],
    [/\bimport\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi, 'script'],
    [/\bnew\s+URL\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)\s*,\s*import\.meta\.url\b/gi, 'resource'],
    [/\bfetch\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi, 'resource'],
    [/\bnew\s+(?:Worker|SharedWorker)\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi, 'script'],
  ]
  for (const [pattern, kind] of patterns) {
    for (const match of String(source || '').matchAll(pattern)) {
      references.push({ value: match.slice(1).find((candidate) => candidate !== undefined), kind })
    }
  }
  return references
}

function htmlReferences(source) {
  let document
  try {
    document = new JSDOM(String(source || '')).window.document
  } catch {
    return []
  }
  const references = []
  for (const [selector, attribute, kind] of HTML_RESOURCE_ATTRIBUTES) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute)
      if (value) references.push({ value, kind })
    }
  }
  for (const element of document.querySelectorAll('img[srcset], source[srcset]')) {
    const kind = element.closest('picture') ? 'image' : 'resource'
    for (const value of srcsetReferences(element.getAttribute('srcset'))) references.push({ value, kind })
  }
  for (const element of document.querySelectorAll('link[href]')) {
    const rel = String(element.getAttribute('rel') || '').toLowerCase().split(/\s+/)
    const kind = rel.includes('stylesheet') ? 'style'
      : rel.some((value) => ['icon', 'apple-touch-icon', 'mask-icon'].includes(value)) ? 'image'
        : rel.some((value) => ['preload', 'modulepreload', 'manifest'].includes(value)) ? 'resource'
          : null
    if (kind) references.push({ value: element.getAttribute('href'), kind })
  }
  for (const element of document.querySelectorAll('[style]')) {
    references.push(...cssReferences(element.getAttribute('style')))
  }
  for (const element of document.querySelectorAll('style')) references.push(...cssReferences(element.textContent))
  for (const element of document.querySelectorAll('script:not([src])')) {
    references.push(...scriptReferences(element.textContent))
  }
  return references
}

function retainedResourceKind(referenceKind, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (referenceKind === 'style' || extension === '.css') return 'style'
  if (referenceKind === 'script' || ['.js', '.mjs', '.cjs'].includes(extension)) return 'script'
  if (referenceKind === 'html' || HTML_EXTENSIONS.has(extension)) return 'html'
  if (referenceKind === 'image') return 'image'
  return 'resource'
}

function retainedLocalReference(ownerPath, rawValue, rootPath) {
  const value = String(rawValue || '').trim()
  if (!value || value.startsWith('#') || /^(?:data|blob|about|mailto|tel):/i.test(value)) return null
  if (/^(?:https?:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return null
  const withoutSuffix = stripQueryAndFragment(value)
  if (!withoutSuffix) return null
  let decoded
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null
  const candidatePath = path.resolve(path.dirname(ownerPath), ...decoded.split('/'))
  return insideDirectory(rootPath, candidatePath) ? candidatePath : null
}

function authorizedRetainedResource({ userId, rootPath, ownerPath, reference }) {
  const candidatePath = retainedLocalReference(ownerPath, reference.value, rootPath)
  if (!candidatePath) return null
  try {
    const authorized = resolveAuthorizedLocalPath({
      userId,
      rawPath: candidatePath,
      write: false,
      allowWorkspace: true,
    })
    const fullPath = fs.realpathSync(authorized.fullPath)
    const stat = fs.statSync(fullPath)
    if (!insideDirectory(rootPath, fullPath) || !stat.isFile()) return null
    return {
      path: fullPath,
      requestPath: candidatePath,
      kind: retainedResourceKind(reference.kind, fullPath),
      size: stat.size,
    }
  } catch {
    return null
  }
}

function retainedDependencyReferences({ userId, rootPath, resource }) {
  if (!TEXT_DEPENDENCY_EXTENSIONS.has(path.extname(resource.path).toLowerCase())) return []
  if (resource.size > RETAINED_MAX_TEXT_DEPENDENCY_BYTES) return []
  let source
  try {
    const authorized = resolveAuthorizedLocalPath({
      userId,
      rawPath: resource.path,
      write: false,
      allowWorkspace: true,
    })
    const readPath = fs.realpathSync(authorized.fullPath)
    if (!insideDirectory(rootPath, readPath)
      || normalizedPathKey(readPath) !== normalizedPathKey(resource.path)) return []
    const currentStat = fs.statSync(readPath)
    if (!currentStat.isFile() || currentStat.size > RETAINED_MAX_TEXT_DEPENDENCY_BYTES) return []
    source = fs.readFileSync(readPath, 'utf8')
  } catch {
    return []
  }
  if (resource.kind === 'style') return cssReferences(source)
  if (resource.kind === 'script') return scriptReferences(source)
  if (resource.kind === 'html') return htmlReferences(source)
  return []
}

function collectRetainedHtmlDelivery({ userId, filePath }) {
  const authorizedEntry = resolveAuthorizedLocalPath({
    userId,
    rawPath: filePath,
    write: false,
    allowWorkspace: true,
  })
  const entryPath = fs.realpathSync(authorizedEntry.fullPath)
  const entryStat = fs.statSync(entryPath)
  if (!entryStat.isFile()) throw serviceError('网页预览入口不是文件', 400, 'LOCAL_HTML_PREVIEW_ENTRY_NOT_FILE')
  if (entryStat.size > RETAINED_MAX_HTML_BYTES) {
    throw serviceError('网页预览文件过大', 422, 'LOCAL_HTML_PREVIEW_ENTRY_TOO_LARGE')
  }
  const rootPath = fs.realpathSync(path.dirname(entryPath))
  const source = fs.readFileSync(entryPath, 'utf8')
  const queue = htmlReferences(source)
    .slice(0, RETAINED_MAX_RESOURCE_COUNT)
    .map((reference) => ({ ...reference, ownerPath: entryPath }))
  const resources = []
  const seenRequests = new Set()
  const expandedCanonicalPaths = new Set()
  let cursor = 0
  while (cursor < queue.length && cursor < RETAINED_MAX_RESOURCE_COUNT) {
    const item = queue[cursor]
    cursor += 1
    const resource = authorizedRetainedResource({
      userId,
      rootPath,
      ownerPath: item.ownerPath,
      reference: item,
    })
    if (!resource) continue
    const requestKey = `${resource.kind}\0${normalizedPathKey(resource.requestPath)}`
    if (!seenRequests.has(requestKey)) {
      seenRequests.add(requestKey)
      resources.push(resource)
    }
    const canonicalKey = `${resource.kind}\0${normalizedPathKey(resource.path)}`
    if (expandedCanonicalPaths.has(canonicalKey)) continue
    expandedCanonicalPaths.add(canonicalKey)
    for (const reference of retainedDependencyReferences({ userId, rootPath, resource })) {
      if (queue.length >= RETAINED_MAX_RESOURCE_COUNT) break
      queue.push({ ...reference, ownerPath: resource.path })
    }
  }
  return { ok: true, filePath: entryPath, resources }
}

async function resolveHtmlPreviewDelivery({ userId, file, receiptKind }) {
  const validationOptions = {
    filePath: file.fullPath,
    decodeImages: false,
    resolveReadPath: (candidatePath) => resolveAuthorizedLocalPath({
      userId,
      rawPath: candidatePath,
      write: false,
      allowWorkspace: true,
    }).fullPath,
  }
  if (receiptKind !== 'retained') return validateLocalHtmlDelivery(validationOptions)
  try {
    return await validateLocalHtmlDelivery(validationOptions)
  } catch (error) {
    if (error?.htmlDeliveryValidationFailure !== true && error?.code !== 'PATH_NOT_AUTHORIZED') throw error
    return collectRetainedHtmlDelivery({ userId, filePath: file.fullPath })
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

export async function createLocalHtmlPreviewSession({
  userId,
  sessionId,
  turnId,
  fileId,
  receiptKind = 'verified',
  now = Date.now,
} = {}) {
  const getReceiptFile = receiptKind === 'retained'
    ? getRetainedLocalFile
    : getVerifiedLocalFile
  const file = getReceiptFile({ userId, sessionId, turnId, fileId })
  if (!/^text\/html(?:;|$)/i.test(file.mimeType)) {
    throw serviceError('只有 HTML 文件可以创建网页预览', 400, 'LOCAL_HTML_PREVIEW_TYPE_REQUIRED')
  }

  const delivery = await resolveHtmlPreviewDelivery({ userId, file, receiptKind })

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
