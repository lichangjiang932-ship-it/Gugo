export function migrateToV38(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_execution_leases (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_execution_leases_expiry
      ON job_execution_leases(expires_at);
  `)
}
