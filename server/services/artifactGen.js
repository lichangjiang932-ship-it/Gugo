/**
 * G1: 服务端真实生成 PPT/Word/Excel — 模型 tool_call → 服务端 zip → 返回下载链接.
 *
 * Premium PPT pipeline (refactored):
 *   - 跨端安全字体（Calibri/Calibri Light）— 不再依赖 Aptos（仅 Win11 + 新版 Office 365 内置）
 *   - 内容感知 layout 选择（cover / section / kpi / statement / split / process / chart / bullets / end）
 *   - cover 用 deck title（而不是 slide[0].title）
 *   - bullets 自动截断长度，避免 fit:shrink 救到 7pt 不可读
 *   - 真实 chart 支持（pptxgenjs addChart：bar/line/pie），不再"高级 PPT 全是 bullet"
 *   - 真实 KPI 数据卡（结构化数字 + label + delta）
 *   - decor 的 transparency 数值修正语义（pptxgenjs 里 transparency=0 不透明、100 全透）
 *
 * MVP 范围:
 *   - create_pptx({ title, subtitle?, theme?, slides: [{ title, layout?, bullets?, kpi?, chart?, quote? ... }] })   → .pptx
 *   - create_docx({ title, paragraphs })                                                                            → .docx
 *   - create_xlsx({ title, sheets })                                                                                → .xlsx
 *
 * 支持:授权本地/附件图片真实嵌入 PPTX/DOCX/XLSX；暂不做字体内嵌。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import * as fontkit from 'fontkit'
import { PDFDocument, rgb } from 'pdf-lib'
import { getArtifactByFilename } from './jobStore.js'
import { getTurnArtifactByFilename } from './turnArtifactStore.js'
import { htmlArtifactAssetIds } from './htmlArtifactAssets.js'
import {
  htmlPreviewRemoteImageOrigins,
  maskAllowedHtmlPreviewRemoteImages,
} from './htmlPreviewRemoteImagePolicy.js'
import { officeImageSize, prepareOfficeArtifactImages } from './officeArtifactImages.js'
import { buildDocxArtifactBuffer } from './docxArtifactFormat.js'
import { buildPptxArtifactBuffer } from './pptxArtifactFormat.js'
import { buildXlsxArtifactBuffer } from './xlsxArtifactFormat.js'
import { snapshotXlsxSheets } from './xlsxArtifactContract.js'
import { writeGeneratedArtifactAtomically } from './artifactAtomicWriter.js'
import { removeOwnedFailedPublication } from './artifactPublicationCleanup.js'
import {
  ARTIFACT_DIR,
  ensureArtifactDir,
  isSafeArtifactFilename,
  replaceUnsafeFilenameCharacters,
} from './artifactStorage.js'
const PDF_CJK_FONT_PATH = fileURLToPath(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url))
const pdfLibFontkit = {
  create(...args) {
    const font = fontkit.create(...args)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset()
      subset.encodeStream = () => Readable.from([subset.encode()])
      return subset
    }
    return font
  },
}

const ARTIFACT_FALLBACK_NAMES = Object.freeze({
  pptx: 'presentation',
  docx: 'document',
  xlsx: 'spreadsheet',
  pdf: 'document',
  html: 'webpage',
  png: 'image',
  jpg: 'image',
  webp: 'image',
})

function cleanArtifactTitle(title, ext) {
  const fallback = ARTIFACT_FALLBACK_NAMES[ext] || 'artifact'
  let value = String(title || fallback)
    .normalize('NFKC')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:tool[_ -]?call|create_(?:pptx|docx|xlsx))\b[\s\S]*$/i, ' ')
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/^(?:请|請|帮我|幫我|请帮我|請幫我|please\s+)?(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個|a|an)?\s*/i, '')
    .replace(/^(?:基于|基於|根据|根據)(?:已获取的|已取得的|上述|以上)?\s*/i, '')
    .replace(/(?:现在|現在|并|並|然后|然後)?\s*(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個)?\s*(?:PPTX?|Word|DOCX?|Excel|XLSX?|文档|文件|文檔|檔案|演示文稿|簡報|表格)?\s*$/i, '')
  value = replaceUnsafeFilenameCharacters(value)
    .replace(/[，。；：！？、,;:!]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')

  value = Array.from(value || fallback).slice(0, 64).join('').replace(/[.\s_-]+$/g, '') || fallback
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `file-${value}`
  return value
}

export function buildArtifactFilename(title, extension) {
  const ext = String(extension || '').replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('invalid artifact extension')
  return `${cleanArtifactTitle(title, ext)}.${ext}`
}

function artifactNameExists(filename) {
  if (fs.existsSync(path.join(ensureArtifactDir(), filename))) return true
  try {
    return !!(getArtifactByFilename(filename) || getTurnArtifactByFilename(filename))
  } catch {
    return false
  }
}

function writeNewArtifact(title, ext, contents, encoding = null) {
  const id = crypto.randomBytes(8).toString('hex')
  const preferred = buildArtifactFilename(title, ext)
  const { filename, fullPath } = writeGeneratedArtifactAtomically({
    artifactDirectory: ensureArtifactDir(),
    preferredFilename: preferred,
    contents,
    encoding,
    filenameExists: artifactNameExists,
  })
  return { id, filename, fullPath, url: `/api/artifacts/${encodeURIComponent(filename)}` }
}

export function createImageArtifact({ title = 'generated-image', buffer, mimeType = 'image/png' } = {}) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  const bytes = Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('image buffer is empty')
  const artifactPath = writeNewArtifact(title, extension, bytes)
  return { ...artifactPath, type: 'image', title: String(title || 'generated-image').slice(0, 200) }
}

