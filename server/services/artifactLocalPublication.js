import fs from 'node:fs'
import path from 'node:path'
import {
  allocateLocalArtifactPath,
  stableLocalArtifactPath,
} from './artifactLocalPublicationPaths.js'
import {
  artifactPublicationError,
  artifactPublicationLockPath,
  publishedLocalArtifactStat,
  sha256LocalFile,
} from './artifactLocalPublicationRuntime.js'
import {
  artifactPublicationMarkerPath,
  assertPublicationMarker,
  createPublicationMarker,
  expectedPublicationMarker,
  readPublicationMarker,
  recoverInterruptedPublicationMarker,
} from './artifactLocalPublicationMarker.js'
import {
  acquireArtifactPublicationLock,
  releaseArtifactPublicationLock,
  stablePublishedLocalArtifactStat,
} from './artifactLocalPublicationLock.js'
import {
  publishStagedLocalArtifactUnderLock,
  stageLocalArtifactForAttempt,
  verifyPublishedArtifact,
} from './artifactLocalPublicationStaging.js'

function localArtifactAllocationExhausted() {
  return new Error('could not allocate a unique local artifact filename')
}

function copyLocalArtifactExclusiveSync(source, originalFilename) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const artifactPath = allocateLocalArtifactPath(originalFilename)
    try {
      fs.copyFileSync(source, artifactPath.fullPath, fs.constants.COPYFILE_EXCL)
      return artifactPath
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw localArtifactAllocationExhausted()
}

async function copyLocalArtifactExclusive(source, originalFilename) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const artifactPath = allocateLocalArtifactPath(originalFilename)
    try {
      await fs.promises.copyFile(source, artifactPath.fullPath, fs.constants.COPYFILE_EXCL)
      return artifactPath
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw localArtifactAllocationExhausted()
}

/** Copy a verified local tool output into the authenticated artifact store. */
export function createLocalFileArtifact({ sourcePath, filename = '' } = {}) {
  const source = fs.realpathSync(String(sourcePath || ''))
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw new Error('local artifact source must be a file')
  const originalFilename = String(filename || path.basename(source)).normalize('NFC').trim()
  const artifactPath = copyLocalArtifactExclusiveSync(source, originalFilename)
  const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
  return {
    ...artifactPath,
    type: extension || 'file',
    title: originalFilename,
    byteLength: stat.size,
  }
}

async function reconcileExistingPublication({
  artifactPath,
  digest,
  markerPath,
  requestedSource,
  originalFilename,
}) {
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
  if (!existingMarker || !existingStat) return null

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
    // Transient tool output may disappear after a durable managed copy exists.
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

async function publishStableLocalArtifact({
  artifactPath,
  digest,
  markerPath,
  source,
  stat,
  originalFilename,
}) {
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
  let primaryError = null
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
      const temporary = await stageLocalArtifactForAttempt({
        sourcePath: source,
        marker,
        attempt: lock,
      })
      const created = await publishStagedLocalArtifactUnderLock({
        temporary,
        fullPath: artifactPath.fullPath,
        attempt: lock,
      })
      if (!created) {
        if (markerCreated) {
          lock.markerCleanupPending = {
            path: markerPath,
            identity: markerCreated.identity,
            contents: markerCreated.contents,
          }
        }
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
          'Another writer claimed the deterministic artifact target before this publication.',
        )
      }
    }
    const publishedStat = await verifyPublishedArtifact({
      fullPath: artifactPath.fullPath,
      marker,
    })
    if (!publishedStat) {
      throw artifactPublicationError(
        'ARTIFACT_PUBLICATION_MISSING',
        'The managed artifact was not present after publication.',
      )
    }
    lock.destinationCleanupPending = false
    const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
    return {
      ...artifactPath,
      type: extension || 'file',
      title: originalFilename,
      byteLength: publishedStat.size,
      idempotentPublication: true,
      publicationReconciled: !markerCreated,
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await releaseArtifactPublicationLock(lock, primaryError)
  }
}

/** Async variant for media/PDF/image outputs that may be hundreds of MB. */
export async function createLocalFileArtifactAsync({
  sourcePath,
  filename = '',
  publicationKey = '',
} = {}) {
  const requestedSource = String(sourcePath || '')
  const originalFilename = String(filename || path.basename(requestedSource)).normalize('NFC').trim()
  const stablePublication = Boolean(String(publicationKey || '').trim())
  let artifactPath = stablePublication
    ? stableLocalArtifactPath(originalFilename, publicationKey)
    : null
  if (stablePublication) {
    const digest = artifactPath.id.slice('local-'.length)
    const markerPath = artifactPublicationMarkerPath(digest)
    const reconciled = await reconcileExistingPublication({
      artifactPath,
      digest,
      markerPath,
      requestedSource,
      originalFilename,
    })
    if (reconciled) return reconciled
  }

  const source = await fs.promises.realpath(requestedSource)
  const stat = await fs.promises.stat(source)
  if (!stat.isFile()) throw new Error('local artifact source must be a file')
  if (stablePublication) {
    const digest = artifactPath.id.slice('local-'.length)
    return await publishStableLocalArtifact({
      artifactPath,
      digest,
      markerPath: artifactPublicationMarkerPath(digest),
      source,
      stat,
      originalFilename,
    })
  }
  artifactPath = await copyLocalArtifactExclusive(source, originalFilename)
  const extension = path.extname(artifactPath.filename).slice(1).toLowerCase()
  return {
    ...artifactPath,
    type: extension || 'file',
    title: originalFilename,
    byteLength: stat.size,
  }
}
