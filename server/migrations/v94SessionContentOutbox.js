/**
 * Durable hand-off from SQLite message commits to per-session JSONL files.
 *
 * session_id intentionally has no foreign key: a session.delete event must
 * remain materializable after the owning sessions row has been removed.
 */
export function migrateToV94(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_content_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 512),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'message.upsert',
        'message.delete',
        'session.replace',
        'session.delete'
      )),
      payload_json TEXT NOT NULL,
      event_fingerprint TEXT NOT NULL CHECK (length(event_fingerprint) = 64),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'leased', 'materialized')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at INTEGER NOT NULL CHECK (available_at >= 0),
      lease_owner TEXT,
      lease_expires_at INTEGER,
      materialized_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
      ),
      CHECK (
        (status = 'materialized' AND materialized_at IS NOT NULL)
        OR (status <> 'materialized' AND materialized_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_session_content_outbox_claim
      ON session_content_outbox(status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_session_content_outbox_user_claim
      ON session_content_outbox(user_id, status, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_session_content_outbox_session
      ON session_content_outbox(user_id, session_id, id);
  `)
}