export const MAX_HTML_ARTIFACT_BYTES = 2 * 1024 * 1024
const HTML_FENCE = /^\s*```(?:html)?\s*([\s\S]*?)\s*```\s*$/i
const HTML_LOCAL_RESOURCE_REFERENCE = /(?:\b(?:src|poster)\s*=\s*["']\s*|\burl\s*\(\s*["']?\s*|["'`])(?:file:\/\/{0,2}|[a-z]:[\\/]|\\\\[^\\\s"'`]+\\)/i
const HTML_REMOTE_RESOURCE_REFERENCE = /(?:\b(?:src|srcset|poster|data|background)\s*=\s*["']?\s*|\burl\s*\(\s*["']?\s*|@import\s+(?:url\s*\(\s*)?["']?\s*)(?:https?:|wss?:|ftp:|\/\/)/i
const HTML_REMOTE_LINK_REFERENCE = /<(?:link|base)\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:|wss?:|ftp:|\/\/)/i
const HTML_FORM_SUBMISSION = /<(?:form\b[^>]*\baction|(?:button|input)\b[^>]*\bformaction)\s*=/i
const HTML_META_REFRESH = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh\b/i
const HTML_NETWORK_API_CALL = /(?:\b(?:fetch|sendBeacon)\s*\(|\[\s*["'](?:fetch|sendBeacon)["']\s*\]\s*\(|\b(?:new\s+)?(?:XMLHttpRequest|WebSocket|EventSource|WebTransport)\s*\()/i

function normalizeHtmlArtifactSource(value) {
  const raw = String(value || '')
  const fenced = raw.match(HTML_FENCE)
  return (fenced ? fenced[1] : raw).trim()
}

function newArtifactPathForFilename(requestedFilename) {
  ensureArtifactDir()
  const preferred = String(requestedFilename || '').normalize('NFC').trim()
  if (!isSafeArtifactFilename(preferred)) throw new Error('invalid local artifact filename')
  const parsed = path.parse(preferred)
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const filename = suffix === 1 ? preferred : `${parsed.name}-${suffix}${parsed.ext}`
    if (artifactNameExists(filename)) continue
    const fullPath = path.join(ARTIFACT_DIR, filename)
    try {
      const fd = fs.openSync(fullPath, 'wx')
      fs.closeSync(fd)
      return {
        id: crypto.randomBytes(8).toString('hex'),
        filename,
        fullPath,
        url: `/api/artifacts/${encodeURIComponent(filename)}`,
      }
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('could not allocate a unique local artifact filename')
}

function stableLocalArtifactPath(requestedFilename, publicationKey) {
  ensureArtifactDir()
  const preferred = String(requestedFilename || '').normalize('NFC').trim()
  if (!isSafeArtifactFilename(preferred)) throw new Error('invalid local artifact filename')
  const key = String(publicationKey || '').trim()
  if (!key) throw new Error('local artifact publication key is required')
  const digest = crypto.createHash('sha256').update(key).digest('hex')
  const parsed = path.parse(preferred)
  const suffix = `-${digest.slice(0, 20)}`
  const reserved = `${suffix}${parsed.ext}`
  const maxStemLength = Math.max(1, 240 - reserved.length)
  const maxStemBytes = Math.max(1, 240 - Buffer.byteLength(reserved, 'utf8'))
  let stem = ''
  for (const character of Array.from(parsed.name)) {
    const candidate = `${stem}${character}`
    if (candidate.length > maxStemLength || Buffer.byteLength(candidate, 'utf8') > maxStemBytes) break
    stem = candidate
  }
  stem = stem.replace(/[.\s]+$/g, '') || 'artifact'
  const filename = `${stem}${suffix}${parsed.ext}`
  return {
    id: `local-${digest}`,
    filename,
    fullPath: path.join(ARTIFACT_DIR, filename),
    url: `/api/artifacts/${encodeURIComponent(filename)}`,
    publicationKey: key,
  }
}

const LOCAL_ARTIFACT_LINK_FALLBACK_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
])
const LOCAL_ARTIFACT_LOCK_STALE_MS = 30_000
const LOCAL_ARTIFACT_LOCK_WAIT_MS = 3_000
const LOCAL_ARTIFACT_LOCK_OWNER_VERSION = 2
const LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION = 1
const LOCAL_ARTIFACT_PUBLICATION_MARKER_VERSION = 1
const LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR = '.artifact-publications'

function artifactPublicationError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.retryable = true
  return error
}

async function publishedLocalArtifactStat(fullPath) {
  try {
    const stat = await fs.promises.lstat(fullPath)
    if (!stat.isFile()) {
      throw artifactPublicationError(
        'ARTIFACT_PUBLICATION_INVALID_TARGET',
        'The managed artifact path exists but is not a regular file.',
      )
    }
    return stat
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function localProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function artifactPublicationAttemptRecordPath(digest, attemptId, phase) {
  const directory = path.join(ensureArtifactDir(), LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR)
  return path.join(directory, `.${digest}-${attemptId}.${phase}.json`)
}

function artifactPublicationStagingPath(digest, attemptId) {
  return path.join(ARTIFACT_DIR, `.publish-${digest.slice(0, 20)}-${attemptId}.tmp`)
}

function publicationLockOwner({ digest, marker, attemptId }) {
  return {
    version: LOCAL_ARTIFACT_LOCK_OWNER_VERSION,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
    attemptId,
    publicationDigest: digest,
    artifactId: marker.artifactId,
    filename: marker.filename,
    contentSha256: marker.contentSha256,
    size: marker.size,
    stagingFilename: path.basename(artifactPublicationStagingPath(digest, attemptId)),
  }
}

function assertPublicationLockOwner(owner, { digest, marker }) {
  const valid = owner
    && owner.version === LOCAL_ARTIFACT_LOCK_OWNER_VERSION
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.hostname === 'string'
    && owner.hostname.length > 0
    && Number.isFinite(owner.createdAt)
    && /^[a-f0-9]{32}$/u.test(String(owner.attemptId || ''))
    && owner.publicationDigest === digest
    && owner.artifactId === marker.artifactId
    && owner.filename === marker.filename
    && owner.contentSha256 === marker.contentSha256
    && owner.size === marker.size
    && owner.stagingFilename === path.basename(artifactPublicationStagingPath(digest, owner.attemptId))
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'The stale artifact publication lock does not match this publication identity.',
    )
  }
  return owner
}

async function readJsonFileWithIdentity(filePath) {
  let handle = null
  try {
    const pathIdentity = await fs.promises.lstat(filePath, { bigint: true })
    if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()) return null
    handle = await fs.promises.open(filePath, 'r')
    const openedIdentity = await handle.stat({ bigint: true })
    if (!sameFileIdentity(pathIdentity, openedIdentity)) return null
    const contents = await handle.readFile()
    const readIdentity = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(openedIdentity, readIdentity)) return null
    const value = JSON.parse(contents.toString('utf8'))
    const currentIdentity = await fs.promises.lstat(filePath, { bigint: true })
    if (!sameFileIdentity(currentIdentity, readIdentity)) return null
    return { value, identity: readIdentity, contents }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  } finally {
    try { await handle?.close() } catch { /* best-effort record close */ }
  }
}

function attemptRecord({ phase, owner, identity }) {
  return {
    version: LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION,
    phase,
    attemptId: owner.attemptId,
    publicationDigest: owner.publicationDigest,
    artifactId: owner.artifactId,
    filename: owner.filename,
    contentSha256: owner.contentSha256,
    size: owner.size,
    fileIdentity: serializeFileIdentity(identity),
  }
}

function assertAttemptRecord(record, { phase, owner }) {
  const valid = record
    && record.version === LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION
    && record.phase === phase
    && record.attemptId === owner.attemptId
    && record.publicationDigest === owner.publicationDigest
    && record.artifactId === owner.artifactId
    && record.filename === owner.filename
    && record.contentSha256 === owner.contentSha256
    && record.size === owner.size
    && validSerializedFileIdentity(record.fileIdentity)
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      `The stale artifact ${phase} record does not match its publication lock.`,
    )
  }
  return record
}

async function createAttemptRecord(recordPath, record) {
  const created = await createPublicationMarker(recordPath, record)
  if (!created) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'An artifact publication attempt record already exists for this attempt.',
    )
  }
}

async function removeValidatedJsonRecord(recordPath, expectedValue) {
  const observed = await readJsonFileWithIdentity(recordPath)
  if (!observed || JSON.stringify(observed.value) !== JSON.stringify(expectedValue)) return false
  return await removeOwnedFailedPublication(recordPath, observed.identity, {
    expectedContents: observed.contents,
  })
}

