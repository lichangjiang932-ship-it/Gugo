/**
 * Durable before-image snapshots for file-mutating tools.
 *
 * The tool loop records a snapshot before every write_file / edit_file (and
 * apply_patch / bash mutation where targets are known). SQLite stores only the
 * metadata; the before content lives as an ordinary file under the snapshot
 * directory so rewinding large files never bloats the database.
 *
 * Rewind semantics: rewindFromToolCall restores every file touched by the
 * target tool call and everything after it, in reverse order, so the working
 * tree returns to the state it had before that tool call ran.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { assertUserDataMutationAllowed } from './userDataClearGuard.js'

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024
const MAX_SNAPSHOTS_PER_TURN = 2_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
let afterClaimVerifiedHook = null

function snapshotDir() {
  const dataDir = process.env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')
  return path.join(dataDir, 'snapshots')
}

function ensureSnapshotDir() {
  const dir = snapshotDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function mapSnapshot(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    filePath: row.file_path,
    beforePath: row.before_path || null,
    existedBefore: row.before_path != null,
    afterExists: row.after_exists == null ? null : row.after_exists === 1,
    afterSha256: row.after_sha256 || null,
    afterBytes: row.after_bytes == null ? null : Number(row.after_bytes),
    finalizedAt: row.finalized_at == null ? null : Number(row.finalized_at),
    createdAt: row.created_at,
  }
}

function snapshotConflict(snapshot, reason, observed = null) {
  return Object.assign(new Error(
    `Cannot restore ${snapshot?.filePath || 'file'} because it no longer matches the snapshot post-write state.`,
  ), {
    code: 'FILE_SNAPSHOT_CONFLICT',
    statusCode: 409,
    retryable: false,
    reason,
    path: snapshot?.filePath || null,
    snapshotId: snapshot?.id || null,
    ...(observed ? { observed } : {}),
  })
}

function normalizeAfterIdentity({ afterExists, afterSha256, afterBytes } = {}) {
  if (typeof afterExists !== 'boolean') throw new TypeError('afterExists must be a boolean')
  if (!afterExists) return { exists: false, sha256: null, bytes: null }
  const sha256 = String(afterSha256 || '').trim()
  const bytes = Number(afterBytes)
  if (!SHA256_PATTERN.test(sha256)) throw new TypeError('afterSha256 must be a lowercase SHA-256 digest')
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('afterBytes must be a non-negative safe integer')
  return { exists: true, sha256, bytes }
}

function readFileIdentity(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    throw error
  }
  if (!stat.isFile()) {
    return {
      exists: true,
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other',
    }
  }
  const content = fs.readFileSync(filePath)
  return {
    exists: true,
    type: 'file',
    bytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

function expectedAfterIdentity(snapshot) {
  if (snapshot.afterExists == null || snapshot.finalizedAt == null) {
    throw snapshotConflict(snapshot, 'snapshot_not_finalized')
  }
  try {
    return normalizeAfterIdentity({
      afterExists: snapshot.afterExists,
      afterSha256: snapshot.afterSha256,
      afterBytes: snapshot.afterBytes,
    })
  } catch {
    throw snapshotConflict(snapshot, 'invalid_after_identity')
  }
}

function identitiesMatch(expected, observed) {
  if (expected.exists !== observed.exists) return false
  if (!expected.exists) return true
  return observed.type === 'file'
    && observed.bytes === expected.bytes
    && observed.sha256 === expected.sha256
}

function publishFileNoClobber(sourcePath, targetPath) {
  try {
    fs.linkSync(sourcePath, targetPath)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    try {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
    } catch (copyError) {
      if (copyError?.code === 'EEXIST') return false
      throw copyError
    }
  }
  fs.unlinkSync(sourcePath)
  return true
}

function restoreClaimNoClobber(claimPath, targetPath) {
  try {
    return publishFileNoClobber(claimPath, targetPath)
  } catch {
    return false
  }
}

function claimConflict(snapshot, reason, observed, claimPath) {
  const restored = claimPath
    ? restoreClaimNoClobber(claimPath, snapshot.filePath)
    : false
  const error = snapshotConflict(snapshot, reason, observed)
  if (!restored && claimPath && fs.existsSync(claimPath)) error.recoveryPath = claimPath
  return error
}

function findExistingSnapshot({ userId, toolCallId, filePath }, db = getDb()) {
  return db.prepare(`
    SELECT * FROM file_snapshots
    WHERE user_id = ? AND tool_call_id = ? AND file_path = ?
    LIMIT 1
  `).get(userId, toolCallId, filePath)
}

/**
 * Persist the before-image of one file mutation. Idempotent per tool call +
 * path so a resumed/idempotent execution never records two snapshots.
 *
 * beforeContent === null means the file did not exist (rewind deletes it).
 */
