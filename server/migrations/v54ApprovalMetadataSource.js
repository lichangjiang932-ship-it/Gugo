function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

/** Persist whether an approval's risk came from declared metadata or a fallback rule. */
export function migrateToV54(db) {
  // Production databases have this table from v19. Keeping the migration
  // tolerant makes partial/test databases upgrade safely as well.
  if (!hasTable(db, 'pending_approvals')) return
  if (!hasColumn(db, 'pending_approvals', 'metadata_source')) {
    db.exec(`
      ALTER TABLE pending_approvals
        ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'fallback'
          CHECK (metadata_source IN ('declared','fallback'))
    `)
  }
}
