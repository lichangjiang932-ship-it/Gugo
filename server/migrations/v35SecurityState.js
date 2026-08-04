export function migrateToV35(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_pending_authorizations (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      pending_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_expiry
      ON mcp_oauth_pending_authorizations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_pending_user
      ON mcp_oauth_pending_authorizations(user_id, server_id);

    CREATE TABLE IF NOT EXISTS webhook_replay_guard (
      integration_id TEXT NOT NULL,
      signature_digest TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (integration_id, signature_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_expiry
      ON webhook_replay_guard(expires_at);
  `)
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '35')
}
