export function migrateToV53(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_mode_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_mode TEXT NOT NULL CHECK (from_mode IN ('normal','acceptEdits','plan','bypass')),
      to_mode TEXT NOT NULL CHECK (to_mode IN ('normal','acceptEdits','plan','bypass')),
      transition_kind TEXT NOT NULL CHECK (transition_kind IN ('widened','tightened')),
      justification TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_permission_mode_events_user_time
      ON permission_mode_events(user_id, created_at DESC, id DESC);
  `)
}
