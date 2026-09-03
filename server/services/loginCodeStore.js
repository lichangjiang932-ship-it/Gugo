export function createLoginCodeStore(getDb) {
  function createLoginCode({ email, code, now = Date.now(), ttlMs = 10 * 60 * 1000 }) {
    getDb().prepare(
      'INSERT INTO login_codes (email, code, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at'
    ).run(email, code, now + ttlMs, now)
    return { email, code, expiresAt: now + ttlMs }
  }

  function getLoginCode(email) {
    return getDb().prepare('SELECT * FROM login_codes WHERE email = ?').get(email) || null
  }

  function incrementLoginAttempts(email) {
    getDb().prepare(
      'UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?'
    ).run(email)
  }

  function deleteLoginCode(email) {
    getDb().prepare('DELETE FROM login_codes WHERE email = ?').run(email)
  }

  function deleteExpiredCodes(now = Date.now()) {
    getDb().prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now)
  }

  return {
    createLoginCode,
    deleteExpiredCodes,
    deleteLoginCode,
    getLoginCode,
    incrementLoginAttempts,
  }
}
