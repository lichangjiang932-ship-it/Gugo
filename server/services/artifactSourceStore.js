import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getArtifactDir } from './artifactStorage.js'

const SOURCE_DIRECTORY_NAME = '.artifact-sources'
const SOURCE_SNAPSHOT_VERSION = 2
const LEGACY_SOURCE_SNAPSHOT_VERSION = 1
const SNAPSHOT_LOCK_TIMEOUT_MS = 2_000
const SNAPSHOT_LOCK_RETRY_MS = 10
const SNAPSHOT_LOCK_STALE_MS = 60_000
const MAX_SOURCE_CHARS = 10_000_000
export const DEFAULT_ARTIFACT_SOURCE_PAGE_CHARS = 16_000
export const MAX_ARTIFACT_SOURCE_PAGE_CHARS = 20_000

function sourceStoreDirectory() {
  const directory = path.join(getArtifactDir(), SOURCE_DIRECTORY_NAME)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}
function sourceSnapshotPath(artifactId) {
  const normalized = String(artifactId || '').trim()
  if (!normalized) throw sourceError('artifact_source_id_required', 'artifactId is required')
  const digest = crypto.createHash('sha256').update(normalized).digest('hex')
  return path.join(sourceStoreDirectory(), `${digest}.json`)
}

function sourceError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function withSnapshotLock(target, callback) {
  const lockPath = `${target}.lock`
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(12).toString('hex')}`
  const deadline = Date.now() + SNAPSHOT_LOCK_TIMEOUT_MS
  while (true) {
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx', encoding: 'utf8' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > SNAPSHOT_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() >= deadline) {
        throw sourceError('artifact_source_snapshot_busy', 'The managed artifact source snapshot is busy.')
      }
      sleepSync(SNAPSHOT_LOCK_RETRY_MS)
    }
  }
  try {
    return callback()
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true })
    } catch { /* a stale-lock recovery may already have removed it */ }
  }
}

function parseStoredSnapshot(raw, id) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw sourceError('artifact_source_snapshot_invalid', 'The managed artifact source snapshot is unreadable.')
  }
  if (![LEGACY_SOURCE_SNAPSHOT_VERSION, SOURCE_SNAPSHOT_VERSION].includes(parsed?.version)
    || String(parsed?.artifactId || '') !== id
    || typeof parsed?.source !== 'string') {
    throw sourceError('artifact_source_snapshot_invalid', 'The managed artifact source snapshot is invalid.')
  }
  return parsed
}

function readStoredSnapshot(target, id) {
  try {
    return parseStoredSnapshot(fs.readFileSync(target, 'utf8'), id)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function deliveryGenerationOf(snapshot) {
  const generation = Number(snapshot?.deliveryGeneration)
  return snapshot?.version === SOURCE_SNAPSHOT_VERSION
    && Number.isSafeInteger(generation)
    && generation >= 0
    ? generation
    : 0
}

function replaceSnapshotFile(target, temporary) {
  const backup = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.bak`
  let backedUp = false
  try {
    try {
      fs.renameSync(target, backup)
      backedUp = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    fs.renameSync(temporary, target)
    if (backedUp) {
      try { fs.rmSync(backup, { force: true }) } catch { /* stale backup is recoverable */ }
    }
  } catch (error) {
    if (backedUp) {
      try {
        fs.linkSync(backup, target)
        fs.rmSync(backup, { force: true })
      } catch { /* never replace a concurrently-created snapshot */ }
    }
    throw error
  }
}

function normalizeSourceArguments(args) {
  let normalized
  try {
    normalized = JSON.parse(JSON.stringify(args && typeof args === 'object' ? args : {}))
  } catch (cause) {
    throw sourceError(
      'artifact_source_not_serializable',
      `Artifact source arguments could not be serialized: ${cause?.message || cause}`,
    )
  }
  delete normalized.replace_artifact_id
  delete normalized.output_directory
  delete normalized.asset_collection
  return normalized
}

/**
 * Keep the model-authored source beside the generated binary/text artifact,
 * outside chat history and outside the public one-filename download route.
 */
