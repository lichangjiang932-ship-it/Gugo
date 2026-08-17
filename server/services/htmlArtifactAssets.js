import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'

const BUNDLE_VERSION = 1
const BUNDLE_ROOT_NAME = '.html-artifact-assets'
const MANIFEST_NAME = 'manifest.json'
const MAX_ASSET_COUNT = 500
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_OFFLINE_ASSET_BYTES = 64 * 1024 * 1024
const MAX_OFFLINE_HTML_BYTES = 128 * 1024 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MANAGED_ASSET_VALUE = /^gugo-asset:\/\/([A-Za-z0-9_-]{1,64})$/
const CSS_ASSET_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi
const HTML_RESOURCE_ATTRIBUTES = Object.freeze({
  audio: ['src'],
  embed: ['src'],
  img: ['src', 'srcset'],
  input: ['src'],
  link: ['href'],
  object: ['data'],
  source: ['src', 'srcset'],
  track: ['src'],
  video: ['src', 'poster'],
  image: ['href', 'xlink:href'],
})
const SHARP_FORMAT_BY_EXTENSION = Object.freeze({
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp',
  '.avif': 'heif',
})

const MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg',
})

function assetError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function bundleKey(artifactId) {
  const id = String(artifactId || '').trim()
  if (!id) throw assetError('HTML_ASSET_ARTIFACT_REQUIRED', 'artifactId is required')
  return crypto.createHash('sha256').update(id).digest('hex')
}

function bundleRoot(artifactDirectory) {
  const directory = path.resolve(String(artifactDirectory || ''))
  if (!path.isAbsolute(directory)) {
    throw assetError('HTML_ASSET_DIRECTORY_INVALID', 'artifactDirectory must be absolute')
  }
  const root = path.join(directory, BUNDLE_ROOT_NAME)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function bundleDirectory(artifactDirectory, artifactId) {
  return path.join(bundleRoot(artifactDirectory), bundleKey(artifactId))
}

function normalizeAssetId(value) {
  const id = String(value || '').trim()
  if (!ASSET_ID_PATTERN.test(id)) {
    throw assetError('HTML_ASSET_ID_INVALID', 'asset id must contain 1-64 letters, numbers, underscores, or hyphens')
  }
  return id
}

function readManifestFromDirectory(directory, artifactId = '') {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_NAME), 'utf8'))
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null
    throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest is unreadable')
  }
  if (parsed?.version !== BUNDLE_VERSION || !Array.isArray(parsed.assets)
    || parsed.assets.length > MAX_ASSET_COUNT) {
    throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest is invalid')
  }
  if (artifactId && String(parsed.artifactId || '') !== String(artifactId)) {
    throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest does not match its parent artifact')
  }
  const seen = new Set()
  const canonicalDirectory = fs.realpathSync(directory)
  let totalBytes = 0
  const assets = parsed.assets.map((entry) => {
    const id = normalizeAssetId(entry?.id)
    const filename = String(entry?.filename || '')
    const mimeType = String(entry?.mimeType || '')
    const size = Number(entry?.size)
    const sha256 = String(entry?.sha256 || '')
    if (seen.has(id) || filename !== path.basename(filename) || !MIME_BY_EXTENSION[path.extname(filename).toLowerCase()]
      || MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] !== mimeType
      || !Number.isSafeInteger(size) || size < 0 || size > MAX_ASSET_BYTES
      || !SHA256_PATTERN.test(sha256)) {
      throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest contains an invalid entry')
    }
    seen.add(id)
    const fullPath = path.join(directory, filename)
    let canonical
    try {
      canonical = fs.realpathSync(fullPath)
    } catch {
      throw assetError('HTML_ASSET_FILE_MISSING', `HTML asset is missing: ${id}`)
    }
    if (canonical !== canonicalDirectory && !canonical.startsWith(`${canonicalDirectory}${path.sep}`)) {
      throw assetError('HTML_ASSET_PATH_INVALID', 'HTML asset escapes its bundle directory')
    }
    const stat = fs.statSync(canonical)
    if (!stat.isFile() || stat.size !== size) {
      throw assetError('HTML_ASSET_FILE_INVALID', `HTML asset is invalid: ${id}`)
    }
    totalBytes += size
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest exceeds the bundle size limit')
    }
    return { id, filename, mimeType, size, sha256, fullPath: canonical }
  })
  if (!Number.isSafeInteger(parsed.totalBytes) || parsed.totalBytes !== totalBytes) {
    throw assetError('HTML_ASSET_MANIFEST_INVALID', 'HTML asset manifest total size is invalid')
  }
  return { ...parsed, assets }
}

