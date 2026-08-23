export function migrateToV81(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_promotions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      canary_release_id TEXT NOT NULL UNIQUE
        REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL REFERENCES evolution_approval_decisions(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evolution_evaluations(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_replay_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      promotion_reason TEXT NOT NULL CHECK (length(promotion_reason) BETWEEN 1 AND 2000),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      candidate_content TEXT NOT NULL CHECK (length(candidate_content) > 0),
      canary_release_fingerprint TEXT NOT NULL CHECK (length(canary_release_fingerprint) = 64),
      rollback_policy_fingerprint TEXT NOT NULL CHECK (length(rollback_policy_fingerprint) = 64),
      approval_fingerprint TEXT NOT NULL CHECK (length(approval_fingerprint) = 64),
      replay_fingerprint TEXT NOT NULL CHECK (length(replay_fingerprint) = 64),
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      promotion_fingerprint TEXT NOT NULL UNIQUE CHECK (length(promotion_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotions_user_created
      ON evolution_promotions(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_promotion_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('activated', 'revoked')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotion_events_release_created
      ON evolution_promotion_events(promotion_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_active_promotions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      promotion_id TEXT NOT NULL UNIQUE REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      activated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, target)
    );

    CREATE TABLE IF NOT EXISTS evolution_promotion_assignments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      decision_reason TEXT NOT NULL CHECK (decision_reason = 'production_candidate'),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      observed_baseline_sha256 TEXT CHECK (
        observed_baseline_sha256 IS NULL OR length(observed_baseline_sha256) = 64
      ),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      prompt_content TEXT NOT NULL CHECK (length(prompt_content) > 0),
      promotion_fingerprint TEXT NOT NULL CHECK (length(promotion_fingerprint) = 64),
      assigned_at INTEGER NOT NULL,
      UNIQUE (user_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotion_assignments_release_created
      ON evolution_promotion_assignments(promotion_id, assigned_at DESC);

    CREATE TABLE IF NOT EXISTS evolution_promotion_outcomes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE
        REFERENCES evolution_promotion_assignments(id) ON DELETE CASCADE,
      terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed', 'failed', 'cancelled')),
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      usage_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotion_outcomes_release_state
      ON evolution_promotion_outcomes(promotion_id, terminal_state, created_at DESC);
  `)
}
