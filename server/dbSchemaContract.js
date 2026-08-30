const REQUIRED_TABLE_COLUMNS = Object.freeze({
  meta: ['key', 'value'],
  users: ['id', 'email', 'created_at', 'updated_at', 'password_hash', 'password_salt', 'password_set_at'],
  sessions: ['token', 'user_id', 'expires_at', 'created_at', 'revision', 'pinned_at', 'parent_session_id'],
  jobs: ['id', 'user_id', 'status', 'created_at', 'updated_at', 'model_provider_id', 'model_config_revision'],
  job_steps: ['id', 'job_id', 'status', 'sort_order'],
  job_events: ['id', 'job_id', 'type', 'created_at'],
  job_artifacts: ['id', 'job_id', 'user_id', 'type', 'url', 'created_at'],
  skills: ['id', 'user_id', 'name', 'version'],
  skill_assets: ['skill_id', 'path', 'content'],
  agents: ['id', 'user_id', 'name'],
  memories: ['id', 'user_id', 'agent_id', 'pinned', 'last_used_at'],
  model_providers: [
    'id',
    'user_id',
    'kind',
    'context_window',
    'supports_tools',
    'supports_streaming',
    'supports_vision',
    'first_token_timeout_ms',
    'idle_timeout_ms',
    'failover_enabled',
    'keep_alive',
    'supports_pdf',
    'model_profiles_json',
    'config_revision',
    'readiness_json',
  ],
  turn_events: ['id', 'user_id', 'session_id', 'turn_id', 'sequence', 'type', 'payload_json', 'created_at'],
  turn_artifacts: ['id', 'user_id', 'session_id', 'turn_id', 'type', 'title', 'url', 'filename', 'created_at'],
  session_meters: ['session_id', 'user_id', 'tokens_in', 'tokens_out', 'tokens_cached', 'turns', 'updated_at'],
  subagent_runs: ['id', 'user_id', 'status', 'model_provider_id', 'model_config_revision'],
  side_effect_executions: ['owner_id', 'scope_key', 'tool_call_id', 'status', 'prepared_at', 'finished_at'],
  runtime_plugin_states: ['plugin_id', 'active_release_id', 'release_revision'],
  runtime_plugin_mutation_barrier_generations: ['plugin_id', 'last_generation', 'generation_claimed'],
  runtime_plugin_mutation_barriers: [
    'plugin_id',
    'token',
    'generation',
    'phase',
    'store_revision',
    'recovery_required',
  ],
  runtime_plugin_mutation_recovery_receipts: [
    'receipt_id',
    'plugin_id',
    'generation',
    'operation',
    'token_fingerprint',
    'barrier_store_revision',
    'observed_store_revision',
    'evidence_json',
    'verified_at',
  ],
  evolution_auto_configs: [
    'user_id',
    'enabled',
    'target',
    'objective',
    'generator_provider_id',
    'generator_model',
    'replay_provider_id',
    'replay_model',
    'evaluator_provider_id',
    'evaluator_model',
    'session_ids_json',
    'minimum_signal_count',
    'maximum_source_records',
    'cooldown_ms',
    'traffic_percent',
    'canary_max_outcomes',
    'canary_max_age_ms',
    'rollback_policy_json',
    'config_revision',
    'created_at',
    'updated_at',
  ],
  evolution_auto_runs: [
    'id',
    'user_id',
    'config_revision',
    'evidence_fingerprint',
    'dataset_fingerprint',
    'source_record_ids_json',
    'source_evidence_ids_json',
    'session_ids_json',
    'signal_count',
    'signal_cutoff_at',
    'state',
    'stage',
    'candidate_id',
    'replay_suite_id',
    'replay_id',
    'evaluation_id',
    'approval_id',
    'canary_id',
    'promotion_id',
    'verdict',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'finished_at',
  ],
  evolution_approval_decisions: ['id', 'decision_origin', 'automation_run_id'],
  evolution_promotions: ['id', 'decision_origin', 'automation_run_id'],
})

