export function migrateToV68(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_canary_rollback_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL CHECK (policy_version = 'canary-rollback-v1'),
      window_size INTEGER NOT NULL CHECK (window_size BETWEEN 3 AND 200),
      minimum_candidate_outcomes INTEGER NOT NULL CHECK (minimum_candidate_outcomes BETWEEN 3 AND 100),
      minimum_baseline_outcomes INTEGER NOT NULL CHECK (minimum_baseline_outcomes BETWEEN 3 AND 100),
      maximum_candidate_failure_rate REAL NOT NULL CHECK (
        maximum_candidate_failure_rate >= 0 AND maximum_candidate_failure_rate <= 1
      ),
      maximum_candidate_cancellation_rate REAL NOT NULL CHECK (
        maximum_candidate_cancellation_rate >= 0 AND maximum_candidate_cancellation_rate <= 1
      ),
      maximum_latency_ratio REAL NOT NULL CHECK (
        maximum_latency_ratio >= 1 AND maximum_latency_ratio <= 10
      ),
      maximum_cost_ratio REAL NOT NULL CHECK (
        maximum_cost_ratio >= 1 AND maximum_cost_ratio <= 10
      ),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      release_fingerprint TEXT NOT NULL CHECK (length(release_fingerprint) = 64),
      policy_fingerprint TEXT NOT NULL CHECK (length(policy_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_rollback_policies_user_created
      ON evolution_canary_rollback_policies(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_outcome_context (
      outcome_id TEXT PRIMARY KEY REFERENCES evolution_canary_outcomes(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_assignments(id) ON DELETE CASCADE,
      effective_variant TEXT NOT NULL CHECK (effective_variant IN ('baseline', 'candidate')),
      decision_reason TEXT NOT NULL CHECK (decision_reason IN (
        'traffic_baseline', 'traffic_candidate', 'baseline_mismatch',
        'baseline_unavailable', 'candidate_provenance_mismatch',
        'rollback_policy_missing'
      )),
      recorded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evolution_canary_rollback_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_rollback_policies(id) ON DELETE CASCADE,
      outcome_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_outcomes(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('insufficient_evidence', 'continue', 'rollback')),
      metrics_json TEXT NOT NULL,
      breaches_json TEXT NOT NULL,
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_rollback_evaluations_release_created
      ON evolution_canary_rollback_evaluations(release_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_rollbacks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_rollback_policies(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_rollback_evaluations(id) ON DELETE CASCADE,
      rollback_baseline_sha256 TEXT NOT NULL CHECK (length(rollback_baseline_sha256) = 64),
      release_fingerprint TEXT NOT NULL CHECK (length(release_fingerprint) = 64),
      baseline_status TEXT NOT NULL CHECK (baseline_status IN ('verified', 'drifted', 'unavailable')),
      observed_baseline_sha256 TEXT CHECK (
        observed_baseline_sha256 IS NULL OR length(observed_baseline_sha256) = 64
      ),
      trigger_fingerprint TEXT NOT NULL CHECK (length(trigger_fingerprint) = 64),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_rollbacks_user_created
      ON evolution_canary_rollbacks(user_id, created_at DESC, id DESC);
  `)
}
