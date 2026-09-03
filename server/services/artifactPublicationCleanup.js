import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function preservePrimaryPublicationError(primaryError, cleanupError) {
  if (!(primaryError instanceof Error)) {
    return new AggregateError(
      [primaryError, cleanupError],
      'Artifact publication and cleanup both failed.',
    )
  }
  const cause = primaryError.cause
    ? new AggregateError(
        [primaryError.cause, cleanupError],
        'Artifact publication error causes include a cleanup failure.',
      )
    : cleanupError
  try {
    Object.defineProperty(primaryError, 'cause', {
      configurable: true,
      value: cause,
      writable: true,
    })
    return primaryError
  } catch {
    const combined = new AggregateError(
      [primaryError, cleanupError],
      primaryError.message,
      { cause: primaryError },
    )
    if (primaryError.code) combined.code = primaryError.code
    if (primaryError.retryable !== undefined) combined.retryable = primaryError.retryable
    return combined
  }
}

function sameFileIdentity(left, right) {
  if (typeof left?.ino !== 'bigint' || typeof right?.ino !== 'bigint'
    || typeof left?.dev !== 'bigint' || typeof right?.dev !== 'bigint'
    || left.ino === 0n || right.ino === 0n) return false
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function expectedFileContents(value) {
  if (value === null || value === undefined) return null
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8')
}

function cleanupClaimPrefix(fullPath, identity) {
  const normalizedPath = process.platform === 'win32'
    ? path.resolve(fullPath).toLowerCase()
    : path.resolve(fullPath)
  const digest = crypto.createHash('sha256')
    .update(normalizedPath)
    .update('\0')
    .update(String(identity.dev))
    .update(':')
    .update(String(identity.ino))
    .digest('hex')
    .slice(0, 32)
  return `.artifact-cleanup-${digest}-`
}

async function openedFileHasExactContents(handle, expected) {
  if (expected === null) return true
  const before = await handle.stat({ bigint: true })
  if (before.size !== BigInt(expected.length)) return false
  const contents = await handle.readFile()
  const after = await handle.stat({ bigint: true })
  return sameFileSnapshot(before, after) && contents.equals(expected)
}

async function pathHasExactOwnedContents(filePath, identity, expected) {
  if (expected === null) return true
  let handle = null
  try {
    const pathIdentity = await fs.promises.lstat(filePath, { bigint: true })
    if (!sameFileIdentity(pathIdentity, identity)) return false
    handle = await fs.promises.open(filePath, 'r')
    const openedIdentity = await handle.stat({ bigint: true })
    if (!sameFileIdentity(pathIdentity, openedIdentity)) return false
    if (!await openedFileHasExactContents(handle, expected)) return false
    const currentIdentity = await fs.promises.lstat(filePath, { bigint: true })
    return sameFileIdentity(currentIdentity, openedIdentity)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  } finally {
    try { await handle?.close() } catch { /* best-effort ownership probe close */ }
  }
}

async function restoreUnexpectedCleanupClaim(cleanupClaim, fullPath) {
  try {
    // link() is no-clobber: never replace a third owner that claimed the
    // canonical pathname while cleanup was deciding whether to roll back.
    await fs.promises.link(cleanupClaim, fullPath)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    // Preserve the unexpected inode at the unique claim path for recovery.
    return false
  }
  try {
    await fs.promises.unlink(cleanupClaim)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

async function removeRetainedCleanupClaims(fullPath, identity, expected) {
  const directory = path.dirname(fullPath)
  const prefix = cleanupClaimPrefix(fullPath, identity)
  let entries
  try {
    entries = await fs.promises.readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { conflict: false, removed: false }
    throw error
  }

  let removed = false
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    const cleanupClaim = path.join(directory, entry)
    let claimed
    try {
      claimed = await fs.promises.lstat(cleanupClaim, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!sameFileIdentity(claimed, identity)
      || !await pathHasExactOwnedContents(cleanupClaim, claimed, expected)) {
      return { conflict: true, removed }
    }
    try {
      await fs.promises.unlink(cleanupClaim)
      removed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return { conflict: false, removed }
}

export async function removeOwnedFailedPublication(fullPath, identity, { expectedContents = null } = {}) {
  if (!identity) return false
  const expected = expectedFileContents(expectedContents)
  const cleanupPrefix = cleanupClaimPrefix(fullPath, identity)
  const cleanupClaim = path.join(
    path.dirname(fullPath),
    `${cleanupPrefix}${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`,
  )
  let ownedHandle = null
  try {
    const retained = await removeRetainedCleanupClaims(fullPath, identity, expected)
    if (retained.conflict) return false
    let current
    try {
      current = await fs.promises.lstat(fullPath, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
    if (!sameFileIdentity(current, identity)) return retained.removed
    ownedHandle = await fs.promises.open(fullPath, 'r')
    const opened = await ownedHandle.stat({ bigint: true })
    if (!sameFileIdentity(current, opened) || !sameFileIdentity(opened, identity)) return false
    if (!await openedFileHasExactContents(ownedHandle, expected)) return false
    const beforeClaim = await fs.promises.lstat(fullPath, { bigint: true })
    if (!sameFileIdentity(beforeClaim, opened)) return false
    // Avoid path ABA by claiming the current pathname into a unique sibling,
    // while retaining an open handle to the old inode. On POSIX this prevents
    // its inode number from being recycled into a replacement during rename.
    await fs.promises.rename(fullPath, cleanupClaim)
    const claimed = await fs.promises.lstat(cleanupClaim, { bigint: true })
    if (!sameFileIdentity(claimed, opened)
      || !await pathHasExactOwnedContents(cleanupClaim, claimed, expected)) {
      await restoreUnexpectedCleanupClaim(cleanupClaim, fullPath)
      return false
    }
    await fs.promises.unlink(cleanupClaim)
    return true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    // Another cooperating reclaimer may have moved the canonical path after
    // our initial scan. Re-scan the deterministic identity prefix before
    // reporting success so its retained claim cannot lose its durable index.
    const retained = await removeRetainedCleanupClaims(fullPath, identity, expected)
    return !retained.conflict
  } finally {
    try { await ownedHandle?.close() } catch { /* best-effort ownership handle close */ }
  }
}
