function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

function hasTable(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

/**
 * Persist the immutable executor recovery proof prepared at the execution
 * boundary. Existing ledger rows remain byte-for-byte unchanged.
 */
export function migrateToV96(db) {
  if (!hasTable(db, 'side_effect_executions')) return
  if (!hasColumn(db, 'side_effect_executions', 'recovery_json')) {
    db.exec('ALTER TABLE side_effect_executions ADD COLUMN recovery_json TEXT')
  }
}
