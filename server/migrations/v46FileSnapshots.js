/**
 * Durable before-image snapshots for file-mutating tools so a turn (or a
 * single tool call) can be rewound after the model edits the wrong file or
 * takes the work in the wrong direction. Only metadata lives in SQLite; the
 * before content is stored as a sibling file under the snapshot directory so
 * large files never bloat the database.
 */
export function migrateToV46(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_snapshots_user
      ON file_snapshots(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_file_snapshots_turn
      ON file_snapshots(user_id, session_id, turn_id);
  `)
}
