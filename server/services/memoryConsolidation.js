/**
 * Memory consolidation — a reflective merge/prune pass over a user's stored
 * memories, the equivalent of Claude Code's `consolidate-memory`.
 *
 * Left alone, `remember` and auto-capture only accumulate: the same fact is
 * re-saved under a new id, and two entries for one topic drift apart. This pass
 * looks over what is already stored and:
 *
 *   1. merges **exact duplicates** (same type, same normalized body) into one
 *      surviving entry — the pinned/newest one — dropping the redundant copies;
 *   2. **flags contradictions** (same normalized title, materially different
 *      bodies) for a human to resolve, and never guesses which is true.
 *
 * It is deliberately conservative. Removing an entry whose slug another memory
 * links to ([[slug]]) would strand that link, so such duplicates are kept (and
 * reported) rather than deleted. `dryRun` defaults to true: a pass reports what
 * it would do and changes nothing until asked.
 */
import { getDb } from '../db.js'

function normalizeBody(body) {
  return String(body || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function normalizeTitle(title) {
  return String(title || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

// The keeper is the entry a reader would want to keep: pinned wins, then the
// most recently updated, then the earliest created (stable across passes).
function pickKeeper(group) {
  return [...group].sort((left, right) => {
    if (left.pinned !== right.pinned) return right.pinned - left.pinned
    if (left.updated_at !== right.updated_at) return right.updated_at - left.updated_at
    return left.created_at - right.created_at
  })[0]
}

function linkedSlugs(db, userId) {
  const rows = db.prepare(
    `SELECT DISTINCT ml.to_slug AS slug FROM memory_links ml
     JOIN memories m ON m.id = ml.from_id WHERE m.user_id = ?`,
  ).all(userId)
  return new Set(rows.map((row) => row.slug))
}

/**
 * @returns {{
 *   total: number,
 *   merged: Array<{ keep: object, remove: object[] }>,
 *   contradictions: Array<{ title: string, entries: object[] }>,
 *   removed: string[],
 *   skippedLinked: string[],
 * }}
 */
export function consolidateMemoryPass({ userId, dryRun = true } = {}) {
  if (!userId) throw new Error('consolidateMemoryPass: userId is required')
  const db = getDb()
  const rows = db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at ASC').all(userId)
  if (rows.length === 0) {
    return { total: 0, merged: [], contradictions: [], removed: [], skippedLinked: [] }
  }

  // 1. exact-duplicate groups by (type, normalized body)
  const byBody = new Map()
  for (const row of rows) {
    const key = `${row.type}\u0000${normalizeBody(row.body)}`
    if (!byBody.has(key)) byBody.set(key, [])
    byBody.get(key).push(row)
  }

  const referenced = linkedSlugs(db, userId)
  const merged = []
  const removed = []
  const skippedLinked = []
  for (const group of byBody.values()) {
    if (group.length < 2) continue
    const keep = pickKeeper(group)
    const remove = group.filter((row) => row.id !== keep.id)
    merged.push({ keep, remove })
    for (const row of remove) {
      // Never delete a memory another entry links to — the [[slug]] would dangle.
      if (referenced.has(row.slug)) { skippedLinked.push(row.id); continue }
      if (!dryRun) db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(row.id, userId)
      removed.push(row.id)
    }
  }

  // 2. contradictions: one title, materially different bodies
  const byTitle = new Map()
  for (const row of rows) {
    const key = normalizeTitle(row.title)
    if (!key) continue
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push(row)
  }
  const contradictions = []
  for (const [title, group] of byTitle) {
    const distinct = new Set(group.map((row) => normalizeBody(row.body)))
    if (group.length > 1 && distinct.size > 1) {
      contradictions.push({ title, entries: group })
    }
  }

  return {
    total: rows.length,
    merged,
    contradictions,
    removed,
    skippedLinked,
  }
}
