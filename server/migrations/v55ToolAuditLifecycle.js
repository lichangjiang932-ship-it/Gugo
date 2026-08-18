function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

/** Add structured, queryable tool-call lifecycle evidence without exposing secrets. */
export function migrateToV55(db) {
  if (!hasTable(db, 'tool_audit')) return
  if (!hasColumn(db, 'tool_audit', 'call_id')) {
    db.exec('ALTER TABLE tool_audit ADD COLUMN call_id TEXT')
  }
  if (!hasColumn(db, 'tool_audit', 'stage')) {
    db.exec(`
      ALTER TABLE tool_audit ADD COLUMN stage TEXT
        CHECK (stage IS NULL OR stage IN (
          'proposed','started','approval_requested','auto_allowed',
          'approved','denied','finished','filtered'
        ))
    `)
  }
  if (!hasColumn(db, 'tool_audit', 'args_json')) {
    db.exec('ALTER TABLE tool_audit ADD COLUMN args_json TEXT')
  }
  if (!hasColumn(db, 'tool_audit', 'result_preview')) {
    db.exec('ALTER TABLE tool_audit ADD COLUMN result_preview TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_audit_user_tool_stage_time
      ON tool_audit(user_id, tool_name, stage, created_at DESC, id DESC)
  `)
}
