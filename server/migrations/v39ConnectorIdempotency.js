export function migrateToV39(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_idempotency (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('executing','completed')),
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_connector_idempotency_updated
      ON connector_idempotency(updated_at);
  `)
}
