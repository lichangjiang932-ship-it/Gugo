export function migrateToV31(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_oauth_credentials (
      server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      credential_json TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_user
      ON mcp_oauth_credentials(user_id, updated_at);
  `)
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '31')
}
