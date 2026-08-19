/** Keep exhausted write-behind failures durable without retaining foreign keys. */
export function migrateToV57(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_write_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      session_id TEXT,
      turn_id TEXT,
      event_id TEXT,
      event_sequence INTEGER,
      event_type TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 3,
      failed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_write_failures_turn
      ON event_write_failures(user_id, session_id, turn_id, failed_at DESC);
  `)
}
