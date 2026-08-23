function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

function createTableSql(tableName = 'side_effect_executions') {
  return `
    CREATE TABLE ${tableName} (
      owner_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('turn', 'job', 'request')),
      scope_key TEXT NOT NULL,
      session_id TEXT,
      turn_id TEXT,
      job_id TEXT,
      step_id TEXT,
      request_id TEXT,
      effect_kind TEXT NOT NULL DEFAULT 'tool' CHECK (effect_kind IN ('tool', 'hook')),
      tool_call_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_digest TEXT NOT NULL,
      intent_json TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('prepared', 'executing', 'committed', 'failed', 'unknown')),
      outcome_json TEXT,
      audit_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      prepared_at INTEGER NOT NULL,
      executing_at INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (owner_id, scope_key, tool_call_id),
      UNIQUE (owner_id, scope_key, idempotency_key)
    )
  `
}

function ensureIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_side_effect_executions_status
      ON side_effect_executions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_side_effect_executions_scope
      ON side_effect_executions(owner_id, scope_kind, session_id, turn_id, job_id, step_id);
    CREATE INDEX IF NOT EXISTS idx_side_effect_executions_request
      ON side_effect_executions(owner_id, effect_kind, request_id, updated_at);
  `)
}

/**
 * Extend the durable side-effect ledger to host Hook shell/HTTP executions.
 * SQLite cannot widen the existing scope_kind CHECK in place, so preserve the
 * physical tool_call_id identity while rebuilding the table transactionally.
 */
export function migrateToV92(db) {
  if (!tableExists(db, 'side_effect_executions')) {
    db.exec(createTableSql())
    ensureIndexes(db)
    return
  }

  const columns = tableColumns(db, 'side_effect_executions')
  const tableSql = String(db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'side_effect_executions'",
  ).get()?.sql || '')
  const alreadyUpgraded = columns.has('request_id')
    && columns.has('effect_kind')
    && /['"]request['"]/u.test(tableSql)
  if (alreadyUpgraded) {
    ensureIndexes(db)
    return
  }

  const requestId = columns.has('request_id') ? 'request_id' : 'NULL'
  const effectKind = columns.has('effect_kind') ? "COALESCE(effect_kind, 'tool')" : "'tool'"
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS side_effect_executions_v92')
    db.exec(createTableSql('side_effect_executions_v92'))
    db.exec(`
      INSERT INTO side_effect_executions_v92 (
        owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
        request_id, effect_kind, tool_call_id, idempotency_key, tool_name,
        args_digest, intent_json, status, outcome_json, audit_json, created_at,
        updated_at, prepared_at, executing_at, finished_at
      )
      SELECT
        owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
        ${requestId}, ${effectKind}, tool_call_id, idempotency_key, tool_name,
        args_digest, intent_json, status, outcome_json, audit_json, created_at,
        updated_at, prepared_at, executing_at, finished_at
      FROM side_effect_executions
    `)
    db.exec('DROP TABLE side_effect_executions')
    db.exec('ALTER TABLE side_effect_executions_v92 RENAME TO side_effect_executions')
    ensureIndexes(db)
  })()
}