function existingAssetMap(artifactDirectory, artifactId) {
  if (!artifactId) return new Map()
  const directory = bundleDirectory(artifactDirectory, artifactId)
  const manifest = readManifestFromDirectory(directory, artifactId)
  return new Map((manifest?.assets || []).map((asset) => [asset.id, asset]))
}

function hashFileSync(filePath) {
  const descriptor = fs.openSync(filePath, 'r')
  const hash = crypto.createHash('sha256')
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function assertDecodableBmp(filePath) {
  const descriptor = fs.openSync(filePath, 'r')
  const header = Buffer.alloc(138)
  let size
  let bytesRead
  try {
    size = fs.fstatSync(descriptor).size
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0)
  } finally {
    fs.closeSync(descriptor)
  }
  if (bytesRead < 54 || header.subarray(0, 2).toString('ascii') !== 'BM') throw new Error('invalid BMP header')
  const declaredSize = header.readUInt32LE(2)
  const pixelOffset = header.readUInt32LE(10)
  const dibSize = header.readUInt32LE(14)
  const width = header.readInt32LE(18)
  const height = header.readInt32LE(22)
  const planes = header.readUInt16LE(26)
  const bitsPerPixel = header.readUInt16LE(28)
  const compression = header.readUInt32LE(30)
  if (declaredSize !== size || dibSize < 40 || width < 1 || height === 0 || planes !== 1
    || ![1, 4, 8, 16, 24, 32].includes(bitsPerPixel) || ![0, 3, 6].includes(compression)
    || pixelOffset < 14 + dibSize || pixelOffset > size) {
    throw new Error('invalid BMP metadata')
  }
  const rowBytes = Math.ceil((bitsPerPixel * width) / 32) * 4
  const pixelBytes = rowBytes * Math.abs(height)
  if (!Number.isSafeInteger(pixelBytes) || pixelBytes < 1 || pixelOffset + pixelBytes > size) {
    throw new Error('truncated BMP pixel data')
  }
}

