import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  preservePrimaryPublicationError,
  removeOwnedFailedPublication,
} from './artifactPublicationCleanup.js'
import {
  artifactPublicationAttemptRecordPath,
  artifactPublicationError,
  artifactPublicationLockPath,
  artifactPublicationStagingPath,
  claimedFileIdentityAtPath,
  publishedLocalArtifactStat,
  readJsonFileWithIdentity,
  sameFileIdentity,
} from './artifactLocalPublicationRuntime.js'
import {
  artifactPublicationMarkerPath,
  createPublicationMarker,
  readPublicationMarker,
} from './artifactLocalPublicationMarker.js'
import {
  cleanupCurrentArtifactPublicationAttempt,
  reconcileStaleArtifactPublicationAttempt,
} from './artifactLocalPublicationStaging.js'

const LOCAL_ARTIFACT_LOCK_STALE_MS = 30_000
const LOCAL_ARTIFACT_LOCK_WAIT_MS = 3_000
const LOCAL_ARTIFACT_LOCK_OWNER_VERSION = 3
const activeLocalArtifactPublicationAttempts = new Set()
const endedLocalArtifactPublicationAttempts = new Map()

function readLocalHostIdentityFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

function localHostInstanceId() {
  const networkAddresses = Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .map((address) => String(address?.mac || '').toLowerCase())
    .filter((address) => address && address !== '00:00:00:00:00:00')
    .sort()
  const machineIds = [
    readLocalHostIdentityFile('/etc/machine-id'),
    readLocalHostIdentityFile('/var/lib/dbus/machine-id'),
  ].filter(Boolean)
  return crypto.createHash('sha256').update(JSON.stringify({
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    machineIds,
    networkAddresses,
  })).digest('hex')
}

const LOCAL_HOST_INSTANCE_ID = localHostInstanceId()

function asCleanupFailure(cleanupError, message) {
  if (cleanupError?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED') return cleanupError
  return artifactPublicationError(
    'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
    message,
    cleanupError,
  )
}

export async function releaseArtifactPublicationLock(lock, primaryError = null) {
  try {
    await lock.release()
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError
    throw preservePrimaryPublicationError(primaryError, cleanupError)
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

function publicationLockOwner({ digest, marker, attemptId }) {
  return {
    version: LOCAL_ARTIFACT_LOCK_OWNER_VERSION,
    pid: process.pid,
    hostname: os.hostname(),
    hostInstanceId: LOCAL_HOST_INSTANCE_ID,
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
    && /^[a-f0-9]{64}$/u.test(String(owner.hostInstanceId || ''))
    && Number.isFinite(owner.createdAt)
    && /^[a-f0-9]{32}$/u.test(String(owner.attemptId || ''))
    && owner.publicationDigest === digest
    && owner.artifactId === marker.artifactId
    && owner.filename === marker.filename
    && /^[a-f0-9]{64}$/u.test(String(owner.contentSha256 || ''))
    && Number.isSafeInteger(owner.size)
    && owner.size >= 0
    && owner.stagingFilename
      === path.basename(artifactPublicationStagingPath(digest, owner.attemptId))
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'The stale artifact publication lock does not match this publication identity.',
    )
  }
  return owner
}

function assertPublicationLockOwnerContent(owner, marker) {
  if (owner.contentSha256 !== marker.contentSha256 || owner.size !== marker.size) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'The stale artifact publication lock does not match its durable publication intent.',
    )
  }
}

function assertCurrentPublicationContent(marker, expected) {
  if (marker.contentSha256 !== expected.contentSha256 || marker.size !== expected.size) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
      'The same artifact publication identity was reused with different content.',
    )
  }
}

