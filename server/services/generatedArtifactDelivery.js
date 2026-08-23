import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDefaultOutputDirectory, resolveAuthorizedLocalPath } from './localFileAccessService.js'
import { readArtifactSourceSnapshot, writeArtifactSourceSnapshot } from './artifactSourceStore.js'
import { expandHtmlArtifactAssets } from './htmlArtifactAssets.js'

function samePath(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInsideDirectory(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function deliveryError(code, message, cause = null) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  if (cause) error.cause = cause
  return error
}

function revisionConflict(message, cause = null) {
  return deliveryError('ARTIFACT_DELIVERY_REVISION_CONFLICT', message, cause)
}

function bufferIdentity(content) {
  const value = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return {
    digest: crypto.createHash('sha256').update(value).digest('hex'),
    size: value.length,
  }
}

function fileIdentity(filePath) {
  let descriptor
  try {
    const linkStat = fs.lstatSync(filePath)
    if (linkStat.isSymbolicLink()) {
      throw deliveryError('ARTIFACT_DELIVERY_SYMLINK_BLOCKED', 'refusing to use a symbolic-link delivery target')
    }
    if (!linkStat.isFile()) throw revisionConflict('the recorded delivery target is not a regular file')
    descriptor = fs.openSync(filePath, 'r')
    const before = fs.fstatSync(descriptor)
    const hash = crypto.createHash('sha256')
    const chunk = Buffer.allocUnsafe(256 * 1024)
    let size = 0
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
      size += read
    }
    const after = fs.fstatSync(descriptor)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw revisionConflict('the delivery target changed while its identity was being verified')
    }
    return { digest: hash.digest('hex'), size }
  } catch (error) {
    if (error?.code === 'ENOENT') throw revisionConflict('the recorded delivery target no longer exists', error)
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right)
    && left.digest === right.digest
    && left.size === right.size
}

function snapshotDeliveryIdentity(snapshot) {
  const digest = String(snapshot?.deliveryDigest || '').toLowerCase()
  const size = Number(snapshot?.deliverySize)
  const generation = Number(snapshot?.deliveryGeneration)
  if (!/^[a-f0-9]{64}$/.test(digest)
    || !Number.isSafeInteger(size)
    || size < 0
    || !Number.isSafeInteger(generation)
    || generation < 1) {
    throw revisionConflict('the recorded delivery predates revision-safe content tracking')
  }
  return { digest, size, generation }
}

function copyNewDeliveryFile(sourcePath, directory, filename, content = null) {
  const parsed = path.parse(filename)
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = path.join(
      directory,
      suffix === 1 ? filename : `${parsed.name}-${suffix}${parsed.ext}`,
    )
    try {
      if (content == null) {
        fs.copyFileSync(sourcePath, candidate, fs.constants.COPYFILE_EXCL)
      } else {
        const descriptor = fs.openSync(candidate, 'wx')
        try {
          fs.writeFileSync(descriptor, content)
        } finally {
          fs.closeSync(descriptor)
        }
      }
      return candidate
    } catch (error) {
      if (error?.code === 'EEXIST') continue
      try { fs.rmSync(candidate, { force: true }) } catch { /* best-effort cleanup */ }
      throw error
    }
  }
  throw deliveryError(
    'ARTIFACT_DELIVERY_PATH_EXHAUSTED',
    'could not allocate a unique generated-file delivery path',
  )
}

