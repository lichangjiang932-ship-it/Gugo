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

function replaceDeliveryFile(target, { sourcePath = '', content = null } = {}) {
  const suffix = `${process.pid}-${Math.random().toString(16).slice(2)}`
  const temporary = `${target}.gugo-${suffix}.tmp`
  const backup = `${target}.gugo-${suffix}.bak`
  let backedUp = false
  try {
    if (content == null) {
      fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_EXCL)
    } else {
      fs.writeFileSync(temporary, content, { flag: 'wx' })
    }
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup)
      backedUp = true
    }
    fs.renameSync(temporary, target)
    if (backedUp) fs.rmSync(backup, { force: true })
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    try {
      if (backedUp) {
        fs.rmSync(target, { force: true })
        fs.renameSync(backup, target)
      }
    } catch { /* keep the backup for manual recovery */ }
    throw error
  }
}

function assertSafeRevisionPath({ snapshot, directory, filename, userId }) {
  const candidate = String(snapshot?.deliveryPath || '').trim()
  if (!candidate || !path.isAbsolute(candidate)) return null
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

  const requestedDirectory = path.resolve(
    String(outputDirectory || getDefaultOutputDirectory({ userId }) || '').trim(),
  )
  fs.mkdirSync(requestedDirectory, { recursive: true })
  const directory = fs.realpathSync(requestedDirectory)
  const snapshot = artifact?.replaced === true ? readArtifactSourceSnapshot(artifactId) : null
  let deliveryPath = artifact?.replaced === true
    ? assertSafeRevisionPath({ snapshot, directory, filename, userId })
    : null

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
    if (!sameFile && standaloneContent != null) {
      replaceDeliveryFile(deliveryPath, { content: standaloneContent })
    } else if (!sameFile) {
      replaceDeliveryFile(deliveryPath, { sourcePath })
    }
  } else {
    deliveryPath = copyNewDeliveryFile(sourcePath, directory, filename, standaloneContent)
  }
  const deliveryRoot = snapshot?.deliveryRoot && isInsideDirectory(snapshot.deliveryRoot, deliveryPath)
    ? snapshot.deliveryRoot
    : directory
  try {
    writeArtifactSourceSnapshot({
      artifactId,
      toolName,
      args,
      deliveryPath,
      deliveryRoot,
    })
  } catch (error) {
    // The generated file is already delivered. Source-history metadata is
    // best-effort and must not turn a completed file write into a duplicate.
    return {
      path: deliveryPath,
      localPath: deliveryPath,
      outputPath: deliveryPath,
      size: fs.statSync(deliveryPath).size,
      deliveryMetadataPersisted: false,
      deliveryWarning: error?.message || 'delivery metadata could not be persisted',
    }
  }
  const stat = fs.statSync(deliveryPath)
  return {
    path: deliveryPath,
    localPath: deliveryPath,
    outputPath: deliveryPath,
    size: stat.size,
    deliveryMetadataPersisted: true,
  }
}