async function reclaimStaleArtifactPublicationLock(lockPath, publication) {
  const observedLock = await readJsonFileWithIdentity(lockPath)
  if (!observedLock) return false

  let owner
  try {
    owner = assertPublicationLockOwner(observedLock.value, publication)
  } catch {
    return false
  }
  const sameHost = owner.hostname === os.hostname()
  const ownerAlive = sameHost ? localProcessIsAlive(Number(owner.pid)) : null
  const staleByAge = Date.now() - Number(owner.createdAt) >= LOCAL_ARTIFACT_LOCK_STALE_MS
  // A shared filesystem can expose this lock to another host, where the PID
  // cannot be checked. Remote ownership always fails closed.
  if (!sameHost || ownerAlive === true || (ownerAlive !== false && !staleByAge)) return false

  try {
    const markerPath = artifactPublicationMarkerPath(publication.digest)
    const marker = await readPublicationMarker(markerPath, publication.marker)
    if (!marker) return false
    const recovered = await reconcileStaleArtifactPublicationAttempt({
      owner,
      marker,
      fullPath: publication.fullPath,
      sourcePath: publication.sourcePath,
    })
    if (!recovered) return false
    return await removeOwnedFailedPublication(lockPath, observedLock.identity, {
      expectedContents: observedLock.contents,
    })
  } catch {
    // Any mismatch means the stale process no longer owns all paths involved.
    // Preserve the evidence and require manual reconciliation.
    return false
  }
}

async function acquireArtifactPublicationLock(lockPath, publication) {
  const deadline = Date.now() + LOCAL_ARTIFACT_LOCK_WAIT_MS
  let attempt = 0
  while (Date.now() <= deadline) {
    let handle = null
    let lockCreated = false
    const attemptId = crypto.randomBytes(16).toString('hex')
    const owner = publicationLockOwner({
      digest: publication.digest,
      marker: publication.marker,
      attemptId,
    })
    const serializedOwner = JSON.stringify(owner)
    let lockIdentity = null
    try {
      handle = await fs.promises.open(lockPath, 'wx')
      lockCreated = true
      lockIdentity = await handle.stat({ bigint: true })
      await handle.writeFile(serializedOwner)
      await handle.sync()
      await handle.close()
      handle = null
      return {
        alreadyPublished: false,
        owner,
        lockIdentity,
        stagingPath: artifactPublicationStagingPath(publication.digest, attemptId),
        stageRecordPath: artifactPublicationAttemptRecordPath(publication.digest, attemptId, 'stage'),
        destinationRecordPath: artifactPublicationAttemptRecordPath(publication.digest, attemptId, 'destination'),
        release: async () => {
          await cleanupCurrentArtifactPublicationAttempt({
            lockPath,
            lockIdentity,
            owner,
          })
        },
      }
      } catch (error) {
        try { await handle?.close() } catch { /* best-effort handle cleanup */ }
      if (lockCreated && lockIdentity) {
        await removeOwnedFailedPublication(lockPath, lockIdentity, {
          expectedContents: serializedOwner,
        })
      }
      if (error?.code !== 'EEXIST') throw error
      // The destination may be visible while the exclusive-copy fallback is
      // still filling it. Never treat that path as a completed publication
      // until the publisher releases the shared lock.
      if (await reclaimStaleArtifactPublicationLock(lockPath, publication)) continue
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 + attempt * 10, 100)))
    }
  }
  throw artifactPublicationError(
    'ARTIFACT_PUBLICATION_BUSY',
    'Another process is still publishing this managed artifact. Retry after it finishes.',
  )
}

function artifactPublicationLockPath(digest) {
  return path.join(ARTIFACT_DIR, `.publish-${digest.slice(0, 32)}.lock`)
}

function artifactPublicationMarkerPath(digest) {
  const directory = path.join(ensureArtifactDir(), LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR)
  fs.mkdirSync(directory, { recursive: true })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_MARKER_UNSAFE',
      'The artifact publication marker directory is not a trusted local directory.',
    )
  }
  return path.join(directory, `${digest}.json`)
}

async function sha256LocalFile(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function expectedPublicationMarker({ artifactPath, digest, contentSha256, size }) {
  return {
    version: LOCAL_ARTIFACT_PUBLICATION_MARKER_VERSION,
    publicationDigest: digest,
    artifactId: artifactPath.id,
    filename: artifactPath.filename,
    contentSha256,
    size,
  }
}

function assertPublicationMarker(marker, expected) {
  const valid = marker
    && marker.version === expected.version
    && marker.publicationDigest === expected.publicationDigest
    && marker.artifactId === expected.artifactId
    && marker.filename === expected.filename
    && /^[a-f0-9]{64}$/u.test(String(marker.contentSha256 || ''))
    && Number.isSafeInteger(marker.size)
    && marker.size >= 0
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
      'The stable artifact target has no valid ownership marker for this execution.',
    )
  }
  if (expected.contentSha256 && (marker.contentSha256 !== expected.contentSha256 || marker.size !== expected.size)) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
      'The same artifact publication identity was reused with different content.',
    )
  }
  return marker
}

