function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

function hasTable(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)
}

export function migrateToV36(db) {
  if (hasTable(db, 'messages') && !hasColumn(db, 'messages', 'model_context_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN model_context_json TEXT NOT NULL DEFAULT '{}'")
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '36')
}
