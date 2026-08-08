function hasTable(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

export function migrateToV40(db) {
  if (!hasTable(db, 'sessions')) return
  if (!hasColumn(db, 'sessions', 'pinned_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_pinned
      ON sessions(user_id, pinned_at DESC);
  `)
}