async function readPublicationMarker(markerPath, expected) {
  let lastError = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'))
      return assertPublicationMarker(parsed, expected)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      lastError = error
      if (!(error instanceof SyntaxError) && error?.code !== 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT') break
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const incomplete = lastError instanceof SyntaxError
  throw artifactPublicationError(
    incomplete
      ? 'ARTIFACT_PUBLICATION_MARKER_INCOMPLETE'
      : 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
    incomplete
      ? 'The stable artifact ownership marker was interrupted before it became valid.'
      : 'The stable artifact ownership marker is unreadable.',
    lastError,
  )
}

async function createPublicationMarker(markerPath, marker) {
  const temporary = path.join(
    path.dirname(markerPath),
    `.${path.basename(markerPath)}-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  const serializedMarker = JSON.stringify(marker)
  let handle = null
  let markerIdentity
  try {
    handle = await fs.promises.open(temporary, 'wx')
    markerIdentity = await handle.stat({ bigint: true })
    await handle.writeFile(serializedMarker, 'utf8')
    await handle.sync()
    markerIdentity = await handle.stat({ bigint: true })
    await handle.close()
    handle = null
    try {
      // A hard link publishes the already-fsynced inode atomically and never
      // replaces a non-cooperating winner. Writing the final pathname directly
      // would leave a truncated marker after a process or power failure.
      await fs.promises.link(temporary, markerPath)
      const publishedIdentity = await fs.promises.lstat(markerPath, { bigint: true })
      if (!sameFileIdentity(publishedIdentity, markerIdentity)) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
          'The artifact publication marker was replaced immediately after it was claimed.',
        )
      }
      return { identity: markerIdentity, contents: serializedMarker }
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      if (LOCAL_ARTIFACT_LINK_FALLBACK_CODES.has(error?.code)) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_MARKER_ATOMIC_UNSUPPORTED',
          'The artifact filesystem cannot atomically publish ownership markers.',
          error,
        )
      }
      throw error
    }
  } finally {
    try { await handle?.close() } catch { /* best-effort marker close */ }
    try { await fs.promises.unlink(temporary) } catch { /* best-effort marker staging cleanup */ }
  }
}

async function recoverInterruptedPublicationMarker(markerPath, expected) {
  const canonical = Buffer.from(JSON.stringify(expected), 'utf8')
  let handle = null
  let openedIdentity
  let observedContents
  try {
    const pathIdentity = await fs.promises.lstat(markerPath, { bigint: true })
    if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()) return false
    if (pathIdentity.size >= BigInt(canonical.length)) return false
    handle = await fs.promises.open(markerPath, 'r')
    openedIdentity = await handle.stat({ bigint: true })
    if (!sameFileIdentity(pathIdentity, openedIdentity)) return false
    observedContents = await handle.readFile()
    if (observedContents.length >= canonical.length
      || !canonical.subarray(0, observedContents.length).equals(observedContents)) {
      return false
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  } finally {
    try { await handle?.close() } catch { /* best-effort interrupted marker close */ }
  }

  try {
    return await removeOwnedFailedPublication(markerPath, openedIdentity, {
      expectedContents: observedContents,
    })
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

async function verifyPublishedArtifact({ fullPath, marker }) {
  const stat = await publishedLocalArtifactStat(fullPath)
  if (!stat) return null
  if (stat.size !== marker.size || await sha256LocalFile(fullPath) !== marker.contentSha256) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
      'The managed artifact content no longer matches its durable publication intent.',
    )
  }
  return stat
}

async function stablePublishedLocalArtifactStat(fullPath, digest, publication) {
  const existing = await publishedLocalArtifactStat(fullPath)
  const lockPath = artifactPublicationLockPath(digest)
  try {
    await fs.promises.access(lockPath, fs.constants.F_OK)
  } catch (error) {
    if (error?.code === 'ENOENT') return existing
    throw error
  }

  const lock = await acquireArtifactPublicationLock(lockPath, publication)
  try {
    return publishedLocalArtifactStat(fullPath)
  } finally {
    await lock.release()
  }
}

function sameFileIdentity(left, right) {
  if (typeof left?.ino !== 'bigint' || typeof right?.ino !== 'bigint'
    || typeof left?.dev !== 'bigint' || typeof right?.dev !== 'bigint'
    || left.ino === 0n || right.ino === 0n) return false
  return left.dev === right.dev && left.ino === right.ino
}

function serializeFileIdentity(stat) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint'
    || stat.dev < 0n || stat.ino <= 0n) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_IDENTITY_UNAVAILABLE',
      'The artifact filesystem does not expose a stable file identity.',
    )
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function validSerializedFileIdentity(identity) {
  return identity
    && /^(?:0|[1-9]\d*)$/u.test(String(identity.dev || ''))
    && /^[1-9]\d*$/u.test(String(identity.ino || ''))
}

function fileIdentityFromRecord(identity) {
  if (!validSerializedFileIdentity(identity)) return null
  return { dev: BigInt(identity.dev), ino: BigInt(identity.ino) }
}
async function readAttemptRecord(recordPath, phase, owner) {
  const observed = await readJsonFileWithIdentity(recordPath)
  if (!observed) return null
  return {
    ...observed,
    value: assertAttemptRecord(observed.value, { phase, owner }),
  }
}

async function claimedFileIdentityAtPath(filePath) {
  try {
    const stat = await fs.promises.lstat(filePath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return stat
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function openedFileSha256(handle) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function assertOpenedFileMatchesMarker(handle, marker, identity = null) {
  const before = await handle.stat({ bigint: true })
  if (!before.isFile() || (identity && !sameFileIdentity(before, identity))) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'A claimed artifact publication file was replaced before recovery.',
    )
  }
  const digest = await openedFileSha256(handle)
  const after = await handle.stat({ bigint: true })
  if (!sameFileSnapshot(before, after)
    || after.size !== BigInt(marker.size)
    || digest !== marker.contentSha256) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'A claimed artifact publication file no longer matches the durable content digest.',
    )
  }
  return after
}

async function handlesShareExactPrefix(source, destination, length) {
  const sourceBuffer = Buffer.allocUnsafe(1024 * 1024)
  const destinationBuffer = Buffer.allocUnsafe(1024 * 1024)
  let position = 0
  while (position < length) {
    const requested = Math.min(sourceBuffer.length, length - position)
    const [sourceRead, destinationRead] = await Promise.all([
      source.read(sourceBuffer, 0, requested, position),
      destination.read(destinationBuffer, 0, requested, position),
    ])
    if (sourceRead.bytesRead !== requested || destinationRead.bytesRead !== requested) return false
    if (!sourceBuffer.subarray(0, requested).equals(destinationBuffer.subarray(0, requested))) return false
    position += requested
  }
  return true
}

async function resumeClaimedFileFromTrustedSource({
  sourcePath,
  sourceIdentity = null,
  destinationPath,
  destinationIdentity,
  marker,
}) {
  let source = null
  let destination = null
  try {
    source = await fs.promises.open(sourcePath, 'r')
    destination = await fs.promises.open(destinationPath, 'r+')
    const sourceStat = await assertOpenedFileMatchesMarker(source, marker, sourceIdentity)
    const destinationBefore = await destination.stat({ bigint: true })
    if (!destinationBefore.isFile()
      || !sameFileIdentity(destinationBefore, destinationIdentity)
      || destinationBefore.size > sourceStat.size) {
      return false
    }
    const prefixLength = Number(destinationBefore.size)
    if (!await handlesShareExactPrefix(source, destination, prefixLength)) return false
    const destinationUnchanged = await destination.stat({ bigint: true })
    if (!sameFileSnapshot(destinationBefore, destinationUnchanged)) return false

    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = prefixLength
    while (position < marker.size) {
      const requested = Math.min(buffer.length, marker.size - position)
      const { bytesRead } = await source.read(buffer, 0, requested, position)
      if (bytesRead !== requested) return false
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten <= 0) throw new Error('artifact publication write made no progress')
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    await assertOpenedFileMatchesMarker(destination, marker, destinationIdentity)
    const currentPathIdentity = await fs.promises.lstat(destinationPath, { bigint: true })
    return sameFileIdentity(currentPathIdentity, destinationIdentity)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false
    throw error
  } finally {
    try { await source?.close() } catch { /* best-effort recovery source close */ }
    try { await destination?.close() } catch { /* best-effort recovery destination close */ }
  }
}

async function cleanupAttemptRecords({ owner, stageRecord = null, destinationRecord = null }) {
  const stageRecordPath = artifactPublicationAttemptRecordPath(
    owner.publicationDigest,
    owner.attemptId,
    'stage',
  )
  const destinationRecordPath = artifactPublicationAttemptRecordPath(
    owner.publicationDigest,
    owner.attemptId,
    'destination',
  )
  if (stageRecord && !await removeValidatedJsonRecord(stageRecordPath, stageRecord)) return false
  if (destinationRecord
    && !await removeValidatedJsonRecord(destinationRecordPath, destinationRecord)) return false
  return true
}

async function cleanupCurrentArtifactPublicationAttempt({ lockPath, lockIdentity, owner }) {
  const stagingPath = artifactPublicationStagingPath(owner.publicationDigest, owner.attemptId)
  const stageRecordPath = artifactPublicationAttemptRecordPath(owner.publicationDigest, owner.attemptId, 'stage')
  const destinationRecordPath = artifactPublicationAttemptRecordPath(
    owner.publicationDigest,
    owner.attemptId,
    'destination',
  )
  try {
    const stage = await readAttemptRecord(stageRecordPath, 'stage', owner)
    if (stage) {
      if (!await removeOwnedFailedPublication(stagingPath, fileIdentityFromRecord(stage.value.fileIdentity))) return false
      if (!await removeValidatedJsonRecord(stageRecordPath, stage.value)) return false
    } else if (await publishedLocalArtifactStat(stagingPath)) {
      return false
    }
    const destination = await readAttemptRecord(destinationRecordPath, 'destination', owner)
    if (destination
      && !await removeValidatedJsonRecord(destinationRecordPath, destination.value)) return false
    return await removeOwnedFailedPublication(lockPath, lockIdentity, {
      expectedContents: JSON.stringify(owner),
    })
  } catch {
    return false
  }
}

async function reconcileStaleArtifactPublicationAttempt({ owner, marker, fullPath, sourcePath }) {
  const stagingPath = artifactPublicationStagingPath(owner.publicationDigest, owner.attemptId)
  const stageRecordPath = artifactPublicationAttemptRecordPath(owner.publicationDigest, owner.attemptId, 'stage')
  const destinationRecordPath = artifactPublicationAttemptRecordPath(
    owner.publicationDigest,
    owner.attemptId,
    'destination',
  )
  const stage = await readAttemptRecord(stageRecordPath, 'stage', owner)
  const destination = await readAttemptRecord(destinationRecordPath, 'destination', owner)
  let stageStat = await publishedLocalArtifactStat(stagingPath)
  let targetStat = await publishedLocalArtifactStat(fullPath)
  let stagePathIdentity = await claimedFileIdentityAtPath(stagingPath)
  let targetPathIdentity = await claimedFileIdentityAtPath(fullPath)

  // open(wx) -> durable claim is intentionally fail-closed: an unclaimed path
  // cannot be proven to belong to the crashed process, even when it is empty.
  if (Boolean(stage) !== Boolean(stageStat)) return false
  if (stage && !sameFileIdentity(stagePathIdentity, fileIdentityFromRecord(stage.value.fileIdentity))) return false
  if (targetStat && !destination) {
    try {
      await verifyPublishedArtifact({ fullPath, marker })
    } catch {
      return false
    }
  }
  if (destination && targetStat
    && !sameFileIdentity(targetPathIdentity, fileIdentityFromRecord(destination.value.fileIdentity))) return false
  if (destination && !targetStat) return false

  if (stage) {
    const stageIdentity = fileIdentityFromRecord(stage.value.fileIdentity)
    if (stageStat.size !== marker.size || await sha256LocalFile(stagingPath) !== marker.contentSha256) {
      if (!sourcePath || !await resumeClaimedFileFromTrustedSource({
        sourcePath,
        destinationPath: stagingPath,
        destinationIdentity: stageIdentity,
        marker,
      })) return false
      stagePathIdentity = await claimedFileIdentityAtPath(stagingPath)
    }
    if (!sameFileIdentity(stagePathIdentity, stageIdentity)) return false
  }

  if (targetStat && destination) {
    const destinationIdentity = fileIdentityFromRecord(destination.value.fileIdentity)
    try {
      await verifyPublishedArtifact({ fullPath, marker })
    } catch (error) {
      if (error?.code !== 'ARTIFACT_PUBLICATION_CONTENT_DRIFT' || !stage) return false
      if (!await resumeClaimedFileFromTrustedSource({
        sourcePath: stagingPath,
        sourceIdentity: fileIdentityFromRecord(stage.value.fileIdentity),
        destinationPath: fullPath,
        destinationIdentity,
        marker,
      })) return false
    }
    targetStat = await verifyPublishedArtifact({ fullPath, marker })
    targetPathIdentity = await claimedFileIdentityAtPath(fullPath)
    if (!sameFileIdentity(targetPathIdentity, destinationIdentity)) return false
  } else if (!targetStat && stage) {
    const recoveredAttempt = {
      owner,
      destinationRecordPath,
    }
    if (!await publishStagedLocalArtifactUnderLock({
      temporary: stagingPath,
      fullPath,
      attempt: recoveredAttempt,
    })) return false
    targetStat = await verifyPublishedArtifact({ fullPath, marker })
  }

  if (!targetStat && stage) return false
  if (stage
    && !await removeOwnedFailedPublication(stagingPath, fileIdentityFromRecord(stage.value.fileIdentity))) return false
  const latestDestination = destination || await readAttemptRecord(destinationRecordPath, 'destination', owner)
  return await cleanupAttemptRecords({
    owner,
    stageRecord: stage?.value || null,
    destinationRecord: latestDestination?.value || null,
  })
}

async function stageLocalArtifactForAttempt({ sourcePath, marker, attempt }) {
  let staging = null
  let stagingIdentity = null
  let stageRecord = null
  try {
    staging = await fs.promises.open(attempt.stagingPath, 'wx')
    stagingIdentity = await staging.stat({ bigint: true })
    stageRecord = attemptRecord({ phase: 'stage', owner: attempt.owner, identity: stagingIdentity })
    await createAttemptRecord(attempt.stageRecordPath, stageRecord)
    await staging.close()
    staging = null
    if (!await resumeClaimedFileFromTrustedSource({
      sourcePath,
      destinationPath: attempt.stagingPath,
      destinationIdentity: stagingIdentity,
      marker,
    })) {
      throw artifactPublicationError(
        'ARTIFACT_PUBLICATION_SOURCE_DRIFT',
        'The local artifact source changed while its managed copy was staged.',
      )
    }
    return attempt.stagingPath
  } catch (error) {
    try { await staging?.close() } catch { /* best-effort staging close */ }
    await removeOwnedFailedPublication(attempt.stagingPath, stagingIdentity)
    if (stageRecord) await removeValidatedJsonRecord(attempt.stageRecordPath, stageRecord)
    throw error
  }
}

async function copyStagedLocalArtifactExclusive(temporary, fullPath, attempt) {
  let destination
  let destinationIdentity
  let destinationRecord
  try {
    destination = await fs.promises.open(fullPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }

  try {
    destinationIdentity = await destination.stat({ bigint: true })
    destinationRecord = attemptRecord({
      phase: 'destination',
      owner: attempt.owner,
      identity: destinationIdentity,
    })
    await createAttemptRecord(attempt.destinationRecordPath, destinationRecord)
    await destination.close()
    destination = null
    return await resumeClaimedFileFromTrustedSource({
      sourcePath: temporary,
      destinationPath: fullPath,
      destinationIdentity,
      marker: attempt.owner,
    })
  } catch (error) {
    try { await destination?.close() } catch { /* best-effort handle cleanup */ }
    await removeOwnedFailedPublication(fullPath, destinationIdentity)
    if (destinationRecord) {
      await removeValidatedJsonRecord(attempt.destinationRecordPath, destinationRecord)
    }
    throw error
  }
}

async function publishStagedLocalArtifactUnderLock({ temporary, fullPath, attempt }) {
  if (await publishedLocalArtifactStat(fullPath)) return false

  try {
    // Every stable publisher takes the same lock, including filesystems where
    // hard links work. Otherwise a hard-link publisher could create a winner
    // after the fallback's existence check and have it replaced by POSIX
    // rename. The link remains the preferred atomic no-clobber primitive.
    await fs.promises.link(temporary, fullPath)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (!LOCAL_ARTIFACT_LINK_FALLBACK_CODES.has(error?.code)) throw error
  }

  // Filesystems such as exFAT and some SMB mounts cannot create hard links.
  // Claim the final pathname with O_EXCL and fill only the file descriptor we
  // own. Unlike POSIX rename, this cannot replace a non-cooperating winner.
  // The destination is visible during the bounded copy, so cooperative
  // readers must observe the publication lock before treating it as complete.
  return await copyStagedLocalArtifactExclusive(temporary, fullPath, attempt)
}

/** Copy a verified local tool output into the authenticated artifact store. */
export function createLocalFileArtifact({ sourcePath, filename = '' } = {}) {
  const source = fs.realpathSync(String(sourcePath || ''))
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw new Error('local artifact source must be a file')
  const originalFilename = String(filename || path.basename(source)).normalize('NFC').trim()
  const artifactPath = newArtifactPathForFilename(originalFilename)
  try {
    fs.copyFileSync(source, artifactPath.fullPath)
  } catch (error) {
    try { fs.unlinkSync(artifactPath.fullPath) } catch { /* best-effort allocation cleanup */ }
    throw error
  }
  const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
  return {
    ...artifactPath,
    type: extension || 'file',
    title: originalFilename,
    byteLength: stat.size,
  }
}

/** Async variant for media/PDF/image outputs that may be hundreds of MB. */
export async function createLocalFileArtifactAsync({ sourcePath, filename = '', publicationKey = '' } = {}) {
  const requestedSource = String(sourcePath || '')
  const originalFilename = String(filename || path.basename(requestedSource)).normalize('NFC').trim()
  const stablePublication = Boolean(String(publicationKey || '').trim())
  let artifactPath = stablePublication
    ? stableLocalArtifactPath(originalFilename, publicationKey)
    : null
  if (stablePublication) {
    const digest = artifactPath.id.slice('local-'.length)
    const markerPath = artifactPublicationMarkerPath(digest)
    const markerIdentity = expectedPublicationMarker({ artifactPath, digest })
    let existingMarker = null
    let interruptedMarker = false
    try {
      existingMarker = await readPublicationMarker(markerPath, markerIdentity)
    } catch (error) {
      if (error?.code !== 'ARTIFACT_PUBLICATION_MARKER_INCOMPLETE') throw error
      interruptedMarker = true
    }
    const existingStat = existingMarker && !interruptedMarker
      ? await stablePublishedLocalArtifactStat(artifactPath.fullPath, digest, {
          digest,
          marker: existingMarker,
          fullPath: artifactPath.fullPath,
          sourcePath: requestedSource,
        })
      : await publishedLocalArtifactStat(artifactPath.fullPath)
    if (existingStat && (!existingMarker || interruptedMarker)) {
      throw artifactPublicationError(
        'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
        'The stable artifact target already exists without this execution ownership marker.',
      )
    }
    if (existingMarker && existingStat) {
      try {
        const currentSource = await fs.promises.realpath(requestedSource)
        const currentSourceStat = await fs.promises.stat(currentSource)
        if (!currentSourceStat.isFile()
          || currentSourceStat.size !== existingMarker.size
          || await sha256LocalFile(currentSource) !== existingMarker.contentSha256) {
          throw artifactPublicationError(
            'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
            'The same artifact publication identity now points to different source content.',
          )
        }
      } catch (error) {
        // The source tool may clean its transient output after returning. The
        // durable marker plus verified managed copy is sufficient to reconcile
        // that crash window; every other source error remains fail-closed.
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
      }
      await verifyPublishedArtifact({ fullPath: artifactPath.fullPath, marker: existingMarker })
      const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
      return {
        ...artifactPath,
        type: extension || 'file',
        title: originalFilename,
        byteLength: existingMarker.size,
        idempotentPublication: true,
        publicationReconciled: true,
      }
    }
  }

  const source = await fs.promises.realpath(requestedSource)
  const stat = await fs.promises.stat(source)
  if (!stat.isFile()) throw new Error('local artifact source must be a file')
  artifactPath ||= newArtifactPathForFilename(originalFilename)
  if (stablePublication) {
    const digest = artifactPath.id.slice('local-'.length)
    const markerPath = artifactPublicationMarkerPath(digest)
    const sourceSha256 = await sha256LocalFile(source)
    const marker = expectedPublicationMarker({
      artifactPath,
      digest,
      contentSha256: sourceSha256,
      size: stat.size,
    })
    const lock = await acquireArtifactPublicationLock(artifactPublicationLockPath(digest), {
      digest,
      marker,
      fullPath: artifactPath.fullPath,
      sourcePath: source,
    })
    try {
      let existingMarker = null
      let interruptedMarker = false
      try {
        existingMarker = await readPublicationMarker(markerPath, marker)
      } catch (error) {
        if (error?.code !== 'ARTIFACT_PUBLICATION_MARKER_INCOMPLETE') throw error
        interruptedMarker = true
      }
      const existingStat = await publishedLocalArtifactStat(artifactPath.fullPath)
      if (existingStat) {
        if (!existingMarker) {
          throw artifactPublicationError(
            'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
            'The stable artifact target already exists without this execution ownership marker.',
          )
        }
        const reconciledStat = await verifyPublishedArtifact({
          fullPath: artifactPath.fullPath,
          marker: existingMarker,
        })
        const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
        return {
          ...artifactPath,
          type: extension || 'file',
          title: originalFilename,
          byteLength: reconciledStat.size,
          idempotentPublication: true,
          publicationReconciled: true,
        }
      }

      if (interruptedMarker
        && !await recoverInterruptedPublicationMarker(markerPath, marker)) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
          'The interrupted artifact ownership marker could not be safely reconciled.',
        )
      }

      let markerCreated = false
      if (!existingMarker) {
        markerCreated = await createPublicationMarker(markerPath, marker)
        if (!markerCreated) {
          assertPublicationMarker(await readPublicationMarker(markerPath, marker), marker)
        }
      }
      const samePath = process.platform === 'win32'
        ? source.toLowerCase() === artifactPath.fullPath.toLowerCase()
        : source === artifactPath.fullPath
      if (!samePath) {
        const temporary = await stageLocalArtifactForAttempt({ sourcePath: source, marker, attempt: lock })
        const created = await publishStagedLocalArtifactUnderLock({
          temporary,
          fullPath: artifactPath.fullPath,
          attempt: lock,
        })
        if (!created) {
          if (markerCreated) {
            await removeOwnedFailedPublication(markerPath, markerCreated.identity, {
              expectedContents: markerCreated.contents,
            })
          }
          throw artifactPublicationError(
            'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
            'Another writer claimed the deterministic artifact target before this publication.',
          )
        }
      }
      const publishedStat = await verifyPublishedArtifact({ fullPath: artifactPath.fullPath, marker })
      if (!publishedStat) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_MISSING',
          'The managed artifact was not present after publication.',
        )
      }
      const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
      return {
        ...artifactPath,
        type: extension || 'file',
        title: originalFilename,
        byteLength: publishedStat.size,
        idempotentPublication: true,
        publicationReconciled: !markerCreated,
      }
    } finally {
      await lock.release()
    }
  }
  try {
    await fs.promises.copyFile(source, artifactPath.fullPath)
  } catch (error) {
    try { await fs.promises.unlink(artifactPath.fullPath) } catch { /* best-effort allocation cleanup */ }
    throw error
  }
  const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
  return {
    ...artifactPath,
    type: extension || 'file',
    title: originalFilename,
    byteLength: stat.size,
  }
}

const HTML_DELIVERY_INSTRUCTION_PATTERNS = Object.freeze([
  /(?:网页|页面|html)(?:\s*代码)?(?:已经|已)?(?:生成|完成|准备好)|(?:html|webpage|page)(?:\s+code)?\s+(?:is\s+)?(?:ready|generated|complete)/i,
  /(?:复制|拷贝)[^。！？\n]{0,48}(?:代码|源码)|copy[^.!?\n]{0,48}(?:code|source)/i,
  /(?:新建|创建)[^。！？\n]{0,32}(?:文件|\.html)|create[^.!?\n]{0,32}(?:file|\.html)/i,
  /(?:粘贴|貼上)[^。！？\n]{0,32}(?:保存|存储)|(?:保存|另存)[^。！？\n]{0,48}(?:\.html|html\s*文件)|paste[^.!?\n]{0,32}save|save[^.!?\n]{0,48}(?:\.html|as\s+html)/i,
  /(?:双击|浏览器)[^。！？\n]{0,48}(?:打开|预览)|(?:double[- ]?click|open)[^.!?\n]{0,48}(?:browser|locally)/i,
])

function visibleHtmlText(source) {
  return String(source || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function assertHtmlIsPageContent(source) {
  const visibleText = visibleHtmlText(source)
  const instructionSignals = HTML_DELIVERY_INSTRUCTION_PATTERNS
    .filter((pattern) => pattern.test(visibleText))
    .length
  const structuralTags = (source.match(/<(?:h[1-6]|main|section|article|nav|header|footer|form|button|input|select|textarea|canvas|svg|table|ul|ol|li|img|video|audio|p)\b/gi) || []).length
  const looksLikeShortHandoff = visibleText.length <= 2_000 && structuralTags <= 3 && instructionSignals >= 2
  if (instructionSignals >= 4 || looksLikeShortHandoff) {
    throw new Error('html contains file-delivery instructions instead of the requested webpage content')
  }
}

export function validateHtmlArtifactSource(source, {
  assetIds = [],
  remoteImageOrigins = htmlPreviewRemoteImageOrigins(),
} = {}) {
  const html = normalizeHtmlArtifactSource(source)
  if (!html) throw new Error('html is required')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_ARTIFACT_BYTES) {
    throw new Error('html artifact exceeds the 2 MB limit')
  }
  if (!/<(?:!doctype\s+html|html|head|body|main|section)\b/i.test(html)) {
    throw new Error('html must contain a complete HTML document')
  }
  if (/attachment:\/\//i.test(html)) {
    throw new Error('html artifact contains an unresolved attachment URI')
  }
  if (HTML_LOCAL_RESOURCE_REFERENCE.test(html)) {
    throw new Error('html artifact cannot reference a local disk path; declare the file in assets and use gugo-asset://<id>')
  }
  const declaredAssetIds = new Set(
    Array.isArray(assetIds)
      ? assetIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  )
  const referencedAssetIds = new Set(htmlArtifactAssetIds(html))
  for (const id of referencedAssetIds) {
    if (!declaredAssetIds.has(id)) {
      throw new Error(`html artifact references undeclared managed asset: ${id}`)
    }
  }
  for (const id of declaredAssetIds) {
    if (!referencedAssetIds.has(id)) {
      throw new Error(`html artifact declares an unused managed asset: ${id}`)
    }
  }
  const networkValidationSource = maskAllowedHtmlPreviewRemoteImages(html, remoteImageOrigins)
  const blocked = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=/i,
    /<iframe\b/i,
    HTML_REMOTE_RESOURCE_REFERENCE,
    HTML_REMOTE_LINK_REFERENCE,
    HTML_FORM_SUBMISSION,
    HTML_META_REFRESH,
    HTML_NETWORK_API_CALL,
    /javascript\s*:/i,
  ]
  if (blocked.some((pattern) => pattern.test(networkValidationSource))) {
    throw new Error('html artifact must be self-contained and cannot load external scripts, styles, frames, or network requests')
  }
  assertHtmlIsPageContent(html)
  return html
}

function inlineHtmlFiles(files = {}) {
  const index = files && typeof files === 'object' ? files['index.html'] : ''
  let html = normalizeHtmlArtifactSource(index)
  const css = String(files?.['styles.css'] || '').trim()
  const js = String(files?.['app.js'] || '').trim()
  if (css) {
    const style = `<style>\n${css}\n</style>`
    html = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${style}\n</head>`) : `${style}\n${html}`
  }
  if (js) {
    const script = `<script>\n${js}\n</script>`
    html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}\n</body>`) : `${html}\n${script}`
  }
  return html
}

export function createHtmlArtifact({ title = 'Webpage', html, files, assetIds = [] } = {}) {
  const source = validateHtmlArtifactSource(html || inlineHtmlFiles(files), { assetIds })
  const artifactPath = writeNewArtifact(title, 'html', source, 'utf8')
  return {
    ...artifactPath,
    type: 'html',
    title: String(title || 'Webpage').slice(0, 200),
    byteLength: Buffer.byteLength(source, 'utf8'),
  }
}


/* ════════════════════════ PPTX (premium) ════════════════════════ */
export async function createPptx({ title = 'Presentation', subtitle = '', theme: themeName, brand = 'Gugo', slides = [], images = [], userId = null, generatedAt = null } = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides 不能为空')
  }
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > slides.length)) {
    throw new Error(`image target_index exceeds the ${slides.length}-slide deck`)
  }
  const resolvedGeneratedAt = generatedAt == null ? new Date().toISOString() : generatedAt
  const { buffer, themeName: resolvedThemeName, generatedAt: receiptGeneratedAt, fontInjection } = await buildPptxArtifactBuffer({
    title,
    subtitle,
    theme: themeName,
    brand,
    slides,
    preparedImages: officeImages,
    generatedAt: resolvedGeneratedAt,
  })
  const a = writeNewArtifact(title, 'pptx', buffer)
  return {
    ...a,
    type: 'pptx',
    title,
    slideCount: slides.length,
    imageCount: officeImages.length,
    byteLength: buffer.length,
    themeName: resolvedThemeName,
    generatedAt: receiptGeneratedAt,
    fontInjection,
  }
}

/* ────────────────────────── DOCX ────────────────────────── */

export async function createDocx({ title = 'Document', paragraphs = [], images = [], userId = null } = {}) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    throw new Error('paragraphs 不能为空')
  }
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > paragraphs.length)) {
    throw new Error(`image target_index exceeds the ${paragraphs.length}-paragraph document`)
  }
  const buffer = await buildDocxArtifactBuffer({
    title,
    paragraphs,
    preparedImages: officeImages,
  })
  const a = writeNewArtifact(title, 'docx', buffer)
  return { ...a, type: 'docx', title, paragraphCount: paragraphs.length, imageCount: officeImages.length, byteLength: buffer.length }
}

/* ────────────────────────── PDF ────────────────────────── */

const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89
const PDF_MARGIN_X = 56
const PDF_MARGIN_TOP = 58
const PDF_MARGIN_BOTTOM = 52

function pdfTextWidth(font, text, size) {
  return font.widthOfTextAtSize(String(text || ''), size)
}

function wrapPdfText(text, font, size, maxWidth) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  const lines = []
  let current = ''
  for (const character of source) {
    const candidate = `${current}${character}`
    if (current && pdfTextWidth(font, candidate, size) > maxWidth) {
      lines.push(current.trimEnd())
      current = character.trimStart()
    } else {
      current = candidate
    }
  }
  if (current.trim()) lines.push(current.trimEnd())
  return lines
}

function normalizedPdfBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      type: ['title', 'heading', 'bullet'].includes(block?.type) ? block.type : 'paragraph',
      text: String(block?.text || '').trim(),
    }))
    .filter((block) => block.text)
}

export async function createPdf({ title = 'Document', blocks = [], images = [], userId = null } = {}) {
  const normalizedTitle = String(title || 'Document').trim().slice(0, 200) || 'Document'
  const contentBlocks = normalizedPdfBlocks(blocks)
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (!contentBlocks.length && !officeImages.length) throw new Error('PDF content blocks 或 images 不能为空')

  const document = await PDFDocument.create()
  let font = null
  if (contentBlocks.length) {
    document.registerFontkit(pdfLibFontkit)
    try {
      font = await document.embedFont(fs.readFileSync(PDF_CJK_FONT_PATH), { subset: true })
    } catch (cause) {
      throw new Error(`PDF 中文字体加载失败: ${cause?.message || cause}`, { cause })
    }
  }
  document.setTitle(normalizedTitle)
  document.setCreator('Gugo')
  document.setProducer('Gugo PDF artifact generator')

  let page = null
  let y = 0
  const addPage = () => {
    page = document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    y = PDF_PAGE_HEIGHT - PDF_MARGIN_TOP
  }
  const ensureSpace = (height) => {
    if (!page || y - height < PDF_MARGIN_BOTTOM) addPage()
  }
  const drawBlock = ({ type, text }) => {
    const titleBlock = type === 'title'
    const headingBlock = type === 'heading'
    const bulletBlock = type === 'bullet'
    const size = titleBlock ? 25 : headingBlock ? 16 : 11.5
    const lineHeight = titleBlock ? 34 : headingBlock ? 24 : 18
    const before = titleBlock ? 0 : headingBlock ? 12 : 4
    const after = titleBlock ? 18 : headingBlock ? 7 : 5
    const prefix = bulletBlock ? '• ' : ''
    const indent = bulletBlock ? 14 : 0
    const maxWidth = PDF_PAGE_WIDTH - (PDF_MARGIN_X * 2) - indent
    const lines = wrapPdfText(`${prefix}${text}`, font, size, maxWidth)
    ensureSpace(before + Math.max(1, lines.length) * lineHeight + after)
    y -= before
    for (const line of lines) {
      ensureSpace(lineHeight + after)
      page.drawText(line, {
        x: PDF_MARGIN_X + indent,
        y: y - size,
        size,
        font,
        color: titleBlock ? rgb(0.08, 0.12, 0.2) : headingBlock ? rgb(0.12, 0.2, 0.34) : rgb(0.16, 0.18, 0.22),
      })
      y -= lineHeight
    }
    y -= after
  }

  if (contentBlocks.length) {
    const startsWithSameTitle = contentBlocks[0]?.type === 'title'
      && contentBlocks[0].text.localeCompare(normalizedTitle, undefined, { sensitivity: 'base' }) === 0
    drawBlock({ type: 'title', text: normalizedTitle })
    for (const block of startsWithSameTitle ? contentBlocks.slice(1) : contentBlocks) drawBlock(block)
  }

  for (const [imageIndex, image] of officeImages.entries()) {
    let targetPage
    if (image.targetIndex) {
      while (document.getPageCount() < image.targetIndex) document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
      targetPage = document.getPage(image.targetIndex - 1)
    } else {
      targetPage = document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    }
    const embedded = image.mimeType === 'image/jpeg'
      ? await document.embedJpg(image.buffer)
      : await document.embedPng(image.buffer)
    const { width: pageWidth, height: pageHeight } = targetPage.getSize()
    const availableWidth = Math.max(1, pageWidth - (PDF_MARGIN_X * 2))
    const availableHeight = Math.max(1, pageHeight - PDF_MARGIN_TOP - PDF_MARGIN_BOTTOM)
    const requested = officeImageSize(image, {
      defaultWidth: availableWidth / 72,
      maxWidth: availableWidth / 72,
      maxHeight: availableHeight / 72,
    })
    const width = requested.width * 72
    const height = requested.height * 72
    const x = image.x == null ? (pageWidth - width) / 2 : image.x * 72
    const y = image.y == null ? (pageHeight - height) / 2 : pageHeight - (image.y * 72) - height
    if (x < 0 || y < 0 || x + width > pageWidth || y + height > pageHeight) {
      throw new Error(`images[${imageIndex}] placement exceeds PDF page bounds`)
    }
    targetPage.drawImage(embedded, { x, y, width, height })
  }

  const pages = document.getPages()
  if (contentBlocks.length) {
    pages.forEach((item, index) => {
      const label = `${index + 1} / ${pages.length}`
      item.drawText(label, {
        x: (item.getWidth() - pdfTextWidth(font, label, 9)) / 2,
        y: 24,
        size: 9,
        font,
        color: rgb(0.48, 0.5, 0.54),
      })
    })
  }

  const buffer = Buffer.from(await document.save())
  const artifactPath = writeNewArtifact(normalizedTitle, 'pdf', buffer)
  return {
    ...artifactPath,
    type: 'pdf',
    title: normalizedTitle,
    pageCount: pages.length,
    imageCount: officeImages.length,
    byteLength: buffer.length,
  }
}

export async function createXlsx({ title = 'Spreadsheet', sheets = [], images = [], userId = null } = {}) {
  const validSheets = snapshotXlsxSheets(sheets)
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > validSheets.length)) {
    throw new Error(`image target_index exceeds the ${validSheets.length}-sheet workbook`)
  }
  const buffer = await buildXlsxArtifactBuffer({ sheets: validSheets, preparedImages: officeImages })
  const a = writeNewArtifact(title, 'xlsx', buffer)
  const totalRows = validSheets.reduce((sum, s) => sum + s.rows.length, 0)
  return { ...a, type: 'xlsx', title, sheetCount: validSheets.length, rowCount: totalRows, imageCount: officeImages.length, byteLength: buffer.length }
}

export {
  getArtifactPreviewRendererStatus,
  handleArtifactDownload,
  renderArtifactPreviewPng,
} from './artifactDelivery.js'
export { getArtifactDir } from './artifactStorage.js'
