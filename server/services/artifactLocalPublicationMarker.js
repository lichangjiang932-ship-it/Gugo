import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { removeOwnedFailedPublication } from './artifactPublicationCleanup.js'
import { ensureArtifactDir } from './artifactStorage.js'
import {
  LOCAL_ARTIFACT_LINK_FALLBACK_CODES,
  LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR,
  artifactPublicationError,
  readJsonFileWithIdentity,
  sameFileIdentity,
  serializeFileIdentity,
  validSerializedFileIdentity,
} from './artifactLocalPublicationRuntime.js'

const LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION = 1
const LOCAL_ARTIFACT_PUBLICATION_MARKER_VERSION = 1

export async function cleanupLinkedPublicationRecordTemporaries(
  recordPath,
  recordIdentity,
  expectedContents,
) {
  const directory = path.dirname(recordPath)
  const prefix = `.${path.basename(recordPath)}-`
  let entries
  try {
    entries = await fs.promises.readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    const temporary = path.join(directory, entry)
    let observed
    try {
      observed = await readJsonFileWithIdentity(temporary)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!observed || !sameFileIdentity(observed.identity, recordIdentity)) continue
    if (!observed.contents.equals(Buffer.from(expectedContents))) return false
    try {
      await fs.promises.unlink(temporary)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return true
}

export function artifactPublicationMarkerPath(digest) {
  const directory = path.join(ensureArtifactDir(), LOCAL_ARTIFACT_PUBLICATION_MARKER_DIR)
  fs.mkdirSync(directory, { recursive: true })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_MARKER_UNSAFE',
      'The artifact publication marker directory is not a trusted local directory.',
    )
  }
  return path.join(directory, `${digest}.json`)
}

export function expectedPublicationMarker({ artifactPath, digest, contentSha256, size }) {
  return {
    version: LOCAL_ARTIFACT_PUBLICATION_MARKER_VERSION,
    publicationDigest: digest,
    artifactId: artifactPath.id,
    filename: artifactPath.filename,
    contentSha256,
    size,
  }
}

export function assertPublicationMarker(marker, expected) {
  const valid = marker
    && marker.version === expected.version
    && marker.publicationDigest === expected.publicationDigest
    && marker.artifactId === expected.artifactId
    && marker.filename === expected.filename
    && /^[a-f0-9]{64}$/u.test(String(marker.contentSha256 || ''))
    && Number.isSafeInteger(marker.size)
    && marker.size >= 0
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
      'The stable artifact target has no valid ownership marker for this execution.',
    )
  }
  if (expected.contentSha256
    && (marker.contentSha256 !== expected.contentSha256 || marker.size !== expected.size)) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_CONTENT_DRIFT',
      'The same artifact publication identity was reused with different content.',
    )
  }
  return marker
}

export async function readPublicationMarker(markerPath, expected) {
  let lastError = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const observed = await readJsonFileWithIdentity(markerPath)
      if (!observed) return null
      const marker = assertPublicationMarker(observed.value, expected)
      if (!await cleanupLinkedPublicationRecordTemporaries(
        markerPath,
        observed.identity,
        observed.contents,
      )) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
          'The artifact publication marker staging link could not be cleaned safely.',
        )
      }
      return marker
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      lastError = error
      if (!(error instanceof SyntaxError)
        && error?.code !== 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT') break
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  if (lastError?.code === 'ARTIFACT_PUBLICATION_CLEANUP_FAILED') throw lastError
  const incomplete = lastError instanceof SyntaxError
  throw artifactPublicationError(
    incomplete
      ? 'ARTIFACT_PUBLICATION_MARKER_INCOMPLETE'
      : 'ARTIFACT_PUBLICATION_OWNERSHIP_CONFLICT',
    incomplete
      ? 'The stable artifact ownership marker was interrupted before it became valid.'
      : 'The stable artifact ownership marker is unreadable.',
    lastError,
  )
}