export function writeArtifactSourceSnapshot({
  artifactId,
  toolName,
  args,
  deliveryPath,
  deliveryRoot,
  deliveryDigest,
  deliverySize,
  expectedDeliveryGeneration,
} = {}) {
  const id = String(artifactId || '').trim()
  const name = String(toolName || '').trim()
  if (!id || !name) throw sourceError('artifact_source_identity_required', 'artifactId and toolName are required')
  const source = JSON.stringify(normalizeSourceArguments(args))
  if (source.length > MAX_SOURCE_CHARS) {
    throw sourceError(
      'artifact_source_too_large',
      `Artifact source exceeds the ${MAX_SOURCE_CHARS} character managed-source limit.`,
    )
  }
  const target = sourceSnapshotPath(id)
  return withSnapshotLock(target, () => {
    const previous = readStoredSnapshot(target, id)
    const currentGeneration = deliveryGenerationOf(previous)
    const advancesDelivery = deliveryDigest !== undefined || deliverySize !== undefined
      || expectedDeliveryGeneration !== undefined
    if (advancesDelivery) {
      const expected = Number(expectedDeliveryGeneration)
      const size = Number(deliverySize)
      if (!/^[a-f0-9]{64}$/i.test(String(deliveryDigest || ''))
        || !Number.isSafeInteger(size)
        || size < 0
        || !Number.isSafeInteger(expected)
        || expected < 0) {
        throw sourceError('artifact_source_delivery_identity_invalid', 'A valid delivery identity is required.')
      }
      if (currentGeneration !== expected) {
        throw sourceError(
          'artifact_source_snapshot_conflict',
          'The managed artifact source snapshot changed before delivery metadata could be saved.',
        )
      }
    }

    const retainedDeliveryPath = typeof deliveryPath === 'string' && path.isAbsolute(deliveryPath.trim())
      ? path.normalize(deliveryPath.trim())
      : (typeof previous?.deliveryPath === 'string' && path.isAbsolute(previous.deliveryPath.trim())
          ? path.normalize(previous.deliveryPath.trim())
          : '')
    const retainedDeliveryRoot = typeof deliveryRoot === 'string' && path.isAbsolute(deliveryRoot.trim())
      ? path.normalize(deliveryRoot.trim())
      : (typeof previous?.deliveryRoot === 'string' && path.isAbsolute(previous.deliveryRoot.trim())
          ? path.normalize(previous.deliveryRoot.trim())
          : '')
    const retainedDeliveryDigest = advancesDelivery
      ? String(deliveryDigest).toLowerCase()
      : (/^[a-f0-9]{64}$/i.test(String(previous?.deliveryDigest || ''))
          ? String(previous.deliveryDigest).toLowerCase()
          : '')
    const retainedDeliverySize = advancesDelivery
      ? Number(deliverySize)
      : (Number.isSafeInteger(Number(previous?.deliverySize)) && Number(previous.deliverySize) >= 0
          ? Number(previous.deliverySize)
          : null)
    const nextGeneration = advancesDelivery ? currentGeneration + 1 : currentGeneration
    const snapshot = JSON.stringify({
      version: SOURCE_SNAPSHOT_VERSION,
      artifactId: id,
      toolName: name,
      sourceFormat: 'artifact_tool_arguments_json',
      source,
      ...(retainedDeliveryPath ? { deliveryPath: retainedDeliveryPath } : {}),
      ...(retainedDeliveryRoot ? { deliveryRoot: retainedDeliveryRoot } : {}),
      ...(retainedDeliveryDigest ? { deliveryDigest: retainedDeliveryDigest } : {}),
      ...(retainedDeliverySize !== null ? { deliverySize: retainedDeliverySize } : {}),
      deliveryGeneration: nextGeneration,
      updatedAt: Date.now(),
    })
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temporary, snapshot, { flag: 'wx', encoding: 'utf8' })
      replaceSnapshotFile(target, temporary)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
      throw error
    }
    return {
      artifactId: id,
      toolName: name,
      sourceChars: source.length,
      deliveryGeneration: nextGeneration,
    }
  })
}

export function deleteArtifactSourceSnapshot(artifactId) {
  const id = String(artifactId || '').trim()
  if (!id) return false
  const target = sourceSnapshotPath(id)
  try {
    return withSnapshotLock(target, () => {
      fs.rmSync(target, { force: true })
      return true
    })
  } catch {
    return false
  }
}