async function reclaimStaleArtifactPublicationLock(lockPath, publication) {
  const currentIdentity = await claimedFileIdentityAtPath(lockPath)
  if (!currentIdentity) return false
  for (const [attemptId, endedAttempt] of endedLocalArtifactPublicationAttempts) {
    if (endedAttempt.lockPath !== lockPath
      || !sameFileIdentity(currentIdentity, endedAttempt.lockIdentity)) continue
    let owner
    try {
      owner = assertPublicationLockOwner(endedAttempt.owner, publication)
    } catch {
      return false
    }
    if (owner.attemptId !== attemptId) return false
    let cleaned
    try {
      cleaned = await cleanupCurrentArtifactPublicationAttempt({
        lockPath,
        lockIdentity: currentIdentity,
        owner,
        fullPath: publication.fullPath,
        removeDestination: endedAttempt.removeDestination,
        expectedLockContents: endedAttempt.expectedLockContents,
        markerCleanup: endedAttempt.markerCleanup,
      })
    } catch (error) {
      throw asCleanupFailure(
        error,
        'The previous artifact publication attempt still could not be cleaned safely.',
      )
    }
    if (cleaned) endedLocalArtifactPublicationAttempts.delete(attemptId)
    return cleaned
  }

  let observedLock
  try {
    observedLock = await readJsonFileWithIdentity(lockPath)
  } catch {
    // A cooperating owner may still be writing the newly-created lock file.
    return false
  }
  if (!observedLock) return false

  let owner
  try {
    owner = assertPublicationLockOwner(observedLock.value, publication)
  } catch {
    return false
  }
  const sameHost = owner.hostname === os.hostname()
    && owner.hostInstanceId === LOCAL_HOST_INSTANCE_ID
  const activeLocalAttempt = sameHost
    && owner.pid === process.pid
    && activeLocalArtifactPublicationAttempts.has(owner.attemptId)
  if (activeLocalAttempt) return false
  const endedLocalAttempt = sameHost
    && owner.pid === process.pid
    ? endedLocalArtifactPublicationAttempts.get(owner.attemptId)
    : null
  if (endedLocalAttempt) {
    if (!sameFileIdentity(observedLock.identity, endedLocalAttempt.lockIdentity)) return false
    const cleaned = await cleanupCurrentArtifactPublicationAttempt({
      lockPath,
      lockIdentity: observedLock.identity,
      owner,
      fullPath: publication.fullPath,
      removeDestination: endedLocalAttempt.removeDestination,
    })
    if (cleaned) endedLocalArtifactPublicationAttempts.delete(owner.attemptId)
    return cleaned
  }

  const ownerAlive = sameHost ? localProcessIsAlive(Number(owner.pid)) : null
  const staleByAge = Date.now() - Number(owner.createdAt) >= LOCAL_ARTIFACT_LOCK_STALE_MS
  // PID liveness cannot be trusted across hosts, so remote ownership fails closed.
  if (!sameHost || ownerAlive === true || (ownerAlive !== false && !staleByAge)) return false

  const markerPath = artifactPublicationMarkerPath(publication.digest)
  let marker
  try {
    marker = await readPublicationMarker(markerPath, {
      ...publication.marker,
      contentSha256: '',
    })
  } catch {
    return false
  }
  if (!marker) {
    try {
      return await cleanupCurrentArtifactPublicationAttempt({
        lockPath,
        lockIdentity: observedLock.identity,
        owner,
        fullPath: publication.fullPath,
        expectedLockContents: observedLock.contents,
      })
    } catch {
      return false
    }
  }

  try {
    assertPublicationLockOwnerContent(owner, marker)
    assertCurrentPublicationContent(marker, publication.marker)
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
  } catch (error) {
    if (error?.code === 'ARTIFACT_PUBLICATION_CONTENT_DRIFT') throw error
    return false
  }
}

export async function acquireArtifactPublicationLock(lockPath, publication) {
  const deadline = Date.now() + LOCAL_ARTIFACT_LOCK_WAIT_MS
  let attempt = 0
  while (Date.now() <= deadline) {
    const attemptId = crypto.randomBytes(16).toString('hex')
    const owner = publicationLockOwner({
      digest: publication.digest,
      marker: publication.marker,
      attemptId,
    })
    activeLocalArtifactPublicationAttempts.add(attemptId)
    let createdLock
    try {
      createdLock = await createPublicationMarker(lockPath, owner)
    } catch (error) {
      activeLocalArtifactPublicationAttempts.delete(attemptId)
      throw error
    }
    if (!createdLock) {
      activeLocalArtifactPublicationAttempts.delete(attemptId)
      if (await reclaimStaleArtifactPublicationLock(lockPath, publication)) continue
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, Math.min(25 + attempt * 10, 100)))
      continue
    }

    const lockIdentity = createdLock.identity
    const serializedOwner = createdLock.contents
    let releasePromise = null
    const lease = {
      alreadyPublished: false,
      destinationCleanupPending: false,
      markerCleanupPending: null,
      owner,
      lockIdentity,
      stagingPath: artifactPublicationStagingPath(publication.digest, attemptId),
      stageRecordPath: artifactPublicationAttemptRecordPath(
        publication.digest,
        attemptId,
        'stage',
      ),
      destinationRecordPath: artifactPublicationAttemptRecordPath(
        publication.digest,
        attemptId,
        'destination',
      ),
      release: () => {
        if (!releasePromise) {
          releasePromise = (async () => {
            try {
              const cleaned = await cleanupCurrentArtifactPublicationAttempt({
                lockPath,
                lockIdentity,
                owner,
                fullPath: publication.fullPath,
                removeDestination: lease.destinationCleanupPending,
                markerCleanup: lease.markerCleanupPending,
              })
              if (!cleaned) {
                throw artifactPublicationError(
                  'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
                  'The artifact was published, but its publication attempt cleanup could not be confirmed. Retry the publication safely.',
                )
              }
              endedLocalArtifactPublicationAttempts.delete(attemptId)
              return true
            } catch (error) {
              endedLocalArtifactPublicationAttempts.set(attemptId, {
                expectedLockContents: serializedOwner,
                lockIdentity,
                lockPath,
                markerCleanup: lease.markerCleanupPending,
                owner,
                removeDestination: lease.destinationCleanupPending,
              })
              throw asCleanupFailure(
                error,
                'The artifact was published, but its publication attempt cleanup could not be confirmed. Retry the publication safely.',
              )
            } finally {
              activeLocalArtifactPublicationAttempts.delete(attemptId)
            }
          })()
        }
        return releasePromise
      }
    }
    return lease
  }
  throw artifactPublicationError(
    'ARTIFACT_PUBLICATION_BUSY',
    'Another process is still publishing this managed artifact. Retry after it finishes.',
  )
}

export async function stablePublishedLocalArtifactStat(fullPath, digest, publication) {
  const existing = await publishedLocalArtifactStat(fullPath)
  const lockPath = artifactPublicationLockPath(digest)
  try {
    await fs.promises.access(lockPath, fs.constants.F_OK)
  } catch (error) {
    if (error?.code === 'ENOENT') return existing
    throw error
  }

  const lock = await acquireArtifactPublicationLock(lockPath, publication)
  let primaryError = null
  try {
    return await publishedLocalArtifactStat(fullPath)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await releaseArtifactPublicationLock(lock, primaryError)
  }
}
