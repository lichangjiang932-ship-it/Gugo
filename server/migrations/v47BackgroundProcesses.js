/**
 * Background processes launched by the agent. Only metadata lives in SQLite;
 * stdout/stderr are redirected to a log file under the data directory. A
 * process is detached from the server lifecycle so a long-running local server,
 * scraper, or build keeps working while the agent continues with other calls.
 */
export function migrateToV47(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_processes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      turn_id TEXT,
      tool_call_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT,
      pid INTEGER,
      log_path TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_background_processes_user
      ON background_processes(user_id, created_at DESC);
  `)
}
