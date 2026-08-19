export function migrateToV63(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_candidates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('prompt', 'plugin', 'config')),
      target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 160),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
      content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 24000),
      assumptions_json TEXT NOT NULL,
      expected_impact_json TEXT NOT NULL,
      permissions_requested_json TEXT NOT NULL,
      dataset_fingerprint TEXT NOT NULL CHECK (length(dataset_fingerprint) = 64),
      curation_version TEXT NOT NULL,
      source_record_ids_json TEXT NOT NULL,
      source_evidence_ids_json TEXT NOT NULL,
      generator_model TEXT,
      generator_mode TEXT NOT NULL CHECK (generator_mode = 'background_model_no_tools'),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_candidates_user_created
      ON evolution_candidates(user_id, created_at DESC, id DESC);
  `)
}
