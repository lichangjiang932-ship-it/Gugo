import { AUTH_SESSION_TTL_MS, createAuthSessionStore } from './authSessionStore.js'

export function createLegacyJsonMigrationStore(getDb) {
  const { createSession } = createAuthSessionStore(getDb)

  function migrateFromJson(store) {
    const db = getDb()
    const now = Date.now()
    const insertUser = db.prepare(
      'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at'
    )
    db.transaction(() => {
      for (const user of Object.values(store.users || {})) {
        const createdAt = user.createdAt || now
        insertUser.run(user.id, user.email, createdAt, createdAt)
      }
      for (const [token, userId] of Object.entries(store.sessions || {})) {
        createSession({ token, userId, now, ttlMs: AUTH_SESSION_TTL_MS })
      }
    })()
  }

  return { migrateFromJson }
}
