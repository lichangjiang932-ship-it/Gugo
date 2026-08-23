import { buildRuntimePluginReleaseContentIdentity } from '../plugins/runtimePluginReleaseIdentity.js'
import { hasColumn } from './index.js'

function releaseRecord(row) {
  return {
    releaseId: row.release_id,
    pluginId: row.plugin_id,
    sourceDigest: row.source_digest,
    source: row.source_text,
    pluginSnapshotJson: row.plugin_snapshot_json,
    validationStatus: row.validation_status,
    healthStatus: row.health_status,
    failure: row.failure || null,
    createdAt: Number(row.created_at),
  }
}

function installImmutableUpdateTrigger(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable
      BEFORE UPDATE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
  `)
}

/**
 * Bind every executable Release field to one versioned content digest.
 *
 * Valid v74/v75 rows are normalized and backfilled. Rows that cannot prove a
 * self-consistent source/manifest/status identity remain digest_version=0 and
 * are intentionally rejected by runtime loading and activation.
 */
export function migrateToV76(db) {
  db.transaction(() => {
    if (!hasColumn(db, 'runtime_plugin_releases', 'release_content_digest')) {
      db.exec('ALTER TABLE runtime_plugin_releases ADD COLUMN release_content_digest TEXT')
    }
    if (!hasColumn(db, 'runtime_plugin_releases', 'digest_version')) {
      db.exec(`ALTER TABLE runtime_plugin_releases
        ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 0
        CHECK (digest_version >= 0)`)
    }

    db.exec('DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable')
    const rows = db.prepare(`
      SELECT
        release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
        validation_status, health_status, failure, created_at
      FROM runtime_plugin_releases
      WHERE digest_version = 0 OR release_content_digest IS NULL
      ORDER BY created_at ASC, release_id ASC
    `).all()
    const backfill = db.prepare(`
      UPDATE runtime_plugin_releases
      SET release_content_digest = ?, digest_version = ?
      WHERE release_id = ? AND digest_version = 0
    `)
    for (const row of rows) {
      try {
        const identity = buildRuntimePluginReleaseContentIdentity(releaseRecord(row))
        backfill.run(identity.releaseContentDigest, identity.digestVersion, row.release_id)
      } catch (error) {
        if (error?.code !== 'PLUGIN_RELEASE_CORRUPT') throw error
      }
    }
    installImmutableUpdateTrigger(db)
  })()
}
