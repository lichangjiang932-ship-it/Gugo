function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/** Persist the per-user destination used when a file request omits a path. */
export function migrateToV52(db) {
  if (!hasTable(db, 'local_file_access_settings')) {
    db.exec(`
      CREATE TABLE local_file_access_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        all_files_enabled INTEGER NOT NULL DEFAULT 0,
        default_output_directory TEXT,
        updated_at INTEGER NOT NULL
      );
    `)
    return
  }
  if (!hasColumn(db, 'local_file_access_settings', 'default_output_directory')) {
    db.exec('ALTER TABLE local_file_access_settings ADD COLUMN default_output_directory TEXT')
  }
}
