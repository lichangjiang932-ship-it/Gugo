export function createRateLimitStore(getDb) {
  function checkRateLimit({ key, windowMs, maxRequests, now = Date.now() }) {
    const db = getDb()
    return db.transaction(() => {
      // Rate-limit windows differ, so cleanup must remain scoped to this key.
      db.prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?')
        .run(key, now - windowMs)

      const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key)
      if (!row) {
        db.prepare(
          'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)'
        ).run(key, now)
        return { allowed: true, remaining: maxRequests - 1 }
      }

      if (row.count >= maxRequests) {
        return { allowed: false, remaining: 0, resetAt: row.window_start + windowMs }
      }

      db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key)
      return { allowed: true, remaining: maxRequests - row.count - 1 }
    })()
  }

  function deleteExpiredRates(now = Date.now()) {
    getDb().prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now)
  }

  return { checkRateLimit, deleteExpiredRates }
}
