import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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
const MANAGED_ASSET_URI = /gugo-asset:\/\/([A-Za-z0-9_-]{1,64})/g

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

function copyVerifiedAsset({ id, sourcePath, stageDirectory }) {
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
  const sha256 = hashFileSync(target)
  return { id, filename, mimeType, size: copied.size, sha256 }
}

export function htmlArtifactAssetIds(source = '') {
  const ids = [...new Set([...String(source).matchAll(MANAGED_ASSET_URI)].map((match) => match[1]))]
  MANAGED_ASSET_URI.lastIndex = 0
  return ids
}

/**
 * Build a complete staged bundle. New authorized paths override an existing
 * asset with the same id; omitted ids may be retained only from the owned
 * artifact being replaced.
 */
export function stageHtmlArtifactAssets({
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
      const asset = copyVerifiedAsset({ id, sourcePath, stageDirectory })
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
