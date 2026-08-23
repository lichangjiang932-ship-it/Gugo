import { hasColumn } from './index.js'

/** Add cross-process CAS state and complete immutable Release protection. */
export function migrateToV75(db) {
  if (!hasColumn(db, 'runtime_plugin_states', 'release_revision')) {
    db.exec(`ALTER TABLE runtime_plugin_states
      ADD COLUMN release_revision INTEGER NOT NULL DEFAULT 0 CHECK (release_revision >= 0)`)
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable_delete
      BEFORE DELETE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
  `)
}
