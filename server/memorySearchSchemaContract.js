const COLUMNS = {
  memory_search_index: ['memory_id', 'user_id', 'agent_id', 'type', 'source_auto', 'memory_order', 'search_title',
    'search_slug', 'search_body', 'search_tags_json', 'exact_title_key', 'dedup_title_key', 'dedup_body_key', 'source_fingerprint'],
  memory_search_pending: ['memory_id', 'user_id', 'agent_id', 'memory_order'],
}
const INDEXES = {
  idx_memory_search_owner_order: ['memory_search_index', 'user_id', 'memory_order'],
  idx_memory_search_title: ['memory_search_index', 'user_id', 'agent_id', 'search_title'],
  idx_memory_search_slug: ['memory_search_index', 'user_id', 'agent_id', 'search_slug'],
  idx_memory_search_exact_title: ['memory_search_index', 'user_id', 'agent_id', 'type', 'exact_title_key'],
  idx_memory_search_auto_title: ['memory_search_index', 'user_id', 'agent_id', 'source_auto', 'dedup_title_key'],
  idx_memory_search_auto_body: ['memory_search_index', 'user_id', 'agent_id', 'source_auto', 'type', 'dedup_body_key'],
  idx_memory_search_pending_scope: ['memory_search_pending', 'user_id', 'agent_id', 'memory_order'],
}

/** Derived data is still a protocol: missing invalidation must not serve stale memories. */
export function collectMemorySearchSchemaProblems(db) {
  const missing = []
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const actual = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name))
    for (const column of columns) if (!actual.has(column)) missing.push(`${table}.${column}`)
    const references = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table)
    for (const [column, target] of [['memory_id', 'memories'], ['user_id', 'users']]) {
      if (!references.some((row) => row.from === column && row.table === target && row.to === 'id' && row.on_delete === 'CASCADE')) {
        missing.push(`${table}.${column}:CASCADE`)
      }
    }
  }
  for (const [name, [table, ...columns]] of Object.entries(INDEXES)) {
    const owner = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(name)?.tbl_name
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(name).map((row) => row.name)
    if (owner !== table || JSON.stringify(actual) !== JSON.stringify(columns)) missing.push(name)
  }
  for (const name of ['memory_search_insert_pending', 'memory_search_update_pending']) {
    const trigger = db.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)
    if (trigger?.tbl_name !== 'memories' || !/INSERT INTO memory_search_pending/iu.test(trigger.sql || '')) missing.push(name)
    if (name === 'memory_search_update_pending' && !/DELETE FROM memory_search_index/iu.test(trigger?.sql || '')) {
      missing.push(`${name}:invalidation`)
    }
  }
  return missing
}
