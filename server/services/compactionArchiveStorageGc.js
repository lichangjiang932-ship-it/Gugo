import fs from 'node:fs'
import path from 'node:path'

import { getDb } from '../db.js'
import {
  resolveCompactionArchiveStorage,
  resolveCompactionArchiveUserStorage,
} from './compactionArchiveStore.js'
import { userDataClearInProgress } from './userDataClearGuard.js'

const ARCHIVE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u
const TEMP_FILE_PATTERN = /^\.[a-f0-9]{64}\.json\.[0-9]+\.[0-9a-f-]+\.tmp$/u
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000

function fileSystemMethod(fileSystem, name) {
  const method = fileSystem?.[name] || fs[name]
  if (typeof method !== 'function') throw new TypeError(`Filesystem operation ${name} is unavailable`)
  return method.bind(fileSystem?.[name] ? fileSystem : fs)
}

function pathExists(fileSystem, target) {
  return fileSystemMethod(fileSystem, 'existsSync')(target)
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return !!relative
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function safeBucket(owner, fileSystem) {
  try {
    const directories = [owner.root, owner.versionRoot, owner.bucketPath]
    for (const directory of directories) {
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    }
    const realRoot = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(owner.root))
    const realBucket = path.resolve(fileSystemMethod(fileSystem, 'realpathSync')(owner.bucketPath))
    return isInside(realRoot, realBucket)
  } catch {
    return false
  }
}

function referencedPaths(db, userId, env) {
  const paths = new Set()
  let protectedBucket = false
  const rows = db.prepare(`
    SELECT id, user_id, storage_path
    FROM compaction_archive
    WHERE user_id = ? AND storage_path IS NOT NULL
  `).all(userId)
  for (const row of rows) {
    try {
      paths.add(resolveCompactionArchiveStorage({
        userId,
        id: row.id,
        storagePath: row.storage_path,
        env,
      }).fullPath)
    } catch {
      protectedBucket = true
    }
  }
  return { paths, protectedBucket }
}

/**
 * Opportunistically remove crash leftovers for one owner. A grace window
 * protects another process between rename and SQLite commit; corrupt metadata
 * protects the entire bucket instead of guessing which file is safe to erase.
 */
export function cleanupCompactionArchiveOrphans({
  userId,
  db = getDb(),
  env = process.env,
  fileSystem = fs,
  now = Date.now(),
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  maxEntries = 10_000,
} = {}) {
  const empty = { scanned: 0, removedFiles: 0, removedBytes: 0, preserved: 0, unsafe: 0 }
  const ownerId = String(userId || '').trim()
  if (!ownerId) return { ...empty, unsafe: 1 }
  if (userDataClearInProgress(db, ownerId)) return { ...empty, preserved: 1 }
  const owner = resolveCompactionArchiveUserStorage({ userId: ownerId, env })
  if (!pathExists(fileSystem, owner.bucketPath)) return empty
  if (!safeBucket(owner, fileSystem)) return { ...empty, unsafe: 1 }
  const referenced = referencedPaths(db, ownerId, env)
  if (referenced.protectedBucket) return { ...empty, preserved: 1 }

  let entries
  try {
    entries = fileSystemMethod(fileSystem, 'readdirSync')(owner.bucketPath, { withFileTypes: true })
  } catch {
    return { ...empty, unsafe: 1 }
  }
  const total = { ...empty }
  const limit = Math.max(0, Number(maxEntries) || 0)
  const cutoff = Number(now) - Math.max(0, Number(orphanGraceMs) || 0)
  for (const entry of entries.slice(0, limit)) {
    total.scanned += 1
    const fullPath = path.join(owner.bucketPath, entry.name)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      total.unsafe += 1
      continue
    }
    if (referenced.paths.has(path.resolve(fullPath))) {
      total.preserved += 1
      continue
    }
    if (!ARCHIVE_FILE_PATTERN.test(entry.name) && !TEMP_FILE_PATTERN.test(entry.name)) {
      total.preserved += 1
      continue
    }
    try {
      const stat = fileSystemMethod(fileSystem, 'lstatSync')(fullPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) {
        total.preserved += 1
        continue
      }
      fileSystemMethod(fileSystem, 'unlinkSync')(fullPath)
      total.removedFiles += 1
      total.removedBytes += stat.size
    } catch {
      total.unsafe += 1
    }
  }
  return total
}