export function recordFileSnapshot({
  userId,
  sessionId,
  turnId,
  toolCallId,
  toolName,
  filePath,
  beforeContent = null,
  createdAt = Date.now(),
} = {}) {
  if (!userId || !sessionId || !turnId || !toolCallId || !filePath) {
    throw new Error('snapshot requires userId/sessionId/turnId/toolCallId/filePath')
  }
  const db = getDb()
  return db.transaction(() => {
    assertUserDataMutationAllowed(db, userId, 'File snapshots cannot change while local data is being cleared')
    const existing = findExistingSnapshot({ userId, toolCallId, filePath }, db)
    if (existing) return mapSnapshot(existing)
    const count = db.prepare(
      'SELECT COUNT(*) AS n FROM file_snapshots WHERE user_id = ? AND session_id = ? AND turn_id = ?'
    ).get(userId, sessionId, turnId)
    if (Number(count.n) >= MAX_SNAPSHOTS_PER_TURN) return null

    let beforePath = null
    if (beforeContent != null) {
      const bytes = Buffer.isBuffer(beforeContent) ? beforeContent : Buffer.from(String(beforeContent), 'utf8')
      if (bytes.length > MAX_SNAPSHOT_BYTES) return null
      const beforeId = randomUUID()
      beforePath = path.join(ensureSnapshotDir(), `${beforeId}.before`)
      const tempPath = `${beforePath}.${process.pid}.tmp`
      try {
        fs.writeFileSync(tempPath, bytes, { flag: 'wx', mode: 0o600 })
        fs.renameSync(tempPath, beforePath)
      } catch (error) {
        try { fs.unlinkSync(tempPath) } catch { /* best-effort cleanup */ }
        throw error
      }
    }

    const id = randomUUID()
    try {
      db.prepare(`
        INSERT INTO file_snapshots
          (id, user_id, session_id, turn_id, tool_call_id, tool_name, file_path, before_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, sessionId, turnId, toolCallId, toolName, filePath, beforePath, createdAt)
    } catch (error) {
      if (beforePath) {
        try { fs.unlinkSync(beforePath) } catch { /* preserve database error */ }
      }
      throw error
    }
    return mapSnapshot(db.prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId))
  }).immediate()
}

export function finalizeFileSnapshot({
  userId,
  id,
  afterExists,
  afterSha256 = null,
  afterBytes = null,
  finalizedAt = Date.now(),
} = {}) {
  if (!userId || !id) throw new Error('finalizeFileSnapshot requires userId and id')
  const identity = normalizeAfterIdentity({ afterExists, afterSha256, afterBytes })
  const timestamp = Number(finalizedAt)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('finalizedAt must be a non-negative safe integer')
  }
  const db = getDb()
  return db.transaction(() => {
    assertUserDataMutationAllowed(db, userId, 'File snapshots cannot change while local data is being cleared')
    const row = db.prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId)
    if (!row) return null
    const snapshot = mapSnapshot(row)
    if (snapshot.finalizedAt != null || snapshot.afterExists != null) {
      const existing = expectedAfterIdentity(snapshot)
      const candidate = identity.exists
        ? { exists: true, type: 'file', bytes: identity.bytes, sha256: identity.sha256 }
        : { exists: false }
      if (!identitiesMatch(existing, candidate)) {
        throw snapshotConflict(snapshot, 'conflicting_finalization')
      }
      return snapshot
    }
    const updated = db.prepare(`
      UPDATE file_snapshots
      SET after_exists = ?, after_sha256 = ?, after_bytes = ?, finalized_at = ?
      WHERE id = ? AND user_id = ?
        AND after_exists IS NULL AND finalized_at IS NULL
    `).run(
      identity.exists ? 1 : 0,
      identity.sha256,
      identity.bytes,
      timestamp,
      id,
      userId,
    )
    if (updated.changes !== 1) throw snapshotConflict(snapshot, 'concurrent_finalization')
    return mapSnapshot(db.prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId))
  }).immediate()
}

export function listSnapshots({ userId, sessionId, turnId, limit = 500 } = {}) {
  if (!userId || !sessionId || !turnId) return []
  const lim = Math.min(2_000, Math.max(1, Number(limit) || 500))
  return getDb().prepare(`
    SELECT * FROM file_snapshots
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, sessionId, turnId, lim).map(mapSnapshot)
}

function restoreOne(snapshot) {
  const filePath = snapshot.filePath
  const expected = expectedAfterIdentity(snapshot)
  let claimPath = null
  if (expected.exists) {
    claimPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.snapshot-claim`,
    )
    try {
      fs.renameSync(filePath, claimPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw snapshotConflict(snapshot, 'current_file_changed', { exists: false })
      }
      throw error
    }
    const observed = readFileIdentity(claimPath)
    if (!identitiesMatch(expected, observed)) {
      throw claimConflict(snapshot, 'current_file_changed', observed, claimPath)
    }
  } else {
    const observed = readFileIdentity(filePath)
    if (observed.exists) throw snapshotConflict(snapshot, 'current_file_changed', observed)
  }

  try {
    afterClaimVerifiedHook?.({ snapshot, claimPath, filePath })
    if (!snapshot.beforePath) {
      const recreated = readFileIdentity(filePath)
      if (recreated.exists) {
        throw claimConflict(snapshot, 'target_recreated_during_restore', recreated, claimPath)
      }
      if (claimPath) fs.unlinkSync(claimPath)
      return { path: filePath, action: 'deleted' }
    }

    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.rewind.tmp`
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    try {
      fs.copyFileSync(snapshot.beforePath, tempPath, fs.constants.COPYFILE_EXCL)
      if (!publishFileNoClobber(tempPath, filePath)) {
        const recreated = readFileIdentity(filePath)
        throw claimConflict(snapshot, 'target_recreated_during_restore', recreated, claimPath)
      }
    } finally {
      try { fs.unlinkSync(tempPath) } catch { /* already published or best-effort cleanup */ }
    }
    if (claimPath) fs.unlinkSync(claimPath)
    return { path: filePath, action: 'restored' }
  } catch (error) {
    if (claimPath && fs.existsSync(claimPath) && error?.code !== 'FILE_SNAPSHOT_CONFLICT') {
      const restored = restoreClaimNoClobber(claimPath, filePath)
      if (!restored && fs.existsSync(claimPath)) error.recoveryPath = claimPath
    }
    throw error
  }
}

/**
 * Restore a single snapshot by id (owner-scoped). Returns the restore outcome.
 */
export function restoreSnapshot({ userId, id }) {
  if (!userId || !id) throw new Error('restoreSnapshot requires userId and id')
  const db = getDb()
  return db.transaction(() => {
    assertUserDataMutationAllowed(db, userId, 'Files cannot be restored while local data is being cleared')
    const row = db.prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId)
    if (!row) return null
    const snapshot = mapSnapshot(row)
    const outcome = restoreOne(snapshot)
    return { snapshot, ...outcome }
  }).immediate()
}

/**
 * Rewind every file touched by the target tool call and any later tool calls
 * in the same turn, in reverse chronological order. Returns the restored
 * snapshot outcomes and the number of snapshots rewound.
 */
export function rewindFromToolCall({ userId, sessionId, turnId, toolCallId = null, limit = 2_000 } = {}) {
  if (!userId || !sessionId || !turnId) {
    throw new Error('rewindFromToolCall requires userId/sessionId/turnId')
  }
  const db = getDb()
  return db.transaction(() => {
    assertUserDataMutationAllowed(db, userId, 'Files cannot be rewound while local data is being cleared')
    const all = db.prepare(`
      SELECT * FROM file_snapshots
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(userId, sessionId, turnId, limit).map(mapSnapshot)

    let targetIndex
    if (toolCallId) {
      targetIndex = all.findIndex((snapshot) => snapshot.toolCallId === toolCallId)
    } else {
      // No target means rewind every mutation recorded for this turn.
      targetIndex = all.length > 0 ? 0 : -1
    }
    if (targetIndex === -1) return { rewound: [], count: 0, found: false }

    const toRewind = all.slice(targetIndex).reverse()
    const outcomes = []
    for (const snapshot of toRewind) {
      try {
        outcomes.push({ snapshot, ...restoreOne(snapshot) })
      } catch (error) {
        error.partialCount = outcomes.length
        error.partialRewind = outcomes.map((entry) => ({
          snapshotId: entry.snapshot.id,
          path: entry.path,
          action: entry.action,
        }))
        throw error
      }
    }
    return { rewound: outcomes, count: outcomes.length, found: true }
  }).immediate()
}

export const _testing = {
  snapshotDir,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOTS_PER_TURN,
  setAfterClaimVerifiedHook(hook) {
    afterClaimVerifiedHook = typeof hook === 'function' ? hook : null
  },
}
