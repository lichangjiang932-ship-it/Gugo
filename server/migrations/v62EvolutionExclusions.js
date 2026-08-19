export function migrateToV62(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_evidence_exclusions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, evidence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_exclusions_user_created
      ON evolution_evidence_exclusions(user_id, created_at DESC, evidence_id);
  `)
}
