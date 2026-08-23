function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

export function migrateToV86(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_turn_checkpoints (
      step_id TEXT PRIMARY KEY REFERENCES job_steps(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_turn_checkpoints_job
      ON job_turn_checkpoints(job_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_turn_checkpoints_user
      ON job_turn_checkpoints(user_id, updated_at DESC);
  `)
  if (!hasColumn(db, 'job_turn_checkpoints', 'revision')) {
    db.exec(`
      ALTER TABLE job_turn_checkpoints
      ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
    `)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_model_request_recovery_resolutions (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES job_steps(id) ON DELETE CASCADE,
      model_request_id TEXT NOT NULL,
      checkpoint_revision INTEGER NOT NULL CHECK (checkpoint_revision > 0),
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
      PRIMARY KEY (owner_id, job_id, step_id, model_request_id),
      CHECK (
        (resolution = 'completed' AND response_json IS NOT NULL AND receipt_json IS NOT NULL)
        OR (resolution IN ('unknown', 'not_sent') AND response_json IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_job_model_request_recovery_owner_updated
      ON job_model_request_recovery_resolutions(owner_id, updated_at DESC, job_id, step_id);
  `)
}