export function readArtifactSourceSnapshot(artifactId) {
  const id = String(artifactId || '').trim()
  if (!id) return null
  const target = sourceSnapshotPath(id)
  const parsed = withSnapshotLock(target, () => readStoredSnapshot(target, id))
  if (!parsed) return null
  return {
    snapshotVersion: Number(parsed.version),
    artifactId: id,
    toolName: String(parsed.toolName || ''),
    sourceFormat: String(parsed.sourceFormat || 'artifact_tool_arguments_json'),
    source: parsed.source,
    deliveryPath: typeof parsed.deliveryPath === 'string' && path.isAbsolute(parsed.deliveryPath)
      ? path.normalize(parsed.deliveryPath)
      : null,
    deliveryRoot: typeof parsed.deliveryRoot === 'string' && path.isAbsolute(parsed.deliveryRoot)
      ? path.normalize(parsed.deliveryRoot)
      : null,
    deliveryDigest: /^[a-f0-9]{64}$/i.test(String(parsed.deliveryDigest || ''))
      ? String(parsed.deliveryDigest).toLowerCase()
      : null,
    deliverySize: Number.isSafeInteger(Number(parsed.deliverySize)) && Number(parsed.deliverySize) >= 0
      ? Number(parsed.deliverySize)
      : null,
    deliveryGeneration: parsed.version === SOURCE_SNAPSHOT_VERSION
      && Number.isSafeInteger(Number(parsed.deliveryGeneration))
      && Number(parsed.deliveryGeneration) >= 0
      ? Number(parsed.deliveryGeneration)
      : null,
    updatedAt: Number(parsed.updatedAt) || null,
  }
}

function legacyHtmlSource(artifact) {
  if (String(artifact?.type || '').toLowerCase() !== 'html') return null
  const filename = String(artifact?.filename || '')
  if (!filename || filename !== path.basename(filename) || path.extname(filename).toLowerCase() !== '.html') {
    throw sourceError('artifact_source_path_invalid', 'The managed HTML artifact filename is invalid.')
  }
  const artifactDirectory = path.resolve(getArtifactDir())
  const filePath = path.resolve(artifactDirectory, filename)
  const relative = path.relative(artifactDirectory, filePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw sourceError('artifact_source_path_invalid', 'The managed HTML artifact path is invalid.')
  }
  try {
    return {
      toolName: 'create_html_app',
      sourceFormat: 'html',
      source: fs.readFileSync(filePath, 'utf8'),
      updatedAt: Math.trunc(fs.statSync(filePath).mtimeMs) || null,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw sourceError('artifact_source_file_missing', 'The managed HTML artifact file no longer exists.')
    }
    throw error
  }
}

/** Read one bounded character page from an already ownership-validated artifact. */
export function readArtifactSourcePage({ artifact, offset = 0, limit = DEFAULT_ARTIFACT_SOURCE_PAGE_CHARS } = {}) {
  const id = String(artifact?.id || '').trim()
  if (!id) throw sourceError('artifact_source_identity_required', 'A managed artifact is required.')
  const start = Math.max(0, Math.floor(Number(offset) || 0))
  const pageSize = Math.min(
    MAX_ARTIFACT_SOURCE_PAGE_CHARS,
    Math.max(1, Math.floor(Number(limit) || DEFAULT_ARTIFACT_SOURCE_PAGE_CHARS)),
  )
  const stored = readArtifactSourceSnapshot(id) || legacyHtmlSource(artifact)
  if (!stored) {
    throw sourceError(
      'artifact_source_unavailable',
      'No editable source snapshot is available for this legacy managed artifact.',
    )
  }
  const totalChars = stored.source.length
  if (start > totalChars) {
    throw sourceError('artifact_source_offset_out_of_range', `offset must be between 0 and ${totalChars}.`)
  }
  const content = stored.source.slice(start, start + pageSize)
  const nextOffset = start + content.length
  return {
    ok: true,
    artifactId: id,
    filename: String(artifact.filename || ''),
    type: String(artifact.type || ''),
    toolName: stored.toolName,
    sourceFormat: stored.sourceFormat,
    offset: start,
    returnedChars: content.length,
    totalChars,
    complete: nextOffset >= totalChars,
    nextOffset: nextOffset < totalChars ? nextOffset : null,
    content,
    updatedAt: stored.updatedAt,
  }
}
