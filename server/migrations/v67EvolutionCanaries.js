export function migrateToV67(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_canary_releases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approval_id TEXT NOT NULL REFERENCES evolution_approval_decisions(id) ON DELETE CASCADE,
      evaluation_id TEXT NOT NULL REFERENCES evolution_evaluations(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_replay_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      traffic_percent INTEGER NOT NULL CHECK (traffic_percent BETWEEN 1 AND 10),
      creation_reason TEXT NOT NULL CHECK (length(creation_reason) BETWEEN 1 AND 2000),
      session_ids_json TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      release_fingerprint TEXT NOT NULL CHECK (length(release_fingerprint) = 64),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, approval_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_releases_user_created
      ON evolution_canary_releases(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('started', 'stopped')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_events_release_created
      ON evolution_canary_events(release_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_assignments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      variant TEXT NOT NULL CHECK (variant IN ('baseline', 'candidate')),
      decision_reason TEXT NOT NULL CHECK (decision_reason IN (
        'traffic_baseline', 'traffic_candidate', 'baseline_mismatch',
        'baseline_unavailable', 'candidate_provenance_mismatch'
      )),
      bucket INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 99),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      observed_baseline_sha256 TEXT CHECK (
        observed_baseline_sha256 IS NULL OR length(observed_baseline_sha256) = 64
      ),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      assigned_at INTEGER NOT NULL,
      UNIQUE (user_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_assignments_release_variant
      ON evolution_canary_assignments(release_id, variant, assigned_at DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_outcomes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_assignments(id) ON DELETE CASCADE,
      terminal_state TEXT NOT NULL CHECK (terminal_state IN ('completed', 'failed', 'cancelled')),
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      usage_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_outcomes_release_state
      ON evolution_canary_outcomes(release_id, terminal_state, created_at DESC);
  `)
}
