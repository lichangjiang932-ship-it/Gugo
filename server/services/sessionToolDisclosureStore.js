import { getDb } from '../db.js'

/**
 * Which tools a conversation has already been shown.
 *
 * Names are stored sorted and de-duplicated so two turns that disclosed the same
 * set produce the same row — the point is to compare them, not to remember the
 * order they arrived in. Anything unreadable degrades to "nothing disclosed",
 * which costs a cache miss and never a wrong tool set.
 */
const MAX_DISCLOSED_TOOLS = 512

/** A conversation untouched for this long is not coming back. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

function normalizeNames(names) {
  return [...new Set(
    (Array.isArray(names) ? names : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  )].sort().slice(0, MAX_DISCLOSED_TOOLS)
}

export function readSessionToolDisclosures({ userId, sessionId } = {}) {
  if (!userId || !sessionId) return []
  try {
    const row = getDb().prepare(
      'SELECT tool_names FROM session_tool_disclosures WHERE user_id = ? AND session_id = ?',
    ).get(String(userId), String(sessionId))
    if (!row?.tool_names) return []
    return normalizeNames(JSON.parse(row.tool_names))
  } catch {
    return []
  }
}

export function writeSessionToolDisclosures({ userId, sessionId, names, now = Date.now() } = {}) {
  if (!userId || !sessionId) return []
  const normalized = normalizeNames(names)
  if (!normalized.length) return normalized
  const stamp = Number(now) || Date.now()
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO session_tool_disclosures (user_id, session_id, tool_names, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, session_id) DO UPDATE SET
        tool_names = excluded.tool_names,
        updated_at = excluded.updated_at
    `).run(String(userId), String(sessionId), JSON.stringify(normalized), stamp)
    // Conversations are not server rows, so there is no delete to hook: a chat
    // removed in the client leaves its row behind. Prune on write instead, which
    // bounds the table without depending on a signal that does not exist.
    db.prepare('DELETE FROM session_tool_disclosures WHERE user_id = ? AND updated_at < ?')
      .run(String(userId), stamp - RETENTION_MS)
  } catch {
    // A disclosure record is an optimization: losing it costs a cache miss.
    return normalized
  }
  return normalized
}

/** Called when a conversation goes away, so the row does not outlive it. */
export function clearSessionToolDisclosures({ userId, sessionId } = {}) {
  if (!sessionId) return 0
  try {
    const statement = userId
      ? getDb().prepare('DELETE FROM session_tool_disclosures WHERE user_id = ? AND session_id = ?')
      : getDb().prepare('DELETE FROM session_tool_disclosures WHERE session_id = ?')
    return statement.run(...(userId ? [String(userId), String(sessionId)] : [String(sessionId)])).changes
  } catch {
    return 0
  }
}

/**
 * The set the next request should carry: everything this conversation has already
 * been shown, plus whatever this turn selected.
 *
 * Growth is the whole point — a tool that has been disclosed stays disclosed, so
 * the prefix stops being rewritten every turn. Narrowing still happens when the
 * user turns a tool off, because the caller resolves these names against the
 * current configuration and a disabled tool simply has no spec to resolve to.
 */
export function unionDisclosedToolNames({ disclosed = [], selected = [] } = {}) {
  return normalizeNames([...disclosed, ...selected])
}
