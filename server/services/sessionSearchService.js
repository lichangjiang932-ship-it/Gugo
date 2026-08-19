import { getDb } from '../db.js'

function clampLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return 20
  return Math.min(100, Math.floor(value))
}

function clampOffset(offset) {
  const value = Number(offset)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

export function buildFtsQuery(query) {
  const raw = String(query || '').trim()
  if (!raw) return ''
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, ''))
    .filter(Boolean)
    .slice(0, 12)
  if (!tokens.length) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

function mapSearchRow(row) {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title || 'Untitled',
    role: row.role,
    snippet: row.snippet || '',
    createdAt: row.created_at,
    rank: row.rank,
  }
}

export function searchMessages({ userId, query, sessionId = null, limit = 20, offset = 0 } = {}) {
  if (!userId) return []
  const ftsQuery = buildFtsQuery(query)
  if (!ftsQuery) return []

  const params = {
    userId,
    query: ftsQuery,
    ...(sessionId ? { sessionId } : {}),
    limit: clampLimit(limit),
    offset: clampOffset(offset),
  }
  const sessionClause = sessionId ? 'AND m.session_id = @sessionId' : ''
  const rows = getDb().prepare(`
    SELECT
      m.id AS message_id,
      m.session_id AS session_id,
      COALESCE(s.title, m.session_title, '') AS session_title,
      m.role AS role,
      snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
      m.created_at AS created_at,
      bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    JOIN sessions s ON s.token = m.session_id
    WHERE messages_fts MATCH @query
      AND m.user_id = @userId
      ${sessionClause}
    ORDER BY rank, m.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params)
  return rows.map(mapSearchRow)
}
