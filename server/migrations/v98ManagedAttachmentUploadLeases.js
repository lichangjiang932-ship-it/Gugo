/**
 * Durable cross-process upload leases close the gap between the clear journal
 * check and publishing attachment metadata/files. A clear may only start when
 * no live upload lease exists for that user.
 */
export function migrateToV98(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_attachment_upload_leases (
      upload_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lease_owner TEXT NOT NULL,
      lease_pid INTEGER NOT NULL CHECK (lease_pid > 0),
      lease_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_upload_leases_user
      ON managed_attachment_upload_leases(user_id, lease_expires_at, updated_at);
  `)
}
