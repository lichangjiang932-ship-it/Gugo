export function migrateToV65(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      replay_id TEXT NOT NULL REFERENCES evolution_replay_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evolution_candidates(id) ON DELETE CASCADE,
      rubric_version TEXT NOT NULL,
      evaluator_model TEXT NOT NULL,
      independent INTEGER NOT NULL CHECK (independent = 1),
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
      case_assessments_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      evaluation_fingerprint TEXT NOT NULL CHECK (length(evaluation_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_evaluations_user_created
      ON evolution_evaluations(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_evaluations_replay
      ON evolution_evaluations(user_id, replay_id, created_at DESC);
  `)
}
