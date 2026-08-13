function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Store runtime limits per model instead of applying one provider-level value
 * to every model exposed by that provider. The legacy context_window column is
 * intentionally retained as a provider fallback for existing installations.
 * Jobs also retain the selected model so resumed work uses the same model and
 * context window after a server restart.
 */
export function migrateToV45(db) {
  if (!hasColumn(db, 'model_providers', 'model_profiles_json')) {
    db.exec(`
      ALTER TABLE model_providers
      ADD COLUMN model_profiles_json TEXT NOT NULL DEFAULT '{}';
    `)
  }
  if (!hasColumn(db, 'jobs', 'model_name')) {
    db.exec(`
      ALTER TABLE jobs
      ADD COLUMN model_name TEXT;
    `)
  }
}