async function assertDecodableImage(filePath, extension, id) {
  if (!MIME_BY_EXTENSION[extension]?.startsWith('image/')) return
  try {
    if (extension === '.bmp') {
      assertDecodableBmp(filePath)
      return
    }
    const options = { failOn: 'error', animated: false, sequentialRead: true }
    const metadata = await sharp(filePath, options).metadata()
    if (metadata.format !== SHARP_FORMAT_BY_EXTENSION[extension]
      || !Number.isInteger(metadata.width) || metadata.width < 1
      || !Number.isInteger(metadata.height) || metadata.height < 1) {
      throw new Error('decoded image format or dimensions do not match the file extension')
    }
    // Force libvips to decode pixels as well as parse container metadata. A
    // one-pixel output keeps the validation bounded while failOn:error rejects
    // truncated/corrupt input instead of accepting a plausible magic header.
    await sharp(filePath, options)
      .resize({ width: 1, height: 1, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer()
  } catch (cause) {
    const error = assetError('HTML_ASSET_CONTENT_INVALID', `HTML image cannot be decoded or does not match its file extension: ${id}`)
    error.cause = cause
    throw error
  }
}

async function copyVerifiedAsset({ id, sourcePath, stageDirectory }) {
  let canonical
  try {
    canonical = fs.realpathSync(String(sourcePath || ''))
  } catch {
    throw assetError('HTML_ASSET_SOURCE_MISSING', `HTML asset source is unavailable: ${id}`)
  }
  const sourceStat = fs.statSync(canonical)
  if (!sourceStat.isFile()) throw assetError('HTML_ASSET_SOURCE_INVALID', `HTML asset source is not a file: ${id}`)
  if (sourceStat.size > MAX_ASSET_BYTES) {
    throw assetError('HTML_ASSET_TOO_LARGE', `HTML asset exceeds the 512 MB limit: ${id}`)
  }
  const extension = path.extname(canonical).toLowerCase()
  const mimeType = MIME_BY_EXTENSION[extension]
  if (!mimeType) {
    throw assetError('HTML_ASSET_TYPE_UNSUPPORTED', `Unsupported HTML image/audio/video asset type: ${extension || '(none)'}`)
  }
  const filename = `${id}${extension}`
  const target = path.join(stageDirectory, filename)
  fs.copyFileSync(canonical, target, fs.constants.COPYFILE_EXCL)
  const copied = fs.statSync(target)
  if (!copied.isFile() || copied.size !== sourceStat.size) {
    throw assetError('HTML_ASSET_COPY_FAILED', `HTML asset copy verification failed: ${id}`)
  }
  await assertDecodableImage(target, extension, id)
  const sha256 = hashFileSync(target)
  return { id, filename, mimeType, size: copied.size, sha256 }
}

export function htmlArtifactAssetIds(source = '') {
  const ids = new Set()
  const addValue = (value) => {
    const match = String(value || '').trim().match(MANAGED_ASSET_VALUE)
    if (match) ids.add(match[1])
  }
  const addCssUrls = (css) => {
    const sourceCss = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of sourceCss.matchAll(CSS_ASSET_URL)) addValue(match[1] ?? match[2] ?? match[3])
    CSS_ASSET_URL.lastIndex = 0
  }
  const document = new JSDOM(String(source || '')).window.document
  for (const [tagName, attributes] of Object.entries(HTML_RESOURCE_ATTRIBUTES)) {
    for (const element of document.querySelectorAll(tagName)) {
      if (tagName === 'link' && !/^(?:icon|apple-touch-icon|mask-icon)$/i.test(element.getAttribute('rel') || '')) continue
      if (tagName === 'input' && String(element.getAttribute('type') || '').toLowerCase() !== 'image') continue
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute)
        if (!value) continue
        if (attribute === 'srcset') {
          for (const candidate of value.split(',')) addValue(candidate.trim().split(/\s+/, 1)[0])
        } else {
          addValue(value)
        }
      }
    }
  }
  for (const element of document.querySelectorAll('[style]')) addCssUrls(element.getAttribute('style'))
  for (const element of document.querySelectorAll('style')) addCssUrls(element.textContent)
  return [...ids]
}

function isDefinitelyHidden(element) {
  for (let current = element; current; current = current.parentElement) {
    if (String(current.tagName || '').toLowerCase() === 'template') return true
    if (current.hasAttribute?.('hidden')) return true
    const style = current.style
    if (!style) continue
    if (style.display === 'none') return true
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true
    if (style.contentVisibility === 'hidden') return true
    if (String(style.opacity || '').trim() !== '' && Number(style.opacity) === 0) return true
  }
  return false
}

/**
 * Return managed image ids that occupy a visible browser resource slot.
 * Complete gallery validation uses this stricter view so a favicon, template,
 * hidden node, or unmatched CSS selector cannot stand in for a requested image.
 */