const REQUIRED_INDEXES = Object.freeze({
  idx_sessions_user: { table: 'sessions', columns: ['user_id'] },
  idx_sessions_expires: { table: 'sessions', columns: ['expires_at'] },
  idx_jobs_status_created: { table: 'jobs', columns: ['status', 'created_at'] },
  idx_jobs_user_created: { table: 'jobs', columns: ['user_id', 'created_at'] },
  idx_jobs_user_status: { table: 'jobs', columns: ['user_id', 'status'] },
  idx_memories_user_agent: { table: 'memories', columns: ['user_id', 'agent_id', 'pinned', 'last_used_at'] },
  idx_model_providers_user: { table: 'model_providers', columns: ['user_id', 'enabled', 'provider_key'] },
  idx_turn_events_replay: { table: 'turn_events', columns: ['user_id', 'session_id', 'turn_id', 'sequence'] },
  idx_turn_artifacts_turn: { table: 'turn_artifacts', columns: ['user_id', 'session_id', 'turn_id', 'created_at'] },
  idx_turn_artifacts_filename: { table: 'turn_artifacts', columns: ['filename'], unique: true },
  idx_runtime_plugin_mutation_barriers_heartbeat: {
    table: 'runtime_plugin_mutation_barriers',
    columns: ['heartbeat_at', 'plugin_id'],
  },
  idx_runtime_plugin_mutation_recovery_receipts_plugin_time: {
    table: 'runtime_plugin_mutation_recovery_receipts',
    columns: ['plugin_id', 'verified_at'],
  },
  idx_evolution_auto_runs_user_created: {
    table: 'evolution_auto_runs',
    columns: ['user_id', 'created_at', 'id'],
  },
  idx_evolution_auto_runs_state_updated: {
    table: 'evolution_auto_runs',
    columns: ['state', 'updated_at', 'id'],
  },
  idx_evolution_approval_automation_run: {
    table: 'evolution_approval_decisions',
    columns: ['automation_run_id'],
    unique: true,
    partial: true,
  },
  idx_evolution_promotion_automation_run: {
    table: 'evolution_promotions',
    columns: ['automation_run_id'],
    unique: true,
    partial: true,
  },
})

const REQUIRED_FOREIGN_KEYS = Object.freeze([
  { table: 'sessions', from: 'user_id', target: 'users', to: 'id', onDelete: 'CASCADE' },
  { table: 'jobs', from: 'user_id', target: 'users', to: 'id', onDelete: 'CASCADE' },
  { table: 'memories', from: 'agent_id', target: 'agents', to: 'id', onDelete: 'SET NULL' },
  { table: 'turn_events', from: 'user_id', target: 'users', to: 'id', onDelete: 'CASCADE' },
  { table: 'turn_events', from: 'session_id', target: 'sessions', to: 'token', onDelete: 'CASCADE' },
  { table: 'turn_artifacts', from: 'user_id', target: 'users', to: 'id', onDelete: 'CASCADE' },
  { table: 'turn_artifacts', from: 'session_id', target: 'sessions', to: 'token', onDelete: 'CASCADE' },
  {
    table: 'runtime_plugin_mutation_barriers',
    from: 'plugin_id',
    target: 'runtime_plugin_mutation_barrier_generations',
    to: 'plugin_id',
    onDelete: 'RESTRICT',
  },
])

const FORBIDDEN_TABLE_COLUMNS = Object.freeze({
  users: ['credits'],
  session_meters: ['cost_credits'],
  subagent_runs: ['credits'],
})

const BARRIER_IDENTITY_TABLES = Object.freeze([
  'runtime_plugin_states',
  'runtime_plugin_releases',
  'runtime_plugin_release_pins',
  'runtime_plugin_permission_grants',
])

const BARRIER_JSON_REFERENCES = Object.freeze([
  ['turn_checkpoints', 'state_json'],
  ['job_turn_checkpoints', 'state_json'],
  ['turn_events', 'payload_json'],
  ['event_write_failures', 'checkpoint_state_json'],
  ['event_write_failures', 'payload_json'],
])

function requiredTriggerOwners() {
  const owners = new Map([
    ['trg_runtime_plugin_states_release_identity_insert', 'runtime_plugin_states'],
    ['trg_runtime_plugin_states_release_identity_update', 'runtime_plugin_states'],
    ['trg_runtime_plugin_mutation_barrier_generation_insert', 'runtime_plugin_mutation_barrier_generations'],
    ['trg_runtime_plugin_mutation_barrier_generation_update', 'runtime_plugin_mutation_barrier_generations'],
    ['trg_runtime_plugin_mutation_barrier_generation_delete', 'runtime_plugin_mutation_barrier_generations'],
    ['trg_runtime_plugin_mutation_barrier_generation_match_insert', 'runtime_plugin_mutation_barriers'],
    ['trg_runtime_plugin_mutation_barrier_generation_claim_insert', 'runtime_plugin_mutation_barriers'],
    ['trg_runtime_plugin_mutation_barrier_generation_identity_update', 'runtime_plugin_mutation_barriers'],
    ['trg_runtime_plugin_mutation_barrier_phase_update', 'runtime_plugin_mutation_barriers'],
    ['trg_runtime_plugin_mutation_recovery_receipts_update', 'runtime_plugin_mutation_recovery_receipts'],
    ['trg_runtime_plugin_mutation_recovery_receipts_delete', 'runtime_plugin_mutation_recovery_receipts'],
  ])
  for (const table of BARRIER_IDENTITY_TABLES) {
    owners.set(`trg_${table}_plugin_mutation_barrier_insert`, table)
    owners.set(`trg_${table}_plugin_mutation_barrier_update`, table)
  }
  for (const [table, column] of BARRIER_JSON_REFERENCES) {
    const base = `trg_${table}_${column}_plugin_mutation_barrier`
    owners.set(`${base}_insert_invalid_json`, table)
    owners.set(`${base}_insert`, table)
    owners.set(`${base}_update_invalid_json`, table)
    owners.set(`${base}_update`, table)
  }
  return owners
}

