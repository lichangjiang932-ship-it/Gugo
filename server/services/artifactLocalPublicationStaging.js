import fs from 'node:fs'
import {
  preservePrimaryPublicationError,
  removeOwnedFailedPublication,
} from './artifactPublicationCleanup.js'
import {
  LOCAL_ARTIFACT_LINK_FALLBACK_CODES,
  artifactPublicationAttemptRecordPath,
  artifactPublicationError,
  artifactPublicationStagingPath,
  claimedFileIdentityAtPath,
  fileIdentityFromRecord,
  publishedLocalArtifactStat,
  resumeClaimedFileFromTrustedSource,
  sameFileIdentity,
  sha256LocalFile,
  verifiedPublishedLocalArtifactStat,
} from './artifactLocalPublicationRuntime.js'
import {
  attemptRecord,
  cleanupLinkedPublicationRecordTemporaries,
  createAttemptRecord,
  readAttemptRecord,
  removeValidatedJsonRecord,
} from './artifactLocalPublicationMarker.js'

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

function cleanupFailure(message, cause) {
  return artifactPublicationError(
    'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
    message,
    cause,
  )
}

export async function cleanupCurrentArtifactPublicationAttempt({
  lockPath,
  lockIdentity,
  owner,
  fullPath,
  removeDestination = false,
  expectedLockContents = JSON.stringify(owner),
  markerCleanup = null,
}) {
  const stagingPath = artifactPublicationStagingPath(owner.publicationDigest, owner.attemptId)
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
  const stage = await readAttemptRecord(stageRecordPath, 'stage', owner)
  const destination = await readAttemptRecord(destinationRecordPath, 'destination', owner)
  if (removeDestination) {
    if (destination) {
      if (!await removeOwnedFailedPublication(
        fullPath,
        fileIdentityFromRecord(destination.value.fileIdentity),
      )) return false
      if (!await removeValidatedJsonRecord(destinationRecordPath, destination.value)) return false
    } else if (await publishedLocalArtifactStat(fullPath)) {
      return false
    }
  }
  if (stage) {
    if (!await removeOwnedFailedPublication(
      stagingPath,
      fileIdentityFromRecord(stage.value.fileIdentity),
    )) return false
    if (!await removeValidatedJsonRecord(stageRecordPath, stage.value)) return false
  } else if (await publishedLocalArtifactStat(stagingPath)) {
    return false
  }
  if (!removeDestination && destination
    && !await removeValidatedJsonRecord(destinationRecordPath, destination.value)) {
    return false
  }
  if (markerCleanup
    && !await removeOwnedFailedPublication(
      markerCleanup.path,
      markerCleanup.identity,
      { expectedContents: markerCleanup.contents },
    )) return false

  if (expectedLockContents !== null
    && !await cleanupLinkedPublicationRecordTemporaries(
      lockPath,
      lockIdentity,
      expectedLockContents,
    )) return false

  return await removeOwnedFailedPublication(lockPath, lockIdentity, {
    expectedContents: expectedLockContents,
  })
}

