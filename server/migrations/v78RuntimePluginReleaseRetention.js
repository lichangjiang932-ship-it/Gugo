/**
 * Add fail-closed retention metadata for immutable runtime plugin Releases.
 *
 * Release rows remain immutable to ordinary SQL. A delete is accepted only
 * while the GC service holds a transaction-local guard for that exact row,
 * and database-visible authoritative/pinned references are checked again by
 * the trigger immediately before the delete.
 */
export function migrateToV78(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_plugin_release_pins (
        plugin_id TEXT NOT NULL,
        release_id TEXT NOT NULL
          REFERENCES runtime_plugin_releases(release_id) ON DELETE RESTRICT,
        reference_kind TEXT NOT NULL CHECK (reference_kind IN (
          'rollback', 'canary', 'turn', 'job', 'checkpoint', 'manual'
        )),
        reference_id TEXT NOT NULL CHECK (
          length(reference_id) BETWEEN 1 AND 512
        ),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, release_id, reference_kind, reference_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_plugin_release_pins_release
        ON runtime_plugin_release_pins(release_id, reference_kind);

      CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_release_pins_identity
        BEFORE INSERT ON runtime_plugin_release_pins
        WHEN NOT EXISTS (
          SELECT 1 FROM runtime_plugin_releases AS release
          WHERE release.release_id = NEW.release_id
            AND release.plugin_id = NEW.plugin_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'runtime plugin release pin identity mismatch');
        END;

      CREATE TABLE IF NOT EXISTS runtime_plugin_release_gc_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'skipped', 'failed'
        )),
        policy_json TEXT NOT NULL,
        result_json TEXT,
        failure TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_plugin_release_gc_runs_started
        ON runtime_plugin_release_gc_runs(started_at DESC, run_id DESC);

      CREATE TABLE IF NOT EXISTS runtime_plugin_release_gc_delete_guards (
        release_id TEXT PRIMARY KEY
          REFERENCES runtime_plugin_releases(release_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL
          REFERENCES runtime_plugin_release_gc_runs(run_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable_delete;
      CREATE TRIGGER trg_runtime_plugin_releases_immutable_delete
        BEFORE DELETE ON runtime_plugin_releases
        BEGIN
          SELECT RAISE(ABORT, 'runtime plugin releases are immutable')
          WHERE NOT EXISTS (
            SELECT 1 FROM runtime_plugin_release_gc_delete_guards AS guard
            JOIN runtime_plugin_release_gc_runs AS run
              ON run.run_id = guard.run_id
            WHERE guard.release_id = OLD.release_id
              AND run.status = 'running'
          );
          SELECT RAISE(ABORT, 'runtime plugin release is authoritative')
          WHERE EXISTS (
            SELECT 1 FROM runtime_plugin_states AS state
            WHERE state.active_release_id = OLD.release_id
               OR state.previous_release_id = OLD.release_id
               OR state.last_rollback_from_release_id = OLD.release_id
               OR state.last_rollback_to_release_id = OLD.release_id
          );
          SELECT RAISE(ABORT, 'runtime plugin release is pinned')
          WHERE EXISTS (
            SELECT 1 FROM runtime_plugin_release_pins AS pin
            WHERE pin.release_id = OLD.release_id
          );
        END;
    `)
  })()
}
