export function migrateToV43(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_execution_leases (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      cancel_requested_at INTEGER,
      PRIMARY KEY (user_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_execution_leases_expiry
      ON turn_execution_leases(expires_at);
  `)
}
