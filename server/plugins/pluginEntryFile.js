import fs from 'node:fs/promises'
import path from 'node:path'

function entryError(code, message) {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
    retryable: false,
  })
}

function sameCanonicalPath(left, right) {
  return path.normalize(left) === path.normalize(right)
}

function isWithinDirectory(directory, candidate) {
  const normalizedDirectory = path.normalize(directory)
  const normalizedCandidate = path.normalize(candidate)
  if (normalizedDirectory === normalizedCandidate) return true
  const prefix = normalizedDirectory.endsWith(path.sep)
    ? normalizedDirectory
    : `${normalizedDirectory}${path.sep}`
  return normalizedCandidate.startsWith(prefix)
}

async function canonicalEntryIdentity(rootDir, entryPath) {
  let canonicalRoot
  let canonicalEntry
  try {
    canonicalRoot = await fs.realpath(rootDir)
    canonicalEntry = await fs.realpath(entryPath)
  } catch {
    throw entryError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取')
  }
  if (!sameCanonicalPath(canonicalRoot, path.resolve(rootDir))) {
    throw entryError('PLUGIN_ENTRY_SCOPE_INVALID', '插件目录已被符号链接或目录联接替换')
  }
  if (!isWithinDirectory(canonicalRoot, canonicalEntry)) {
    throw entryError('PLUGIN_ENTRY_SCOPE_INVALID', '插件入口已越出插件目录')
  }
  return { canonicalRoot, canonicalEntry }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function entryChanged() {
  return entryError('PLUGIN_ENTRY_CHANGED', '插件入口在读取期间发生变化')
}

/**
 * Revalidate a loader-owned plugin entry and read it through the same handle
 * used for fstat. A post-open identity check binds containment to that handle.
 */
export async function readPluginEntryFile({
  rootDir,
  entryPath,
  maxBytes,
  truncate = false,
} = {}) {
  if (typeof rootDir !== 'string' || !rootDir || typeof entryPath !== 'string' || !entryPath) {
    throw entryError('PLUGIN_ENTRY_SCOPE_INVALID', '插件入口缺少可信目录边界')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const initial = await canonicalEntryIdentity(rootDir, entryPath)
  let handle
  try {
    handle = await fs.open(initial.canonicalEntry, 'r')
    const openedStat = await handle.stat({ bigint: true })
    if (!openedStat.isFile()) {
      throw entryError('PLUGIN_ENTRY_INVALID', '插件入口必须是普通文件')
    }
    if (!truncate && openedStat.size > BigInt(maxBytes)) {
      throw entryError('PLUGIN_ENTRY_TOO_LARGE', '插件入口超过大小限制')
    }

    const current = await canonicalEntryIdentity(rootDir, entryPath)
    let currentStat
    try {
      currentStat = await fs.stat(current.canonicalEntry, { bigint: true })
    } catch {
      throw entryError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取')
    }
    if (!sameFileSnapshot(openedStat, currentStat)) throw entryChanged()

    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (!truncate && (offset > maxBytes || BigInt(offset) !== openedStat.size)) {
      throw entryChanged()
    }
    const finalStat = await handle.stat({ bigint: true })
    const finalIdentity = await canonicalEntryIdentity(rootDir, entryPath)
    let finalPathStat
    try {
      finalPathStat = await fs.stat(finalIdentity.canonicalEntry, { bigint: true })
    } catch {
      throw entryChanged()
    }
    if (!sameFileSnapshot(openedStat, finalStat)
      || !sameFileSnapshot(finalStat, finalPathStat)) {
      throw entryChanged()
    }
    const size = finalStat.size > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(finalStat.size)
    return Object.freeze({
      bytes: buffer.subarray(0, Math.min(offset, maxBytes)),
      size,
      truncated: offset > maxBytes || finalStat.size > BigInt(maxBytes),
    })
  } catch (error) {
    if (error?.code?.startsWith?.('PLUGIN_ENTRY_')) throw error
    throw entryError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取')
  } finally {
    await handle?.close().catch(() => {})
  }
}
