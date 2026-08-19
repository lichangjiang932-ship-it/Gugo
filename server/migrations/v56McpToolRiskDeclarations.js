function hasTable(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

/** Persist per-tool MCP risk declarations without weakening legacy defaults. */
export function migrateToV56(db) {
  if (!hasTable(db, 'mcp_servers')) return
  if (!hasColumn(db, 'mcp_servers', 'tools_json')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN tools_json TEXT NOT NULL DEFAULT '{}'")
  }
}
