import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

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
    await fs.promises.unlink(cleanupClaim)
    return true
  } catch {
    // Preserve the unexpected inode at the unique claim path for recovery.
    return false
  }
}

export async function removeOwnedFailedPublication(fullPath, identity, { expectedContents = null } = {}) {
  if (!identity) return false
  const expected = expectedFileContents(expectedContents)
  const cleanupClaim = path.join(path.dirname(fullPath),
    `.artifact-cleanup-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`)
  let ownedHandle = null
  try {
    const current = await fs.promises.lstat(fullPath, { bigint: true })
    if (!sameFileIdentity(current, identity)) return false
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
    // The path disappeared or was replaced. Never remove an unverified path.
    return error?.code === 'ENOENT'
  } finally {
    try { await ownedHandle?.close() } catch { /* best-effort ownership handle close */ }
  }
}
