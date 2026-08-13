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
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024
const MAX_SNAPSHOTS_PER_TURN = 2_000

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
    createdAt: row.created_at,
  }
}

function findExistingSnapshot({ userId, toolCallId, filePath }) {
  return getDb().prepare(`
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
  const existing = findExistingSnapshot({ userId, toolCallId, filePath })
  if (existing) return mapSnapshot(existing)

  const db = getDb()
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM file_snapshots WHERE user_id = ? AND session_id = ? AND turn_id = ?'
  ).get(userId, sessionId, turnId)
  if (Number(count.n) >= MAX_SNAPSHOTS_PER_TURN) return null

  let beforePath = null
  if (beforeContent != null) {
    const bytes = Buffer.isBuffer(beforeContent) ? beforeContent : Buffer.from(String(beforeContent), 'utf8')
    if (bytes.length > MAX_SNAPSHOT_BYTES) return null
    const id = randomUUID()
    beforePath = path.join(ensureSnapshotDir(), `${id}.before`)
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
  db.prepare(`
    INSERT INTO file_snapshots
      (id, user_id, session_id, turn_id, tool_call_id, tool_name, file_path, before_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, sessionId, turnId, toolCallId, toolName, filePath, beforePath, createdAt)
  return mapSnapshot(db.prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId))
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
  if (snapshot.beforePath) {
    // Restore the recorded before-image atomically.
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.rewind.tmp`
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    try {
      fs.copyFileSync(snapshot.beforePath, tempPath)
      fs.renameSync(tempPath, filePath)
    } catch (error) {
      try { fs.unlinkSync(tempPath) } catch { /* best-effort */ }
      throw error
    }
    return { path: filePath, action: 'restored' }
  }
  // The file did not exist before the recorded mutation: rewind deletes it.
  try {
    fs.unlinkSync(filePath)
    return { path: filePath, action: 'deleted' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: filePath, action: 'unchanged' }
    throw error
  }
}

/**
 * Restore a single snapshot by id (owner-scoped). Returns the restore outcome.
 */
export function restoreSnapshot({ userId, id }) {
  if (!userId || !id) throw new Error('restoreSnapshot requires userId and id')
  const row = getDb().prepare('SELECT * FROM file_snapshots WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) return null
  const snapshot = mapSnapshot(row)
  const outcome = restoreOne(snapshot)
  return { snapshot, ...outcome }
}

/**
 * Rewind every file touched by the target tool call and any later tool calls
 * in the same turn, in reverse chronological order. Returns the restored
 * snapshot outcomes and the number of snapshots rewound.
 */
export function rewindFromToolCall({ userId, sessionId, turnId, toolCallId, limit = 2_000 } = {}) {
  if (!userId || !sessionId || !turnId || !toolCallId) {
    throw new Error('rewindFromToolCall requires userId/sessionId/turnId/toolCallId')
  }
  const all = getDb().prepare(`
    SELECT * FROM file_snapshots
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(userId, sessionId, turnId, limit).map(mapSnapshot)

  const targetIndex = all.findIndex((snapshot) => snapshot.toolCallId === toolCallId)
  if (targetIndex === -1) return { rewound: [], count: 0, found: false }

  const toRewind = all.slice(targetIndex).reverse()
  const outcomes = []
  for (const snapshot of toRewind) {
    outcomes.push({ snapshot, ...restoreOne(snapshot) })
  }
  return { rewound: outcomes, count: outcomes.length, found: true }
}

export const _testing = {
  snapshotDir,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOTS_PER_TURN,
}
