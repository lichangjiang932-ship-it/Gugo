export function migrateToV60(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_states (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_states_enabled
      ON runtime_plugin_states(enabled, updated_at DESC);
  `)
}
