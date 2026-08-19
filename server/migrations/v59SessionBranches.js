function hasTable(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Persist chat-session lineage without changing the legacy auth-session rows
 * that share the sessions table. All new columns stay nullable for those rows.
 */
export function migrateToV59(db) {
  if (!hasTable(db, 'sessions')) return
  if (!hasColumn(db, 'sessions', 'parent_session_id')) {
    db.exec(`
      ALTER TABLE sessions
      ADD COLUMN parent_session_id TEXT REFERENCES sessions(token) ON DELETE SET NULL
    `)
  }
  if (!hasColumn(db, 'sessions', 'branch_label')) {
    db.exec('ALTER TABLE sessions ADD COLUMN branch_label TEXT')
  }
  if (!hasColumn(db, 'sessions', 'forked_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN forked_at INTEGER')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_parent
      ON sessions(user_id, parent_session_id, forked_at ASC);
  `)
}