export async function createPublicationMarker(markerPath, marker) {
  const temporary = path.join(
    path.dirname(markerPath),
    `.${path.basename(markerPath)}-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  )
  const serializedMarker = JSON.stringify(marker)
  let handle = null
  let markerIdentity
  try {
    handle = await fs.promises.open(temporary, 'wx')
    markerIdentity = await handle.stat({ bigint: true })
    await handle.writeFile(serializedMarker, 'utf8')
    await handle.sync()
    markerIdentity = await handle.stat({ bigint: true })
    await handle.close()
    handle = null
    try {
      // Publish the already-fsynced inode atomically without replacing a winner.
      await fs.promises.link(temporary, markerPath)
      const publishedIdentity = await fs.promises.lstat(markerPath, { bigint: true })
      if (!sameFileIdentity(publishedIdentity, markerIdentity)) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
          'The artifact publication marker was replaced immediately after it was claimed.',
        )
      }
      return { identity: markerIdentity, contents: serializedMarker }
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      if (LOCAL_ARTIFACT_LINK_FALLBACK_CODES.has(error?.code)) {
        throw artifactPublicationError(
          'ARTIFACT_PUBLICATION_MARKER_ATOMIC_UNSUPPORTED',
          'The artifact filesystem cannot atomically publish ownership markers.',
          error,
        )
      }
      throw error
    }
  } finally {
    try { await handle?.close() } catch { /* best-effort marker close */ }
    try { await fs.promises.unlink(temporary) } catch { /* best-effort marker staging cleanup */ }
  }
}

export async function recoverInterruptedPublicationMarker(markerPath, expected) {
  const canonical = Buffer.from(JSON.stringify(expected), 'utf8')
  let handle = null
  let openedIdentity
  let observedContents
  try {
    const pathIdentity = await fs.promises.lstat(markerPath, { bigint: true })
    if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()) return false
    if (pathIdentity.size >= BigInt(canonical.length)) return false
    handle = await fs.promises.open(markerPath, 'r')
    openedIdentity = await handle.stat({ bigint: true })
    if (!sameFileIdentity(pathIdentity, openedIdentity)) return false
    observedContents = await handle.readFile()
    if (observedContents.length >= canonical.length
      || !canonical.subarray(0, observedContents.length).equals(observedContents)) {
      return false
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  } finally {
    try { await handle?.close() } catch { /* best-effort interrupted marker close */ }
  }

  try {
    return await removeOwnedFailedPublication(markerPath, openedIdentity, {
      expectedContents: observedContents,
    })
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

export function attemptRecord({ phase, owner, identity }) {
  return {
    version: LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION,
    phase,
    attemptId: owner.attemptId,
    publicationDigest: owner.publicationDigest,
    artifactId: owner.artifactId,
    filename: owner.filename,
    contentSha256: owner.contentSha256,
    size: owner.size,
    fileIdentity: serializeFileIdentity(identity),
  }
}

function assertAttemptRecord(record, { phase, owner }) {
  const valid = record
    && record.version === LOCAL_ARTIFACT_ATTEMPT_RECORD_VERSION
    && record.phase === phase
    && record.attemptId === owner.attemptId
    && record.publicationDigest === owner.publicationDigest
    && record.artifactId === owner.artifactId
    && record.filename === owner.filename
    && record.contentSha256 === owner.contentSha256
    && record.size === owner.size
    && validSerializedFileIdentity(record.fileIdentity)
  if (!valid) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      `The stale artifact ${phase} record does not match its publication lock.`,
    )
  }
  return record
}

export async function createAttemptRecord(recordPath, record) {
  const created = await createPublicationMarker(recordPath, record)
  if (!created) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_RECOVERY_CONFLICT',
      'An artifact publication attempt record already exists for this attempt.',
    )
  }
}

export async function removeValidatedJsonRecord(recordPath, expectedValue) {
  const observed = await readJsonFileWithIdentity(recordPath)
  if (!observed || JSON.stringify(observed.value) !== JSON.stringify(expectedValue)) return false
  if (!await cleanupLinkedPublicationRecordTemporaries(
    recordPath,
    observed.identity,
    observed.contents,
  )) return false
  return await removeOwnedFailedPublication(recordPath, observed.identity, {
    expectedContents: observed.contents,
  })
}

export async function readAttemptRecord(recordPath, phase, owner) {
  const observed = await readJsonFileWithIdentity(recordPath)
  if (!observed) return null
  if (!await cleanupLinkedPublicationRecordTemporaries(
    recordPath,
    observed.identity,
    observed.contents,
  )) {
    throw artifactPublicationError(
      'ARTIFACT_PUBLICATION_CLEANUP_FAILED',
      `The stale artifact ${phase} record staging link could not be cleaned safely.`,
    )
  }
  return {
    ...observed,
    value: assertAttemptRecord(observed.value, { phase, owner }),
  }
}
