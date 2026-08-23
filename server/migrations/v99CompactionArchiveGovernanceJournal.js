function hasTable(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Extend the durable user-data clear journal with the adapter identity and
 * staged-deletion receipt needed to recover compaction archive governance.
 * Existing v77 rows remain user-scoped clears with no adapter receipt.
 */
export function migrateToV99(db) {
  const table = 'user_data_clear_operations'
  if (!hasTable(db, table)) return

  if (!hasColumn(db, table, 'operation_kind')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'user_clear'
        CHECK (operation_kind IN ('user_clear', 'session_delete'))
    `)
  }
  if (!hasColumn(db, table, 'session_id')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN session_id TEXT
        CHECK (
          (operation_kind = 'user_clear' AND session_id IS NULL)
          OR (
            operation_kind = 'session_delete'
            AND typeof(session_id) = 'text'
            AND length(session_id) > 0
            AND session_id = trim(session_id)
          )
        )
    `)
  }
  if (!hasColumn(db, table, 'compaction_port_id')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN compaction_port_id TEXT
        CHECK (
          compaction_port_id IS NULL
          OR (
            typeof(compaction_port_id) = 'text'
            AND length(compaction_port_id) > 0
            AND compaction_port_id = trim(compaction_port_id)
          )
        )
    `)
  }
  if (!hasColumn(db, table, 'compaction_governance_version')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN compaction_governance_version INTEGER
        CHECK (
          compaction_governance_version IS NULL
          OR (
            typeof(compaction_governance_version) = 'integer'
            AND compaction_governance_version > 0
          )
        )
    `)
  }
  if (!hasColumn(db, table, 'compaction_digest')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN compaction_digest TEXT
        CHECK (
          compaction_digest IS NULL
          OR (
            typeof(compaction_digest) = 'text'
            AND length(compaction_digest) = 64
            AND compaction_digest NOT GLOB '*[^0-9a-f]*'
          )
        )
    `)
  }
  if (!hasColumn(db, table, 'compaction_stage_token')) {
    db.exec(`
      ALTER TABLE user_data_clear_operations
      ADD COLUMN compaction_stage_token TEXT
        CHECK (
          compaction_stage_token IS NULL
          OR (
            typeof(compaction_stage_token) = 'text'
            AND length(compaction_stage_token) > 0
            AND compaction_stage_token = trim(compaction_stage_token)
          )
        )
    `)
  }
}
