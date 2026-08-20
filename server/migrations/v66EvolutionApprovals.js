export function migrateToV66(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_approval_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evolution_evaluations(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_replay_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      replay_fingerprint TEXT NOT NULL CHECK (length(replay_fingerprint) = 64),
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      rollback_baseline_sha256 TEXT NOT NULL CHECK (length(rollback_baseline_sha256) = 64),
      rollback_target_json TEXT NOT NULL,
      review_snapshot_json TEXT NOT NULL,
      approver_mode TEXT NOT NULL CHECK (approver_mode = 'local_owner_loopback'),
      decision_fingerprint TEXT NOT NULL CHECK (length(decision_fingerprint) = 64),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, evaluation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_approval_decisions_user_created
      ON evolution_approval_decisions(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_approval_decisions_candidate
      ON evolution_approval_decisions(user_id, candidate_id, created_at DESC);
  `)
}
