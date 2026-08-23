import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HASH_BUFFER_BYTES = 64 * 1024

function snapshotError(code, message, statusCode = 409, cause = null, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}

function fileSystemMethod(fileSystem, name) {
  const method = fileSystem?.[name] || fs[name]
  if (typeof method !== 'function') {
    throw snapshotError(
      'USER_DATA_CLEAR_FILESYSTEM_INCOMPLETE',
      `Filesystem operation ${name} is unavailable`,
      500,
      null,
      { incomplete: true, databaseCleared: false, cleanupPending: true },
    )
  }
  return method.bind(fileSystem?.[name] ? fileSystem : fs)
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function statIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    size: Number(stat.size),
    modifiedAt: Number(stat.mtimeMs),
    changedAt: Number(stat.ctimeMs),
  }
}

function sameIdentity(left, right, { includeSize = true } = {}) {
  const a = statIdentity(left)
  const b = statIdentity(right)
  return a.device === b.device
    && a.inode === b.inode
    && (!includeSize || a.size === b.size)
    && a.modifiedAt === b.modifiedAt
    && a.changedAt === b.changedAt
}

function normalizedLogicalPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!normalized) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function assertSafeEntry({
  root,
  fullPath,
  expectedType,
  fileSystem,
  code,
  message,
}) {
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(fullPath)
  if (resolvedPath !== resolvedRoot && !isInside(resolvedRoot, resolvedPath)) {
    throw snapshotError(code, message)
  }
  try {
    const relativeParts = path.relative(resolvedRoot, resolvedPath).split(path.sep).filter(Boolean)
    let cursor = resolvedRoot
    let rootRealPath = null
    for (const part of ['', ...relativeParts]) {
      if (part) cursor = path.join(cursor, part)
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(cursor)
      const isFinal = cursor === resolvedPath
      if (stat.isSymbolicLink()) throw snapshotError(code, message)
      if (!isFinal && !stat.isDirectory()) throw snapshotError(code, message)
      if (!rootRealPath) {
        if (!stat.isDirectory()) throw snapshotError(code, message)
        rootRealPath = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(cursor))
      }
      const realCursor = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(cursor))
      if (realCursor !== rootRealPath && !isInside(rootRealPath, realCursor)) {
        throw snapshotError(code, message)
      }
    }
    const stat = fileSystemMethod(fileSystem, 'lstatSync')(resolvedPath)
    if (expectedType === 'file' && !stat.isFile()) throw snapshotError(code, message)
    if (expectedType === 'directory' && !stat.isDirectory()) throw snapshotError(code, message)
    return stat
  } catch (error) {
    if (error?.code === code) throw error
    throw snapshotError(code, message, 409, error)
  }
}

