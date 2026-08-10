export function migrateToV42(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_attachments_user_created
      ON managed_attachments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_managed_attachments_session
      ON managed_attachments(user_id, session_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_managed_attachments_message
      ON managed_attachments(user_id, message_id, created_at ASC);
  `)
}
