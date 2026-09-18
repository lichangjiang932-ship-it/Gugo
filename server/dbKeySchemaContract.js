/** Primary/unique key and autoincrement contracts used by runtime UPSERTs and cursors. */
export const REQUIRED_PRIMARY_KEYS = Object.freeze({
  meta: ['key'],
  users: ['id'],
  sessions: ['token'],
  connector_idempotency: ['user_id', 'idempotency_key'],
  login_codes: ['email'],
  messages: ['id'],
  user_tool_permissions: ['user_id', 'tool_name'],
  pinned_memories: ['id'],
  todos: ['id'],
  effort_settings: ['user_id'],
  turn_events: ['id'],
  session_transcript_recovery_fences: ['user_id', 'session_id', 'turn_id'],
  agent_event_outbox: ['cursor'],
  agent_event_stream_metadata: ['stream_key'],
  agent_event_subscriptions: ['subscription_key'],
  agent_event_subscription_dlq: ['dlq_id'],
  session_meters: ['session_id'],
  memory_links: ['from_id', 'to_slug'],
  memory_embeddings: ['memory_id'],
  memory_search_index: ['memory_id'],
  memory_search_pending: ['memory_id'],
  goal_plans: ['id'],
  goal_plan_steps: ['id'],
  goal_plan_events: ['id'],
  side_effect_executions: ['owner_id', 'scope_key', 'tool_call_id'],
  channel_agents: ['channel_id', 'agent_id'],
  bridge_contacts: ['user_id', 'integration_id', 'provider', 'external_user_id'],
  local_file_access_settings: ['user_id'],
  local_file_grants: ['id'],
  user_approval_settings: ['user_id'],
  approval_tool_grants: ['user_id', 'tool_name', 'command_prefix'],
  job_turn_checkpoints: ['step_id'],
  job_wakeups: ['job_id'],
  mcp_oauth_credentials: ['server_id'],
  workspace_trust: ['user_id', 'root_path'],
  user_tool_risk_overrides: ['user_id', 'tool_name'],
  webhook_replay_guard: ['integration_id', 'signature_digest'],
  job_execution_leases: ['job_id'],
  turn_execution_leases: ['user_id', 'session_id', 'turn_id'],
  turn_checkpoints: ['user_id', 'session_id', 'turn_id'],
  runtime_plugin_states: ['plugin_id'],
  evolution_evidence_exclusions: ['user_id', 'evidence_id'],
  turn_recovery_states: ['user_id', 'session_id', 'turn_id'],
  runtime_plugin_release_pins: ['plugin_id', 'release_id', 'reference_kind', 'reference_id'],
  turn_execution_fences: ['user_id', 'session_id', 'turn_id'],
  runtime_plugin_permission_grants: ['plugin_id'],
  evolution_auto_configs: ['user_id'],
  evolution_canary_outcome_snapshots: ['outcome_id'],
  evolution_promotion_outcome_snapshots: ['outcome_id'],
})

export const REQUIRED_UNIQUE_KEYS = Object.freeze({
  users: [['email']],
  goal_plan_steps: [['plan_id', 'ordinal']],
  evolution_operations: [['user_id', 'kind', 'idempotency_key']],
  evolution_canary_assignments: [['user_id', 'session_id', 'turn_id']],
  evolution_canary_outcomes: [['assignment_id']],
  evolution_canary_online_grades: [['outcome_id']],
  evolution_canary_online_guard_evaluations: [['trigger_grade_id']],
  evolution_canary_rollbacks: [['release_id']],
  evolution_canary_rollback_evaluations: [['outcome_id']],
  evolution_promotion_assignments: [['user_id', 'session_id', 'turn_id']],
  evolution_promotion_outcomes: [['assignment_id']],
  evolution_promotion_online_grades: [['outcome_id']],
  evolution_promotion_online_guard_evaluations: [['trigger_grade_id']],
  evolution_promotion_rollbacks: [['promotion_id']],
  side_effect_executions: [['owner_id', 'scope_key', 'idempotency_key']],
  turn_events: [['user_id', 'session_id', 'turn_id', 'sequence']],
  agent_event_outbox: [['event_id']],
  agent_event_subscription_dlq: [['subscription_key', 'cursor']],
  session_content_outbox: [['event_id']],
})

/** Return exact PK/UNIQUE conflicts that would make a runtime UPSERT unsafe. */
const REQUIRED_KEY_MINIMUM_SCHEMA_VERSIONS = Object.freeze({
  session_transcript_recovery_fences: 116,
  agent_event_outbox: 113,
  agent_event_stream_metadata: 113,
  agent_event_subscriptions: 115,
  agent_event_subscription_dlq: 114,
  memory_embeddings: 117,
  memory_search_index: 120,
  memory_search_pending: 120,
  goal_plans: 118,
  goal_plan_steps: 118,
  goal_plan_events: 118,
})

export const REQUIRED_AUTOINCREMENT_PRIMARY_KEYS = Object.freeze({
  agent_event_outbox: 'cursor',
  agent_event_subscription_dlq: 'dlq_id',
})

export function keyConstraintApplies(table, expectedVersion) {
  const minimumVersion = REQUIRED_KEY_MINIMUM_SCHEMA_VERSIONS[table] || 1
  return expectedVersion === null || expectedVersion >= minimumVersion
}

export function collectMissingRequiredKeyConstraints(db, { expectedVersion = null } = {}) {
  const missing = []
  for (const [table, expectedColumns] of Object.entries(REQUIRED_PRIMARY_KEYS)) {
    if (!keyConstraintApplies(table, expectedVersion)) continue
    const actualColumns = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table)
      .filter((row) => Number(row.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((row) => row.name)
    if (actualColumns.length !== expectedColumns.length
      || actualColumns.some((column, position) => column !== expectedColumns[position])) {
      missing.push(`primary-key:${table}`)
    }
  }

  for (const [table, expectedKeys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    if (!keyConstraintApplies(table, expectedVersion)) continue
    const indexes = db.prepare(`
      SELECT name, "unique" AS is_unique, partial
      FROM pragma_index_list(?)
    `).all(table)
    for (const expectedColumns of expectedKeys) {
      const exists = indexes.some((index) => {
        if (Number(index.is_unique) !== 1 || Number(index.partial) !== 0) return false
        const actualColumns = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
          .all(index.name)
          .map((row) => row.name)
        return actualColumns.length === expectedColumns.length
          && actualColumns.every((column, position) => column === expectedColumns[position])
      })
      if (!exists) missing.push(`unique-key:${table}.${expectedColumns.join(',')}`)
    }
  }
  return missing
}

export function hasInlineAutoincrementPrimaryKey(db, table, column) {
  const source = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table)?.sql || ''
  const escapedColumn = column.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(
    `(?:\\(|,)\\s*(?:"${escapedColumn}"|${escapedColumn})\\s+INTEGER\\s+PRIMARY\\s+KEY\\s+AUTOINCREMENT\\b`,
    'iu',
  ).test(source)
}
