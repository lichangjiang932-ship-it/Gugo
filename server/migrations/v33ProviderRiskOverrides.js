function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

export function migrateToV33(db) {
  if (!hasColumn(db, 'model_providers', 'supports_pdf')) {
    db.exec('ALTER TABLE model_providers ADD COLUMN supports_pdf INTEGER')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tool_risk_overrides (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      risk_class TEXT NOT NULL CHECK (risk_class IN ('read','write_local','exec','external')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tool_risk_overrides_user
      ON user_tool_risk_overrides(user_id, tool_name);
  `)
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '33')
}
