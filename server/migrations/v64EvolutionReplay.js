export function migrateToV64(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_replay_suites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
      dataset_fingerprint TEXT NOT NULL CHECK (length(dataset_fingerprint) = 64),
      curation_version TEXT NOT NULL,
      source_record_ids_json TEXT NOT NULL,
      cases_json TEXT NOT NULL,
      suite_fingerprint TEXT NOT NULL CHECK (length(suite_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_replay_suites_user_created
      ON evolution_replay_suites(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_replay_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      suite_id TEXT NOT NULL REFERENCES evolution_replay_suites(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      baseline_content TEXT NOT NULL CHECK (length(baseline_content) BETWEEN 1 AND 24000),
      baseline_sha256 TEXT NOT NULL CHECK (length(baseline_sha256) = 64),
      candidate_sha256 TEXT NOT NULL CHECK (length(candidate_sha256) = 64),
      model_name TEXT NOT NULL,
      temperature REAL NOT NULL CHECK (temperature >= 0 AND temperature <= 2),
      max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 4096),
      isolation_mode TEXT NOT NULL CHECK (isolation_mode = 'model_no_tools'),
      results_json TEXT NOT NULL,
      run_fingerprint TEXT NOT NULL CHECK (length(run_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_replay_runs_user_created
      ON evolution_replay_runs(user_id, created_at DESC, id DESC);
  `)
}
