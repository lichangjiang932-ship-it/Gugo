import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getArtifactDir } from './artifactGen.js'

const SOURCE_DIRECTORY_NAME = '.artifact-sources'
const SOURCE_SNAPSHOT_VERSION = 1
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
  return normalized
}

/**
 * Keep the model-authored source beside the generated binary/text artifact,
 * outside chat history and outside the public one-filename download route.
 */
export function writeArtifactSourceSnapshot({ artifactId, toolName, args, deliveryPath, deliveryRoot } = {}) {
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
  let retainedDeliveryPath = typeof deliveryPath === 'string' && path.isAbsolute(deliveryPath.trim())
    ? path.normalize(deliveryPath.trim())
    : ''
  let retainedDeliveryRoot = typeof deliveryRoot === 'string' && path.isAbsolute(deliveryRoot.trim())
    ? path.normalize(deliveryRoot.trim())
    : ''
  if (!retainedDeliveryPath || !retainedDeliveryRoot) {
    try {
      const previous = JSON.parse(fs.readFileSync(sourceSnapshotPath(id), 'utf8'))
      if (!retainedDeliveryPath
        && typeof previous?.deliveryPath === 'string'
        && path.isAbsolute(previous.deliveryPath.trim())) {
        retainedDeliveryPath = path.normalize(previous.deliveryPath.trim())
      }
      if (!retainedDeliveryRoot
        && typeof previous?.deliveryRoot === 'string'
        && path.isAbsolute(previous.deliveryRoot.trim())) {
        retainedDeliveryRoot = path.normalize(previous.deliveryRoot.trim())
      }
    } catch {
      // A first-generation artifact has no previous delivery metadata.
    }
  }
  const snapshot = JSON.stringify({
    version: SOURCE_SNAPSHOT_VERSION,
    artifactId: id,
    toolName: name,
    sourceFormat: 'artifact_tool_arguments_json',
    source,
    ...(retainedDeliveryPath ? { deliveryPath: retainedDeliveryPath } : {}),
    ...(retainedDeliveryRoot ? { deliveryRoot: retainedDeliveryRoot } : {}),
    updatedAt: Date.now(),
  })
  const target = sourceSnapshotPath(id)
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, snapshot, 'utf8')
    // rename-over-existing is not portable to Windows. The temporary file is
    // already complete, so the short replacement window cannot expose a
    // partially written snapshot.
    fs.rmSync(target, { force: true })
    fs.renameSync(temporary, target)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    throw error
  }
  return { artifactId: id, toolName: name, sourceChars: source.length }
}

export function deleteArtifactSourceSnapshot(artifactId) {
  try {
    fs.rmSync(sourceSnapshotPath(artifactId), { force: true })
    return true
  } catch {
    return false
  }
}

export function readArtifactSourceSnapshot(artifactId) {
  const id = String(artifactId || '').trim()
  if (!id) return null
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(sourceSnapshotPath(id), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw sourceError('artifact_source_snapshot_invalid', 'The managed artifact source snapshot is unreadable.')
  }
  if (parsed?.version !== SOURCE_SNAPSHOT_VERSION
    || String(parsed?.artifactId || '') !== id
    || typeof parsed?.source !== 'string') {
    throw sourceError('artifact_source_snapshot_invalid', 'The managed artifact source snapshot is invalid.')
  }
  return {
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
