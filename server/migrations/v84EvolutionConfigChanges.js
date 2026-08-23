export function migrateToV84(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_config_replays (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      baseline_document_json TEXT NOT NULL,
      proposed_document_json TEXT NOT NULL,
      baseline_document_sha256 TEXT NOT NULL CHECK (length(baseline_document_sha256) = 64),
      proposed_document_sha256 TEXT NOT NULL CHECK (length(proposed_document_sha256) = 64),
      baseline_effective_sha256 TEXT NOT NULL CHECK (length(baseline_effective_sha256) = 64),
      proposed_effective_sha256 TEXT NOT NULL CHECK (length(proposed_effective_sha256) = 64),
      isolation_mode TEXT NOT NULL CHECK (isolation_mode = 'config_parse_no_side_effects'),
      report_json TEXT NOT NULL,
      run_fingerprint TEXT NOT NULL CHECK (length(run_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_config_replays_user_created
      ON evolution_config_replays(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_config_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_config_replays(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
      issues_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, replay_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_config_evaluations_user_created
      ON evolution_config_evaluations(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_config_approval_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evolution_config_evaluations(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_config_replays(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      replay_fingerprint TEXT NOT NULL CHECK (length(replay_fingerprint) = 64),
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      baseline_document_sha256 TEXT NOT NULL CHECK (length(baseline_document_sha256) = 64),
      proposed_document_sha256 TEXT NOT NULL CHECK (length(proposed_document_sha256) = 64),
      review_snapshot_json TEXT NOT NULL,
      approver_mode TEXT NOT NULL CHECK (approver_mode = 'local_owner_loopback'),
      decision_fingerprint TEXT NOT NULL CHECK (length(decision_fingerprint) = 64),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, evaluation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_config_approvals_user_created
      ON evolution_config_approval_decisions(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_config_change_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL REFERENCES evolution_config_approval_decisions(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      root_apply_id TEXT REFERENCES evolution_config_change_events(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN ('apply', 'rollback', 'revoke')),
      before_document_json TEXT NOT NULL,
      after_document_json TEXT NOT NULL,
      before_document_sha256 TEXT NOT NULL CHECK (length(before_document_sha256) = 64),
      after_document_sha256 TEXT NOT NULL CHECK (length(after_document_sha256) = 64),
      expected_current_sha256 TEXT NOT NULL CHECK (length(expected_current_sha256) = 64),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      confirmation_sha256 TEXT NOT NULL CHECK (length(confirmation_sha256) = 64),
      event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_config_changes_user_created
      ON evolution_config_change_events(user_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_config_changes_single_apply
      ON evolution_config_change_events(user_id, approval_id)
      WHERE operation = 'apply';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_config_changes_single_reversal
      ON evolution_config_change_events(user_id, root_apply_id)
      WHERE operation IN ('rollback', 'revoke');
  `)
}
