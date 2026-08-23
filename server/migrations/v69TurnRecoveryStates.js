/** Persist bounded recovery retries and dead letters across process restarts. */
export function migrateToV69(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_recovery_states (
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      candidate_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('retrying', 'dead_letter')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
      first_failed_at INTEGER NOT NULL,
      last_failed_at INTEGER NOT NULL,
      next_retry_at INTEGER,
      error_code TEXT,
      error_message TEXT NOT NULL,
      PRIMARY KEY (user_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_recovery_states_due
      ON turn_recovery_states(status, next_retry_at);
  `)
}
