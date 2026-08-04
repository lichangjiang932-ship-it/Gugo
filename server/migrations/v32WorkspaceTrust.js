export function migrateToV32(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_trust (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, root_path)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_trust_user
      ON workspace_trust(user_id, updated_at);
  `)
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '32')
}
