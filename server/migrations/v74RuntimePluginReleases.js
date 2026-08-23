import { hasColumn } from './index.js'

/**
 * Persist immutable transformer release snapshots separately from the mutable
 * desired/runtime state. A release row is append-only at the service layer;
 * runtime_plugin_states only points at the authoritative and previous release.
 */
export function migrateToV74(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_releases (
      release_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      source_text TEXT NOT NULL,
      plugin_snapshot_json TEXT NOT NULL,
      validation_status TEXT NOT NULL
        CHECK (validation_status IN ('passed', 'failed')),
      health_status TEXT NOT NULL
        CHECK (health_status IN ('passed', 'failed', 'not_run')),
      failure TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_releases_plugin_created
      ON runtime_plugin_releases(plugin_id, created_at DESC, release_id DESC);
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable
      BEFORE UPDATE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable_delete
      BEFORE DELETE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
  `)

  if (!hasColumn(db, 'runtime_plugin_states', 'active_release_id')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN active_release_id TEXT')
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'previous_release_id')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN previous_release_id TEXT')
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'last_rollback_status')) {
    db.exec(`ALTER TABLE runtime_plugin_states ADD COLUMN last_rollback_status TEXT
      CHECK (last_rollback_status IS NULL OR last_rollback_status IN ('succeeded', 'failed'))`)
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'last_rollback_from_release_id')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN last_rollback_from_release_id TEXT')
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'last_rollback_to_release_id')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN last_rollback_to_release_id TEXT')
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'last_rollback_reason')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN last_rollback_reason TEXT')
  }
  if (!hasColumn(db, 'runtime_plugin_states', 'last_rollback_at')) {
    db.exec('ALTER TABLE runtime_plugin_states ADD COLUMN last_rollback_at INTEGER')
  }
}
