function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/** Persist declarative JSON argument matchers for hooks. */
export function migrateToV49(db) {
  // Some legacy databases reported a recent schema version despite never
  // creating the hooks table. V48 intentionally no-ops when the table is
  // absent, so V49 must be able to repair that state instead of only altering
  // a healthy V48 table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_pattern TEXT,
      argument_matcher_json TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('shell','http')),
      command TEXT,
      url TEXT,
      headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      blocking INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  if (!hasColumn(db, 'hooks', 'argument_matcher_json')) {
    db.exec('ALTER TABLE hooks ADD COLUMN argument_matcher_json TEXT;')
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_hooks_user_event ON hooks(user_id, event, enabled);')
}
