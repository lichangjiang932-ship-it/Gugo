export function migrateToV61(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(token) ON DELETE SET NULL,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_feedback_user_created
      ON evolution_feedback(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_feedback_session
      ON evolution_feedback(user_id, session_id, created_at DESC);
  `)
}
