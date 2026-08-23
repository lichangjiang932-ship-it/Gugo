/**
 * Persist local-owner approval for an exact runtime plugin source and
 * normalized permission set. Grants are deliberately separate from desired
 * enablement: disabling or a changed Release cannot silently broaden consent.
 */
export function migrateToV100(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_permission_grants (
      plugin_id TEXT PRIMARY KEY
        REFERENCES runtime_plugin_states(plugin_id) ON DELETE CASCADE,
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
      permissions_json TEXT NOT NULL,
      granted_at INTEGER NOT NULL CHECK (granted_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= granted_at)
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_permission_grants_updated
      ON runtime_plugin_permission_grants(updated_at DESC, plugin_id ASC);
  `)
}
