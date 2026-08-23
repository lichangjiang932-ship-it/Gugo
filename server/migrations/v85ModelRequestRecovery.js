export function migrateToV85(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_request_recovery_resolutions (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      model_request_id TEXT NOT NULL,
      checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence >= 0),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      config_revision INTEGER CHECK (config_revision IS NULL OR config_revision > 0),
      idempotency_key TEXT NOT NULL,
      resolution TEXT NOT NULL CHECK (resolution IN ('unknown', 'not_sent', 'completed')),
      response_json TEXT,
      receipt_json TEXT,
      note TEXT,
      resolved_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, session_id, turn_id, model_request_id),
      CHECK (
        (resolution = 'completed' AND response_json IS NOT NULL AND receipt_json IS NOT NULL)
        OR (resolution IN ('unknown', 'not_sent') AND response_json IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_model_request_recovery_owner_updated
      ON model_request_recovery_resolutions(owner_id, updated_at DESC, session_id, turn_id);
  `)
}
