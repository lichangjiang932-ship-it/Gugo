export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function createAuthSessionStore(getDb) {
  function createSession({ token, userId, now = Date.now(), ttlMs = AUTH_SESSION_TTL_MS }) {
    const db = getDb()
    db.prepare('DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?').run(now)
    const result = db.prepare(
      `INSERT INTO sessions (token, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at
       WHERE sessions.id IS NULL AND sessions.title IS NULL AND sessions.user_id = excluded.user_id`
    ).run(token, userId, now + ttlMs, now)
    if (result.changes !== 1) throw new Error('session token already exists')
    return { token, userId, expiresAt: now + ttlMs }
  }

  function getSessionByToken(token, now = Date.now()) {
    return getDb().prepare(`
      SELECT * FROM sessions
      WHERE token = ? AND id IS NULL AND title IS NULL AND expires_at > ?
    `).get(token, now) || null
  }

  function deleteSession(token) {
    getDb().prepare(
      'DELETE FROM sessions WHERE token = ? AND id IS NULL AND title IS NULL'
    ).run(token)
  }

  function deleteExpiredSessions(now = Date.now()) {
    getDb().prepare(
      'DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?'
    ).run(now)
  }

  return {
    createSession,
    deleteExpiredSessions,
    deleteSession,
    getSessionByToken,
  }
}