export async function reconcileStaleArtifactPublicationAttempt({
  owner,
  marker,
  fullPath,
  sourcePath,
}) {
  const stagingPath = artifactPublicationStagingPath(owner.publicationDigest, owner.attemptId)
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
  let stage = await readAttemptRecord(stageRecordPath, 'stage', owner)
  let destination = await readAttemptRecord(destinationRecordPath, 'destination', owner)
  let stageStat = await publishedLocalArtifactStat(stagingPath)
  let targetStat = await publishedLocalArtifactStat(fullPath)
  let stagePathIdentity = await claimedFileIdentityAtPath(stagingPath)
  let targetPathIdentity = await claimedFileIdentityAtPath(fullPath)

  // An unrecorded path cannot be proven to belong to the crashed publisher.
  if (!stage && stageStat) return false
  if (stageStat
    && !sameFileIdentity(
      stagePathIdentity,
      fileIdentityFromRecord(stage.value.fileIdentity),
    )) return false
  if (targetStat && !destination) {
    try {
      await verifyPublishedArtifact({ fullPath, marker })
    } catch {
      return false
    }
  }
  if (destination && targetStat
    && !sameFileIdentity(
      targetPathIdentity,
      fileIdentityFromRecord(destination.value.fileIdentity),
    )) return false
  if (destination && !targetStat) {
    if (!await removeValidatedJsonRecord(destinationRecordPath, destination.value)) return false
    destination = null
  }
  if (stage && !stageStat) {
    if (!await removeValidatedJsonRecord(stageRecordPath, stage.value)) return false
    stage = null
  }

  if (stageStat) {
    const stageIdentity = fileIdentityFromRecord(stage.value.fileIdentity)
    if (stageStat.size !== marker.size
      || await sha256LocalFile(stagingPath) !== marker.contentSha256) {
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
      if (error?.code !== 'ARTIFACT_PUBLICATION_CONTENT_DRIFT' || !stageStat) return false
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
  } else if (!targetStat && stageStat) {
    const recoveredAttempt = { owner, destinationRecordPath }
    if (!await publishStagedLocalArtifactUnderLock({
      temporary: stagingPath,
      fullPath,
      attempt: recoveredAttempt,
    })) return false
    targetStat = await verifyPublishedArtifact({ fullPath, marker })
  }

  if (!targetStat && stageStat) return false
  if (stageStat
    && !await removeOwnedFailedPublication(
      stagingPath,
      fileIdentityFromRecord(stage.value.fileIdentity),
    )) return false
  const latestDestination = destination
    || await readAttemptRecord(destinationRecordPath, 'destination', owner)
  return await cleanupAttemptRecords({
    owner,
    stageRecord: stage?.value || null,
    destinationRecord: latestDestination?.value || null,
  })
}

export async function stageLocalArtifactForAttempt({ sourcePath, marker, attempt }) {
  let staging = null
  let stagingIdentity = null
  let stageRecord = null
  try {
    staging = await fs.promises.open(attempt.stagingPath, 'wx')
    stagingIdentity = await staging.stat({ bigint: true })
    stageRecord = attemptRecord({
      phase: 'stage',
      owner: attempt.owner,
      identity: stagingIdentity,
    })
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
    try {
      const stagingRemoved = await removeOwnedFailedPublication(attempt.stagingPath, stagingIdentity)
      if (stageRecord && stagingRemoved) {
        await removeValidatedJsonRecord(attempt.stageRecordPath, stageRecord)
      }
    } catch (cleanupError) {
      throw preservePrimaryPublicationError(error, cleanupFailure(
        'The staged artifact failed and its recovery record cleanup also failed.',
        cleanupError,
      ))
    }
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
    // Keep the destination recoverable until the caller has verified the
    // completed artifact through its bound handle and pathname identity.
    attempt.destinationCleanupPending = true
    await destination.close()
    destination = null
    const copied = await resumeClaimedFileFromTrustedSource({
      sourcePath: temporary,
      destinationPath: fullPath,
      destinationIdentity,
      marker: attempt.owner,
    })
    if (!copied) {
      throw artifactPublicationError(
        'ARTIFACT_PUBLICATION_SOURCE_DRIFT',
        'The staged artifact changed while its managed destination was being published.',
      )
    }
    return true
  } catch (error) {
    try { await destination?.close() } catch { /* best-effort handle cleanup */ }
    try {
      const destinationRemoved = await removeOwnedFailedPublication(fullPath, destinationIdentity)
      attempt.destinationCleanupPending = !destinationRemoved
      if (destinationRecord && destinationRemoved) {
        await removeValidatedJsonRecord(attempt.destinationRecordPath, destinationRecord)
      }
    } catch (cleanupError) {
      attempt.destinationCleanupPending = true
      throw preservePrimaryPublicationError(error, cleanupFailure(
        'The destination artifact failed and its recovery record cleanup also failed.',
        cleanupError,
      ))
    }
    throw error
  }
}

export async function publishStagedLocalArtifactUnderLock({ temporary, fullPath, attempt }) {
  if (await publishedLocalArtifactStat(fullPath)) return false
  try {
    await fs.promises.link(temporary, fullPath)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (!LOCAL_ARTIFACT_LINK_FALLBACK_CODES.has(error?.code)) throw error
  }

  // O_EXCL preserves no-clobber semantics on filesystems without hard links.
  return await copyStagedLocalArtifactExclusive(temporary, fullPath, attempt)
}

export async function verifyPublishedArtifact({ fullPath, marker }) {
  return await verifiedPublishedLocalArtifactStat(fullPath, marker)
}
