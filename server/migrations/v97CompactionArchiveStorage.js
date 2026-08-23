function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

function hasTable(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

/**
 * Move new compaction archive bodies out of SQLite while keeping legacy rows
 * readable. Nullable metadata distinguishes legacy inline JSON from the
 * file-backed representation.
 */
export function migrateToV97(db) {
  if (!hasTable(db, 'compaction_archive')) return
  if (!hasColumn(db, 'compaction_archive', 'storage_path')) {
    db.exec('ALTER TABLE compaction_archive ADD COLUMN storage_path TEXT')
  }
  if (!hasColumn(db, 'compaction_archive', 'size_bytes')) {
    db.exec('ALTER TABLE compaction_archive ADD COLUMN size_bytes INTEGER')
  }
  if (!hasColumn(db, 'compaction_archive', 'sha256')) {
    db.exec('ALTER TABLE compaction_archive ADD COLUMN sha256 TEXT')
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_archive_storage_path
      ON compaction_archive(storage_path)
      WHERE storage_path IS NOT NULL
  `)
}
