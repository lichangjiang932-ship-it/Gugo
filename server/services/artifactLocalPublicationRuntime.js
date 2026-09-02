import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACT_DIR, ensureArtifactDir } from './artifactStorage.js'

export const LOCAL_ARTIFACT_LINK_FALLBACK_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
])

export const LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR = '.artifact-publications'

export function artifactPublicationError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.retryable = true
  return error
}

export async function publishedLocalArtifactStat(fullPath) {
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

export function artifactPublicationAttemptRecordPath(digest, attemptId, phase) {
  const directory = path.join(ensureArtifactDir(), LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR)
  return path.join(directory, `.${digest}-${attemptId}.${phase}.json`)
}

export function artifactPublicationStagingPath(digest, attemptId) {
  return path.join(ARTIFACT_DIR, `.publish-${digest.slice(0, 20)}-${attemptId}.tmp`)
}

export function artifactPublicationLockPath(digest) {
  return path.join(ARTIFACT_DIR, `.publish-${digest.slice(0, 32)}.lock`)
}

export async function sha256LocalFile(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export function sameFileIdentity(left, right) {
  if (typeof left?.ino !== 'bigint' || typeof right?.ino !== 'bigint'
    || typeof left?.dev !== 'bigint' || typeof right?.dev !== 'bigint'
    || left.ino === 0n || right.ino === 0n) return false
  return left.dev === right.dev && left.ino === right.ino
}

export function serializeFileIdentity(stat) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint'
    || stat.dev < 0n || stat.ino <= 0n) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_IDENTITY_UNAVAILABLE',
      'The artifact filesystem does not expose a stable file identity.',
    )
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

export function validSerializedFileIdentity(identity) {
  return identity
    && /^(?:0|[1-9]\d*)$/u.test(String(identity.dev || ''))
    && /^[1-9]\d*$/u.test(String(identity.ino || ''))
}

export function fileIdentityFromRecord(identity) {
  if (!validSerializedFileIdentity(identity)) return null
  return { dev: BigInt(identity.dev), ino: BigInt(identity.ino) }
}

export function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

export async function readJsonFileWithIdentity(filePath) {
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

export async function claimedFileIdentityAtPath(filePath) {
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

function publishedArtifactContentDrift(cause = null) {
  return artifactPublicationError(
    'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
    'The managed artifact content no longer matches its durable publication intent.',
    cause,
  )
}

export async function verifiedPublishedLocalArtifactStat(fullPath, marker) {
  let pathBefore
  try {
    pathBefore = await fs.promises.lstat(fullPath, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_INVALID_TARGET',
      'The managed artifact path exists but is not a regular file.',
    )
  }

  let handle = null
  try {
    try {
      handle = await fs.promises.open(fullPath, 'r')
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error?.code)) {
        throw publishedArtifactContentDrift(error)
      }
      throw error
    }

    const openedBefore = await handle.stat({ bigint: true })
    if (!openedBefore.isFile() || !sameFileIdentity(pathBefore, openedBefore)) {
      throw publishedArtifactContentDrift()
    }

    const digest = await openedFileSha256(handle)
    const openedAfter = await handle.stat({ bigint: true })
    if (!sameFileSnapshot(openedBefore, openedAfter)
      || openedAfter.size !== BigInt(marker.size)
      || digest !== marker.contentSha256) {
      throw publishedArtifactContentDrift()
    }

    const stat = await handle.stat()
    const openedConfirmed = await handle.stat({ bigint: true })
    if (!stat.isFile()
      || stat.size !== marker.size
      || !sameFileSnapshot(openedAfter, openedConfirmed)) {
      throw publishedArtifactContentDrift()
    }

    let pathAfter
    try {
      pathAfter = await fs.promises.lstat(fullPath, { bigint: true })
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        throw publishedArtifactContentDrift(error)
      }
      throw error
    }
    if (!pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileSnapshot(openedConfirmed, pathAfter)) {
      throw publishedArtifactContentDrift()
    }
    return stat
  } finally {
    try { await handle?.close() } catch { /* best-effort published artifact close */ }
  }
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

export async function resumeClaimedFileFromTrustedSource({
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