export function htmlArtifactVisibleImageAssetIds(source = '') {
  const ids = new Set()
  const addValue = (value) => {
    const match = String(value || '').trim().match(MANAGED_ASSET_VALUE)
    if (match) ids.add(match[1])
  }
  const addSrcset = (value) => {
    for (const candidate of String(value || '').split(',')) addValue(candidate.trim().split(/\s+/, 1)[0])
  }
  const addCssUrls = (css) => {
    const sourceCss = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of sourceCss.matchAll(CSS_ASSET_URL)) addValue(match[1] ?? match[2] ?? match[3])
    CSS_ASSET_URL.lastIndex = 0
  }
  const document = new JSDOM(String(source || '')).window.document
  const visibleElements = (selector) => {
    try {
      return [...document.querySelectorAll(selector)].filter((element) => !isDefinitelyHidden(element))
    } catch {
      return []
    }
  }

  for (const element of visibleElements('img')) {
    addValue(element.getAttribute('src'))
    addSrcset(element.getAttribute('srcset'))
  }
  for (const element of visibleElements('picture source')) {
    addValue(element.getAttribute('src'))
    addSrcset(element.getAttribute('srcset'))
  }
  for (const element of visibleElements('video')) addValue(element.getAttribute('poster'))
  for (const element of visibleElements('input[type="image"], embed, object, svg image')) {
    addValue(element.getAttribute('src'))
    addValue(element.getAttribute('data'))
    addValue(element.getAttribute('href'))
    addValue(element.getAttribute('xlink:href'))
  }
  for (const element of visibleElements('[style]')) addCssUrls(element.getAttribute('style'))

  const visitCssRules = (rules) => {
    for (const rule of [...(rules || [])]) {
      if (rule.selectorText && visibleElements(rule.selectorText).length > 0) {
        addCssUrls(rule.style?.cssText || '')
      }
      if (rule.cssRules) visitCssRules(rule.cssRules)
    }
  }
  for (const sheet of [...document.styleSheets]) {
    try {
      visitCssRules(sheet.cssRules)
    } catch {
      // Uninspectable styles cannot prove that a managed gallery image is visible.
    }
  }
  return [...ids]
}

/**
 * Build a complete staged bundle. New authorized paths override an existing
 * asset with the same id; omitted ids may be retained only from the owned
 * artifact being replaced.
 */
export async function stageHtmlArtifactAssets({
  artifactDirectory,
  artifactId,
  parentFilename,
  requiredAssetIds = [],
  sources = [],
  existingArtifactId = '',
} = {}) {
  const requiredIds = [...new Set(requiredAssetIds.map(normalizeAssetId))]
  if (requiredIds.length > MAX_ASSET_COUNT) {
    throw assetError('HTML_ASSET_COUNT_EXCEEDED', `HTML artifacts support at most ${MAX_ASSET_COUNT} media assets`)
  }
  const sourceMap = new Map()
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = normalizeAssetId(source?.id)
    if (sourceMap.has(id)) throw assetError('HTML_ASSET_ID_DUPLICATE', `Duplicate HTML asset id: ${id}`)
    if (!requiredIds.includes(id)) throw assetError('HTML_ASSET_UNUSED', `HTML asset is declared but not referenced: ${id}`)
    sourceMap.set(id, String(source?.sourcePath || ''))
  }
  const existing = existingAssetMap(artifactDirectory, existingArtifactId)
  const root = bundleRoot(artifactDirectory)
  const stageDirectory = fs.mkdtempSync(path.join(root, '.stage-'))
  const targetDirectory = bundleDirectory(artifactDirectory, artifactId)
  try {
    const assets = []
    let totalBytes = 0
    for (const id of requiredIds) {
      const sourcePath = sourceMap.get(id) || existing.get(id)?.fullPath
      if (!sourcePath) {
        throw assetError('HTML_ASSET_UNDECLARED', `HTML references an unavailable managed asset: ${id}`)
      }
      const asset = await copyVerifiedAsset({ id, sourcePath, stageDirectory })
      totalBytes += asset.size
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw assetError('HTML_ASSET_BUNDLE_TOO_LARGE', 'HTML media bundle exceeds the 2 GB limit')
      }
      assets.push(asset)
    }
    const manifest = {
      version: BUNDLE_VERSION,
      artifactId: String(artifactId),
      parentFilename: path.basename(String(parentFilename || '')),
      assets,
      totalBytes,
      updatedAt: Date.now(),
    }
    fs.writeFileSync(path.join(stageDirectory, MANIFEST_NAME), JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' })
    return { artifactId: String(artifactId), stageDirectory, targetDirectory, assetCount: assets.length }
  } catch (error) {
    try { fs.rmSync(stageDirectory, { recursive: true, force: true }) } catch { /* preserve original staging error */ }
    throw error
  }
}

