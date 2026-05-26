import { getDb } from '../db.js'

function clampLimit(limit, { fallback = 50, max = 100 } = {}) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(max, Math.floor(value))
}

function clampOffset(offset) {
  const value = Number(offset)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function normalizeArchivedFilter(archived = 'false') {
  if (archived === true || archived === 'true') return 'true'
  if (archived === 'all') return 'all'
  return 'false'
}

function mapSession(row) {
  if (!row) return null
  return {
    id: row.id || row.token,
    title: row.title || 'Untitled',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    lastViewedAt: row.last_viewed_at || null,
    archivedAt: row.archived_at || null,
  }
}

export function upsertSession({
  id,
  userId,
  title = 'Untitled',
  createdAt = Date.now(),
  updatedAt = createdAt,
  lastViewedAt = null,
  archivedAt = null,
}) {
  if (!id) throw new Error('session id is required')
  if (!userId) throw new Error('user id is required')
  const db = getDb()
  const row = db.prepare('SELECT token, created_at FROM sessions WHERE token = ? AND user_id = ?').get(id, userId)
  const finalCreatedAt = row?.created_at || createdAt
  db.prepare(`
    INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at, last_viewed_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      id = excluded.id,
      title = excluded.title,
      updated_at = excluded.updated_at,
      last_viewed_at = COALESCE(excluded.last_viewed_at, sessions.last_viewed_at),
      archived_at = excluded.archived_at
  `).run(id, id, userId, title, Number.MAX_SAFE_INTEGER, finalCreatedAt, updatedAt, lastViewedAt, archivedAt)
  return getSession({ userId, sessionId: id })
}

export function getSession({ userId, sessionId }) {
  if (!userId || !sessionId) return null
  const row = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at
    FROM sessions
    WHERE user_id = ? AND token = ? AND title IS NOT NULL
  `).get(userId, sessionId)
  return mapSession(row)
}

export function listSessions({ userId, archived = 'false', limit = 100, offset = 0 } = {}) {
  if (!userId) return []
  const filter = normalizeArchivedFilter(archived)
  const clauses = ['user_id = @userId', 'title IS NOT NULL']
  if (filter === 'true') clauses.push('archived_at IS NOT NULL')
  if (filter === 'false') clauses.push('archived_at IS NULL')
  const rows = getDb().prepare(`
    SELECT token, id, title, created_at, updated_at, last_viewed_at, archived_at
    FROM sessions
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT @limit OFFSET @offset
  `).all({
    userId,
    limit: clampLimit(limit, { fallback: 100, max: 200 }),
    offset: clampOffset(offset),
  })
  return rows.map(mapSession)
}

export function archiveSession({ userId, sessionId, now = Date.now() }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET archived_at = COALESCE(archived_at, ?), updated_at = ?
    WHERE user_id = ? AND token = ? AND title IS NOT NULL
  `).run(now, now, userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function unarchiveSession({ userId, sessionId, now = Date.now() }) {
  if (!userId || !sessionId) return null
  const result = getDb().prepare(`
    UPDATE sessions
    SET archived_at = NULL, updated_at = ?
    WHERE user_id = ? AND token = ? AND title IS NOT NULL
  `).run(now, userId, sessionId)
  if (!result.changes) return null
  return getSession({ userId, sessionId })
}

export function upsertMessage({
  id,
  userId,
  sessionId,
  role,
  content = '',
  createdAt = Date.now(),
  updatedAt = createdAt,
}) {
  if (!id) throw new Error('message id is required')
  if (!userId) throw new Error('user id is required')
  if (!sessionId) throw new Error('session id is required')
  if (!role) throw new Error('message role is required')
  const db = getDb()
  const session = db.prepare(`
    SELECT title FROM sessions
    WHERE user_id = ? AND token = ? AND title IS NOT NULL
  `).get(userId, sessionId)
  if (!session) throw new Error('session not found')
  db.prepare(`
    INSERT INTO messages (id, session_id, user_id, role, content, session_title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      session_title = excluded.session_title,
      updated_at = excluded.updated_at
  `).run(id, sessionId, userId, role, String(content ?? ''), session.title || '', createdAt, updatedAt)
  return {
    id,
    sessionId,
    userId,
    role,
    content: String(content ?? ''),
    createdAt,
    updatedAt,
  }
}

export function deleteMessage({ userId, messageId }) {
  if (!userId || !messageId) return false
  const result = getDb().prepare('DELETE FROM messages WHERE user_id = ? AND id = ?').run(userId, messageId)
  return result.changes > 0
}
