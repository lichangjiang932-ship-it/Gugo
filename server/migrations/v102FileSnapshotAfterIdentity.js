import { migrateToV46 } from './v46FileSnapshots.js'

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((entry) => entry.name === column)
}

/**
 * Bind each before-image snapshot to the authoritative state produced by the
 * mutating tool. Legacy rows remain unbound (NULL) and therefore fail closed
 * when a restore is attempted.
 */
export function migrateToV102(db) {
  const hasSnapshots = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_snapshots'
  `).get()
  if (!hasSnapshots) migrateToV46(db)

  if (!hasColumn(db, 'file_snapshots', 'after_exists')) {
    db.exec(`
      ALTER TABLE file_snapshots ADD COLUMN after_exists INTEGER
        CHECK (after_exists IS NULL OR after_exists IN (0, 1));
    `)
  }
  if (!hasColumn(db, 'file_snapshots', 'after_sha256')) {
    db.exec(`
      ALTER TABLE file_snapshots ADD COLUMN after_sha256 TEXT
        CHECK (
          after_sha256 IS NULL
          OR (
            length(after_sha256) = 64
            AND after_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        );
    `)
  }
  if (!hasColumn(db, 'file_snapshots', 'after_bytes')) {
    db.exec(`
      ALTER TABLE file_snapshots ADD COLUMN after_bytes INTEGER
        CHECK (after_bytes IS NULL OR after_bytes >= 0);
    `)
  }
  if (!hasColumn(db, 'file_snapshots', 'finalized_at')) {
    db.exec(`
      ALTER TABLE file_snapshots ADD COLUMN finalized_at INTEGER
        CHECK (finalized_at IS NULL OR finalized_at >= 0);
    `)
  }
}
