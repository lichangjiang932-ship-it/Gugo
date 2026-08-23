function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Keep recovery-only intent and operator audit outside the replayable outcome.
 * The guards make this safe for databases created from the amended v79 schema.
 */
export function migrateToV80(db) {
  if (!hasColumn(db, 'side_effect_executions', 'intent_json')) {
    db.exec('ALTER TABLE side_effect_executions ADD COLUMN intent_json TEXT')
  }
  if (!hasColumn(db, 'side_effect_executions', 'audit_json')) {
    db.exec('ALTER TABLE side_effect_executions ADD COLUMN audit_json TEXT')
  }
}