function replaceDeliveryFile(target, { sourcePath = '', content = null, expectedIdentity } = {}) {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2)}`
  const temporary = `${target}.gugo-${suffix}.tmp`
  const backup = `${target}.gugo-${suffix}.bak`
  let movedToBackup = false
  let installed = false
  try {
    if (content == null) {
      fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL)
    } else {
      fs.writeFileSync(temporary, content, { flag: 'wx' })
    }
    const replacementIdentity = fileIdentity(temporary)
    if (!sameIdentity(fileIdentity(target), expectedIdentity)) {
      throw revisionConflict('the delivered artifact was changed outside this revision')
    }
    try {
      fs.renameSync(target, backup)
      movedToBackup = true
    } catch (error) {
      if (error?.code === 'ENOENT') throw revisionConflict('the recorded delivery target no longer exists', error)
      throw error
    }
    if (!sameIdentity(fileIdentity(backup), expectedIdentity)) {
      throw revisionConflict('the delivered artifact changed before the revision could be installed')
    }
    try {
      // The temporary and target live in the same directory. A hard-link
      // install is atomic and fails if another writer created the target.
      fs.linkSync(temporary, target)
      installed = true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw revisionConflict('another writer changed the delivery target during revision', error)
      }
      throw error
    }
    try { fs.rmSync(temporary, { force: true }) } catch { /* target already owns the complete inode */ }
    if (!sameIdentity(fileIdentity(target), replacementIdentity)) {
      throw revisionConflict('the revised delivery was changed before it could be committed')
    }
    try { fs.rmSync(backup, { force: true }) } catch { /* keep a recoverable stale backup */ }
    return replacementIdentity
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    if (movedToBackup && !installed) {
      try {
        // Never delete or replace a path that appeared after the backup move.
        // Linking fails closed with EEXIST and leaves both versions recoverable.
        fs.linkSync(backup, target)
        fs.rmSync(backup, { force: true })
      } catch { /* current target wins; keep the backup for manual recovery */ }
    }
    throw error
  }
}

function assertSafeRevisionPath({ snapshot, directory, filename, userId }) {
  const candidate = String(snapshot?.deliveryPath || '').trim()
  // A managed-only artifact has never had a local delivery to overwrite. Its
  // first later delivery may safely allocate a new no-clobber pathname.
  if (!candidate) return null
  if (!path.isAbsolute(candidate)) throw revisionConflict('the recorded delivery path is invalid')
  if (path.extname(candidate).toLowerCase() !== path.extname(filename).toLowerCase()) {
    throw deliveryError('ARTIFACT_DELIVERY_FORMAT_MISMATCH', 'recorded artifact delivery format does not match')
  }

  const recordedRoot = String(snapshot?.deliveryRoot || path.dirname(candidate)).trim()
  if (!path.isAbsolute(recordedRoot) || !isInsideDirectory(recordedRoot, candidate)) {
    throw deliveryError('ARTIFACT_DELIVERY_PATH_INVALID', 'recorded artifact delivery path is outside its delivery root')
  }
  let canonicalRoot
  let canonicalParent
  try {
    canonicalRoot = fs.realpathSync(recordedRoot)
    canonicalParent = fs.realpathSync(path.dirname(candidate))
  } catch (cause) {
    throw deliveryError('ARTIFACT_DELIVERY_PATH_UNAVAILABLE', 'recorded artifact delivery directory is unavailable', cause)
  }
  if (!isInsideDirectory(canonicalRoot, canonicalParent)) {
    throw deliveryError('ARTIFACT_DELIVERY_PATH_INVALID', 'recorded artifact delivery parent escapes its delivery root')
  }
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw deliveryError('ARTIFACT_DELIVERY_SYMLINK_BLOCKED', 'refusing to overwrite a symbolic-link delivery target')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (userId) {
    try {
      const authorized = resolveAuthorizedLocalPath({
        userId,
        rawPath: candidate,
        write: true,
        allowMissing: true,
        allowWorkspace: true,
      })
      if (!samePath(authorized.fullPath, candidate)) {
        throw deliveryError('ARTIFACT_DELIVERY_PATH_INVALID', 'authorized delivery path changed during resolution')
      }
    } catch (cause) {
      // The active default directory is trusted by the setting itself. Older
      // delivery roots must still retain an explicit grant (or bypass mode).
      if (!isInsideDirectory(directory, candidate)) {
        throw deliveryError('ARTIFACT_DELIVERY_PATH_NOT_AUTHORIZED', 'recorded artifact delivery path is no longer writable', cause)
      }
    }
  }
  return path.normalize(candidate)
}

/**
 * Keep the managed artifact used by previews/downloads, and additionally put
 * the user-facing file in their configured output directory. A later managed
 * in-place revision reuses the recorded path instead of creating a new copy.
 */
export function syncGeneratedArtifactToOutputDirectory({
  artifact,
  args = {},
  toolName,
  userId = null,
  outputDirectory = '',
} = {}) {
  const rawSourcePath = String(artifact?.fullPath || '').trim()
  const artifactId = String(artifact?.id || '').trim()
  const filename = String(artifact?.filename || '').trim()
  if (!artifactId || !rawSourcePath || !path.isAbsolute(rawSourcePath)
    || !filename || filename !== path.basename(filename)) {
    throw deliveryError('ARTIFACT_DELIVERY_SOURCE_INVALID', 'invalid generated artifact delivery source')
  }
  const sourcePath = fs.realpathSync(rawSourcePath)
  if (!fs.statSync(sourcePath).isFile()) throw new Error('generated artifact delivery source is not a file')
  const standaloneContent = toolName === 'create_html_app'
    ? Buffer.from(expandHtmlArtifactAssets({
      artifactDirectory: path.dirname(sourcePath),
      artifactId,
      html: fs.readFileSync(sourcePath, 'utf8'),
    }), 'utf8')
    : null

  const explicitOutputDirectory = String(outputDirectory || '').trim()
  const configuredOutputDirectory = String(getDefaultOutputDirectory({ userId }) || '').trim()
  const rawRequestedDirectory = explicitOutputDirectory || configuredOutputDirectory
  const requestedDirectory = explicitOutputDirectory && userId
    ? resolveAuthorizedLocalPath({
        userId,
        rawPath: explicitOutputDirectory,
        write: true,
        allowMissing: true,
        allowWorkspace: true,
      }).fullPath
    : path.resolve(rawRequestedDirectory)
  fs.mkdirSync(requestedDirectory, { recursive: true })
  const directory = fs.realpathSync(requestedDirectory)
  const priorSnapshot = readArtifactSourceSnapshot(artifactId)
  const snapshot = artifact?.replaced === true ? priorSnapshot : null
  let deliveryPath = artifact?.replaced === true
    ? assertSafeRevisionPath({ snapshot, directory, filename, userId })
    : null
  const expectedIdentity = deliveryPath ? snapshotDeliveryIdentity(snapshot) : null
  let deliveredIdentity

  if (deliveryPath) {
    let sameFile = samePath(sourcePath, deliveryPath)
    if (!sameFile && fs.existsSync(deliveryPath)) {
      const sourceStat = fs.statSync(sourcePath)
      const deliveryStat = fs.statSync(deliveryPath)
      sameFile = sourceStat.dev === deliveryStat.dev && sourceStat.ino === deliveryStat.ino
    }
    if (sameFile && standaloneContent != null) {
      throw deliveryError('ARTIFACT_DELIVERY_SOURCE_CONFLICT', 'standalone HTML delivery cannot overwrite its managed source')
    }
    if (sameFile && !sameIdentity(fileIdentity(deliveryPath), expectedIdentity)) {
      throw revisionConflict('the delivered artifact was changed outside this revision')
    }
    if (!sameFile && standaloneContent != null) {
      deliveredIdentity = replaceDeliveryFile(deliveryPath, { content: standaloneContent, expectedIdentity })
    } else if (!sameFile) {
      deliveredIdentity = replaceDeliveryFile(deliveryPath, { sourcePath, expectedIdentity })
    } else {
      deliveredIdentity = expectedIdentity
    }
  } else {
    deliveryPath = copyNewDeliveryFile(sourcePath, directory, filename, standaloneContent)
    const intendedIdentity = standaloneContent == null ? fileIdentity(sourcePath) : bufferIdentity(standaloneContent)
    deliveredIdentity = fileIdentity(deliveryPath)
    if (!sameIdentity(deliveredIdentity, intendedIdentity)) {
      throw revisionConflict('the new delivery target changed before it could be recorded')
    }
  }
  const deliveryRoot = snapshot?.deliveryRoot && isInsideDirectory(snapshot.deliveryRoot, deliveryPath)
    ? snapshot.deliveryRoot
    : directory
  if (!sameIdentity(fileIdentity(deliveryPath), deliveredIdentity)) {
    throw revisionConflict('the delivery target changed before its metadata could be committed')
  }
  try {
    writeArtifactSourceSnapshot({
      artifactId,
      toolName,
      args,
      deliveryPath,
      deliveryRoot,
      deliveryDigest: deliveredIdentity.digest,
      deliverySize: deliveredIdentity.size,
      expectedDeliveryGeneration: priorSnapshot?.deliveryGeneration ?? 0,
    })
  } catch (error) {
    if (artifact?.replaced === true && error?.code === 'artifact_source_snapshot_conflict') {
      throw revisionConflict('another revision committed newer delivery metadata', error)
    }
    // The generated file is already delivered. Source-history metadata is
    // best-effort and must not turn a completed file write into a duplicate.
    return {
      path: deliveryPath,
      localPath: deliveryPath,
      outputPath: deliveryPath,
      size: deliveredIdentity.size,
      deliveryMetadataPersisted: false,
      deliveryWarning: error?.message || 'delivery metadata could not be persisted',
    }
  }
  return {
    path: deliveryPath,
    localPath: deliveryPath,
    outputPath: deliveryPath,
    size: deliveredIdentity.size,
    deliveryMetadataPersisted: true,
  }
}
