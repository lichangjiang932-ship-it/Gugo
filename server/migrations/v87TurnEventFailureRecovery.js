function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/** Preserve checkpoint state so an exhausted checkpoint append can be replayed safely. */
export function migrateToV87(db) {
  if (!hasColumn(db, 'event_write_failures', 'checkpoint_state_json')) {
    db.exec(`
      ALTER TABLE event_write_failures
      ADD COLUMN checkpoint_state_json TEXT
    `)
  }
}