function hasHistoricalLedgerSchema(db) {
  const table = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'
  `).get()
  if (!table) return false
  const columns = db.prepare(`
    SELECT name, upper(type) AS type, "notnull" AS isNotNull, pk
    FROM pragma_table_info(?) ORDER BY cid
  `).all('ledger')
  const expected = [
    ['id', 'TEXT', 0, 1],
    ['user_id', 'TEXT', 1, 0],
    ['type', 'TEXT', 1, 0],
    ['package_id', 'TEXT', 0, 0],
    ['model_name', 'TEXT', 0, 0],
    ['credits', 'INTEGER', 1, 0],
    ['balance', 'INTEGER', 1, 0],
    ['created_at', 'INTEGER', 1, 0],
  ]
  if (columns.length !== expected.length || columns.some((column, index) => {
    const [name, type, notnull, pk] = expected[index]
    return column.name !== name
      || column.type !== type
      || Number(column.isNotNull) !== notnull
      || Number(column.pk) !== pk
  })) return false
  const foreignKeys = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('ledger')
  return foreignKeys.length === 1
    && foreignKeys[0].table === 'users'
    && foreignKeys[0].from === 'user_id'
    && foreignKeys[0].to === 'id'
    && foreignKeys[0].on_delete === 'CASCADE'
}

export function databaseSchemaIncompleteError({ expectedVersion, stage, missing }) {
  return Object.assign(
    new Error(
      `Database schema is incomplete for version ${expectedVersion}: ${missing.join(', ')}.`,
    ),
    {
      code: 'DB_SCHEMA_INCOMPLETE',
      retryable: false,
      details: {
        expectedVersion,
        stage,
        missing: [...missing],
      },
    },
  )
}

/**
 * Verify a small, stable set of schema sentinels spanning the historical and
 * current migration epochs. This is intentionally read-only: a database that
 * claims the current version must prove it before startup enables WAL or any
 * compatibility repair can write to it.
 */
export function assertCurrentSchemaContract(db, expectedVersion, { stage = 'postflight' } = {}) {
  const missing = []
  const versionRow = db.prepare(`
    SELECT value FROM meta WHERE key = 'schema_version'
  `).get()
  if (String(versionRow?.value) !== String(expectedVersion)) {
    missing.push(`meta.schema_version=${expectedVersion}`)
  }

  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const tableRow = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table)
    if (!tableRow) {
      missing.push(`table:${table}`)
      continue
    }
    const columns = new Set(
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name),
    )
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`column:${table}.${column}`)
    }
  }

  for (const [table, forbiddenColumns] of Object.entries(FORBIDDEN_TABLE_COLUMNS)) {
    const columns = new Set(
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name),
    )
    for (const column of forbiddenColumns) {
      if (columns.has(column)) missing.push(`retired-column:${table}.${column}`)
    }
  }
  if (hasHistoricalLedgerSchema(db)) missing.push('retired-table:ledger')

  for (const [index, spec] of Object.entries(REQUIRED_INDEXES)) {
    const indexRow = db.prepare(`
      SELECT tbl_name AS tableName FROM sqlite_master
      WHERE type = 'index' AND name = ?
    `).get(index)
    const indexMetadata = db.prepare(`
      SELECT name, "unique" AS isUnique, partial
      FROM pragma_index_list(?) WHERE name = ?
    `).get(spec.table, index)
    if (!indexRow || !indexMetadata || indexRow.tableName !== spec.table) {
      missing.push(`index:${index}`)
      continue
    }
    const columns = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index)
      .map((row) => row.name)
    if (columns.length !== spec.columns.length
      || columns.some((column, position) => column !== spec.columns[position])) {
      missing.push(`index-columns:${index}`)
    }
    if (Number(indexMetadata.isUnique) !== Number(Boolean(spec.unique))) {
      missing.push(`index-unique:${index}`)
    }
    if (Number(indexMetadata.partial) !== Number(Boolean(spec.partial))) {
      missing.push(`index-partial:${index}`)
    }
  }

  for (const foreignKey of REQUIRED_FOREIGN_KEYS) {
    const matches = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(foreignKey.table)
      .some((row) => row.from === foreignKey.from
        && row.table === foreignKey.target
        && row.to === foreignKey.to
        && row.on_delete === foreignKey.onDelete)
    if (!matches) {
      missing.push(`foreign-key:${foreignKey.table}.${foreignKey.from}`)
    }
  }

  for (const [trigger, table] of requiredTriggerOwners()) {
    const row = db.prepare(`
      SELECT tbl_name AS tableName, sql FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `).get(trigger)
    if (!row || row.tableName !== table || !String(row.sql || '').trim()) {
      missing.push(`trigger:${trigger}`)
    }
  }

  if (missing.length > 0) {
    throw databaseSchemaIncompleteError({ expectedVersion, stage, missing })
  }
}
