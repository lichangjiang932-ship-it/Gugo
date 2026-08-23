/**
 * Bind each runtime-plugin grant to the fixed local installation owner.
 *
 * V100 grants had no owner identity, so assigning them during upgrade would
 * guess who approved them. Drop those ambiguous rows and require one explicit
 * re-approval instead. This keeps the upgrade fail-closed.
 */
export function migrateToV101(db) {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'runtime_plugin_permission_grants'
  `).get()
  const hasOwner = table && db.prepare(
    'PRAGMA table_info(runtime_plugin_permission_grants)',
  ).all().some((column) => column.name === 'owner_id')

  if (table && !hasOwner) {
    db.exec(`
      ALTER TABLE runtime_plugin_permission_grants
        RENAME TO runtime_plugin_permission_grants_v100;
      DROP TABLE runtime_plugin_permission_grants_v100;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_permission_grants (
      plugin_id TEXT PRIMARY KEY
        REFERENCES runtime_plugin_states(plugin_id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
      approval_digest TEXT NOT NULL
        CHECK (
          length(approval_digest) = 71
          AND approval_digest LIKE 'sha256-%'
          AND substr(approval_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      source_digest TEXT NOT NULL
        CHECK (
          length(source_digest) = 71
          AND source_digest LIKE 'sha256-%'
          AND substr(source_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      permissions_json TEXT NOT NULL
        CHECK (
          json_valid(permissions_json)
          AND json_type(permissions_json) = 'array'
          AND json_array_length(permissions_json) BETWEEN 1 AND 64
        ),
      granted_at INTEGER NOT NULL CHECK (granted_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= granted_at)
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_permission_grants_updated
      ON runtime_plugin_permission_grants(updated_at DESC, plugin_id ASC);
    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_permission_grants_owner
      ON runtime_plugin_permission_grants(owner_id, updated_at DESC, plugin_id ASC);

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_permissions_json_insert
      BEFORE INSERT ON runtime_plugin_permission_grants
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.permissions_json)
        WHERE type <> 'text'
          OR length(value) NOT BETWEEN 1 AND 128
          OR substr(value, 1, 1) NOT GLOB '[a-z0-9]'
          OR value GLOB '*[^a-z0-9._:-]*'
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid runtime plugin permission identifier');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_permissions_json_update
      BEFORE UPDATE OF permissions_json ON runtime_plugin_permission_grants
      WHEN EXISTS (
        SELECT 1 FROM json_each(NEW.permissions_json)
        WHERE type <> 'text'
          OR length(value) NOT BETWEEN 1 AND 128
          OR substr(value, 1, 1) NOT GLOB '[a-z0-9]'
          OR value GLOB '*[^a-z0-9._:-]*'
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid runtime plugin permission identifier');
      END;
  `)
}