function hashStableFile({ root, fullPath, fileSystem, code, message }) {
  let descriptor = null
  try {
    const pathStat = assertSafeEntry({
      root,
      fullPath,
      expectedType: 'file',
      fileSystem,
      code,
      message,
    })
    descriptor = fileSystemMethod(fileSystem, 'openSync')(
      fullPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    )
    const before = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    if (!before.isFile() || !sameIdentity(pathStat, before)) throw snapshotError(code, message)
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    while (true) {
      const bytesRead = fileSystemMethod(fileSystem, 'readSync')(
        descriptor,
        buffer,
        0,
        buffer.length,
        null,
      )
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fileSystemMethod(fileSystem, 'fstatSync')(descriptor)
    const finalPathStat = assertSafeEntry({
      root,
      fullPath,
      expectedType: 'file',
      fileSystem,
      code,
      message,
    })
    if (!sameIdentity(before, after) || !sameIdentity(after, finalPathStat)) {
      throw snapshotError(code, message)
    }
    return { ...statIdentity(after), sha256: hash.digest('hex') }
  } catch (error) {
    if (error?.code === code) throw error
    throw snapshotError(code, message, 409, error)
  } finally {
    if (descriptor !== null) {
      try { fileSystemMethod(fileSystem, 'closeSync')(descriptor) } catch { /* preserve snapshot result */ }
    }
  }
}

function snapshotDigest(entries) {
  const digest = crypto.createHash('sha256')
  for (const entry of entries) {
    digest.update(JSON.stringify(entry))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export function captureUserDataFileSnapshot({
  root,
  selections = [],
  namespace,
  fileSystem = fs,
  code = 'USER_DATA_CLEAR_PREVIEW_UNSAFE',
  message = 'Managed local data changed or crossed its storage boundary',
} = {}) {
  const resolvedRoot = path.resolve(root)
  const safeNamespace = normalizedLogicalPath(namespace)
  if (!safeNamespace) throw snapshotError(code, message)
  const byPath = new Map()
  const visit = ({ fullPath, type, logicalPath }) => {
    const resolvedPath = path.resolve(fullPath)
    if (!fileSystemMethod(fileSystem, 'existsSync')(resolvedPath)) return
    const logical = normalizedLogicalPath(logicalPath)
    if (!logical) throw snapshotError(code, message)
    if (type === 'file') {
      const identity = hashStableFile({
        root: resolvedRoot,
        fullPath: resolvedPath,
        fileSystem,
        code,
        message,
      })
      byPath.set(`${safeNamespace}/${logical}`, {
        path: `${safeNamespace}/${logical}`,
        type: 'file',
        size: identity.size,
        sha256: identity.sha256,
      })
      return
    }
    const before = assertSafeEntry({
      root: resolvedRoot,
      fullPath: resolvedPath,
      expectedType: 'directory',
      fileSystem,
      code,
      message,
    })
    byPath.set(`${safeNamespace}/${logical}`, {
      path: `${safeNamespace}/${logical}`,
      type: 'directory',
    })
    const children = fileSystemMethod(fileSystem, 'readdirSync')(resolvedPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        throw snapshotError(code, message)
      }
      visit({
        fullPath: path.join(resolvedPath, child.name),
        type: child.isDirectory() ? 'directory' : 'file',
        logicalPath: `${logical}/${child.name}`,
      })
    }
    const after = assertSafeEntry({
      root: resolvedRoot,
      fullPath: resolvedPath,
      expectedType: 'directory',
      fileSystem,
      code,
      message,
    })
    if (!sameIdentity(before, after)) throw snapshotError(code, message)
  }

  for (const selection of selections) {
    const resolvedPath = path.resolve(selection.fullPath)
    const logicalPath = selection.logicalPath
      || path.relative(resolvedRoot, resolvedPath).split(path.sep).join('/')
    visit({ fullPath: resolvedPath, type: selection.type || 'file', logicalPath })
  }
  const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  return {
    entries,
    digest: snapshotDigest(entries),
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    totalBytes: entries.reduce((total, entry) => (
      total + (entry.type === 'file' ? entry.size : 0)
    ), 0),
  }
}

export function mergeUserDataFileSnapshots(...snapshots) {
  const byPath = new Map()
  for (const snapshot of snapshots.filter(Boolean)) {
    for (const entry of snapshot.entries || []) {
      const previous = byPath.get(entry.path)
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
        throw snapshotError(
          'USER_DATA_CLEAR_PREVIEW_UNSAFE',
          'Managed local data resolves to conflicting filesystem identities',
        )
      }
      byPath.set(entry.path, entry)
    }
  }
  const entries = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
  return {
    entries,
    digest: snapshotDigest(entries),
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    totalBytes: entries.reduce((total, entry) => (
      total + (entry.type === 'file' ? entry.size : 0)
    ), 0),
  }
}

export function assertUserDataFileSnapshot(expected, actual, {
  code = 'USER_DATA_CLEAR_PREVIEW_CHANGED',
  message = 'Local files changed after the impact preview; review the refreshed impact before clearing',
  details = { incomplete: false, databaseCleared: false, cleanupPending: false },
} = {}) {
  if (!expected || !actual || expected.digest !== actual.digest) {
    throw snapshotError(code, message, 409, null, details)
  }
}

export const _testing = {
  snapshotDigest,
}
