/** Durable, user-scoped execution records for model-backed evolution work. */
export function migrateToV88(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_operations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('candidate', 'replay', 'evaluation')),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'blocked', 'failed', 'completed')),
      stage TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 200),
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      result_type TEXT CHECK (result_type IS NULL OR result_type IN ('candidate', 'replay', 'evaluation')),
      result_id TEXT,
      error_code TEXT,
      error_message TEXT,
      worker_token TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(user_id, kind, idempotency_key),
      CHECK ((state = 'completed' AND result_type IS NOT NULL AND result_id IS NOT NULL)
        OR state <> 'completed'),
      CHECK ((state = 'running' AND worker_token IS NOT NULL)
        OR (state <> 'running' AND worker_token IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_operations_user_created
      ON evolution_operations(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_operations_recovery
      ON evolution_operations(state, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_evolution_operations_result
      ON evolution_operations(user_id, result_type, result_id);
  `)
}
