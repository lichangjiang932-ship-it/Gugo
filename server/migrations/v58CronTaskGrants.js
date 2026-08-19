function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

/** Persist scheduled-task provenance and exact per-run authorization grants. */
export function migrateToV58(db) {
  if (hasTable(db, 'cron_jobs') && !hasColumn(db, 'cron_jobs', 'grants_json')) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]'")
  }
  if (!hasTable(db, 'jobs')) return
  if (!hasColumn(db, 'jobs', 'source_type')) {
    db.exec('ALTER TABLE jobs ADD COLUMN source_type TEXT')
  }
  if (!hasColumn(db, 'jobs', 'source_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN source_id TEXT')
  }
  if (!hasColumn(db, 'jobs', 'grants_json')) {
    db.exec("ALTER TABLE jobs ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]'")
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_type, source_id)')
}
