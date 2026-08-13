/**
 * Drop the hardcoded hooks.event CHECK constraint. Event validation already
 * lives in hooksService (ALLOWED_EVENTS), and the extended lifecycle/
 * notification events cannot be added without rebuilding the table because
 * SQLite cannot alter a CHECK constraint in place.
 */
export function migrateToV48(db) {
  const hasCheck = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hooks'
  `).get()?.sql || ''
  if (!/CHECK\s*\(\s*event\s+IN\s*\(/iu.test(hasCheck)) return

  db.exec(`
    CREATE TABLE hooks_v48 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_pattern TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('shell','http')),
      command TEXT,
      url TEXT,
      headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      blocking INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO hooks_v48
      (id, user_id, event, tool_pattern, kind, command, url, headers_json, enabled, blocking, timeout_ms, created_at, updated_at)
      SELECT id, user_id, event, tool_pattern, kind, command, url, headers_json, enabled, blocking, timeout_ms, created_at, updated_at
      FROM hooks;
    DROP TABLE hooks;
    ALTER TABLE hooks_v48 RENAME TO hooks;
    CREATE INDEX IF NOT EXISTS idx_hooks_user_event ON hooks(user_id, event, enabled);
  `)
}
