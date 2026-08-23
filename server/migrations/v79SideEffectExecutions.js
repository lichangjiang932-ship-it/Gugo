/**
 * Durable replay-prevention ledger for first-party Shell/File mutations.
 *
 * This does not claim distributed exactly-once delivery. An `executing` row
 * found after a restart is promoted to `unknown` and requires manual review.
 */
export function migrateToV79(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS side_effect_executions (
      owner_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('turn', 'job')),
      scope_key TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      job_id TEXT,
      step_id TEXT,
      tool_call_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_digest TEXT NOT NULL,
      intent_json TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('prepared', 'executing', 'committed', 'failed', 'unknown')),
      outcome_json TEXT,
      audit_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      prepared_at INTEGER NOT NULL,
      executing_at INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (owner_id, scope_key, tool_call_id),
      UNIQUE (owner_id, scope_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_side_effect_executions_status
      ON side_effect_executions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_side_effect_executions_scope
      ON side_effect_executions(owner_id, scope_kind, session_id, turn_id, job_id, step_id);
  `)
}