export function beginHtmlArtifactAssetInstall(stage) {
  if (!stage?.stageDirectory || !stage?.targetDirectory) return null
  const backupDirectory = `${stage.targetDirectory}.backup-${crypto.randomBytes(6).toString('hex')}`
  let backedUp = false
  try {
    if (fs.existsSync(stage.targetDirectory)) {
      fs.renameSync(stage.targetDirectory, backupDirectory)
      backedUp = true
    }
    if (stage.assetCount > 0) fs.renameSync(stage.stageDirectory, stage.targetDirectory)
    else fs.rmSync(stage.stageDirectory, { recursive: true, force: true })
    return { ...stage, backupDirectory: backedUp ? backupDirectory : '', installed: stage.assetCount > 0 }
  } catch (error) {
    try {
      if (!fs.existsSync(stage.targetDirectory) && backedUp) fs.renameSync(backupDirectory, stage.targetDirectory)
    } catch { /* best-effort rollback */ }
    throw error
  }
}

export function finishHtmlArtifactAssetInstall(transaction) {
  if (!transaction?.backupDirectory) return true
  try {
    fs.rmSync(transaction.backupDirectory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export function rollbackHtmlArtifactAssetInstall(transaction) {
  if (!transaction) return true
  let restored = true
  try {
    if (transaction.installed) fs.rmSync(transaction.targetDirectory, { recursive: true, force: true })
    if (transaction.backupDirectory && fs.existsSync(transaction.backupDirectory)) {
      fs.renameSync(transaction.backupDirectory, transaction.targetDirectory)
    }
  } catch {
    restored = false
  }
  try {
    if (transaction.stageDirectory && fs.existsSync(transaction.stageDirectory)) {
      fs.rmSync(transaction.stageDirectory, { recursive: true, force: true })
    }
  } catch {
    restored = false
  }
  return restored
}

export function discardStagedHtmlArtifactAssets(stage) {
  if (!stage?.stageDirectory) return true
  try {
    fs.rmSync(stage.stageDirectory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export function getHtmlArtifactAsset({ artifactDirectory, artifactId, assetId } = {}) {
  const id = normalizeAssetId(assetId)
  const directory = bundleDirectory(artifactDirectory, artifactId)
  const manifest = readManifestFromDirectory(directory, artifactId)
  const asset = manifest?.assets.find((entry) => entry.id === id)
  if (!asset) return null
  return { id, filename: asset.filename, fullPath: asset.fullPath, mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256 }
}

export function expandHtmlArtifactAssets({ artifactDirectory, artifactId, html } = {}) {
  let expanded = String(html || '')
  const ids = htmlArtifactAssetIds(expanded)
  const assets = ids.map((id) => {
    const asset = getHtmlArtifactAsset({ artifactDirectory, artifactId, assetId: id })
    if (!asset) throw assetError('HTML_ASSET_FILE_MISSING', `HTML asset is unavailable: ${id}`)
    if (asset.size > MAX_OFFLINE_ASSET_BYTES) {
      throw assetError(
        'HTML_ASSET_OFFLINE_TOO_LARGE',
        `HTML asset ${id} exceeds the 64 MB offline-embedding limit; use the managed preview instead`,
      )
    }
    return asset
  })
  let predictedBytes = Buffer.byteLength(expanded, 'utf8')
  for (const asset of assets) {
    const marker = `gugo-asset://${asset.id}`
    const occurrences = expanded.split(marker).length - 1
    const dataUriBytes = Buffer.byteLength(`data:${asset.mimeType};base64,`, 'utf8')
      + (4 * Math.ceil(asset.size / 3))
    predictedBytes += occurrences * (dataUriBytes - Buffer.byteLength(marker, 'utf8'))
    if (predictedBytes > MAX_OFFLINE_HTML_BYTES) {
      throw assetError(
        'HTML_ASSET_OFFLINE_TOO_LARGE',
        'Offline HTML expansion exceeds the 128 MB safety limit; use the managed preview instead',
      )
    }
  }
  for (const asset of assets) {
    const dataUri = `data:${asset.mimeType};base64,${fs.readFileSync(asset.fullPath).toString('base64')}`
    expanded = expanded.replaceAll(`gugo-asset://${asset.id}`, dataUri)
  }
  return expanded
}
