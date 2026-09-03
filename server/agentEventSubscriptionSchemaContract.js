import { TURN_EVENT_TYPES } from '../shared/turnEvents.js'

const EXPECTED_COLUMNS = Object.freeze({
  agent_event_subscriptions: Object.freeze([
    ['subscription_key', 'TEXT', 1, 1],
    ['publisher_id', 'TEXT', 1, 0],
    ['publisher_key_id', 'TEXT', 1, 0],
    ['package_digest', 'TEXT', 1, 0],
    ['publication_digest', 'TEXT', 1, 0],
    ['release_id', 'TEXT', 1, 0],
    ['release_content_digest', 'TEXT', 1, 0],
    ['release_digest_version', 'INTEGER', 1, 0],
    ['plugin_id', 'TEXT', 1, 0],
    ['plugin_version', 'TEXT', 1, 0],
    ['subscription_id', 'TEXT', 1, 0],
    ['event_type', 'TEXT', 1, 0],
    ['contract_version', 'INTEGER', 1, 0],
    ['status', 'TEXT', 1, 0],
    ['acked_cursor', 'INTEGER', 1, 0],
    ['scanned_cursor', 'INTEGER', 1, 0],
    ['stream_epoch', 'INTEGER', 1, 0],
    ['lease_owner', 'TEXT', 0, 0],
    ['lease_generation', 'INTEGER', 1, 0],
    ['lease_expires_at', 'INTEGER', 0, 0],
    ['retry_cursor', 'INTEGER', 0, 0],
    ['retry_attempts', 'INTEGER', 1, 0],
    ['retry_not_before', 'INTEGER', 0, 0],
    ['retry_max_attempts', 'INTEGER', 1, 0],
    ['retry_base_delay_ms', 'INTEGER', 1, 0],
    ['retry_max_delay_ms', 'INTEGER', 1, 0],
    ['created_at', 'INTEGER', 1, 0],
    ['updated_at', 'INTEGER', 1, 0],
  ]),
  agent_event_subscription_dlq: Object.freeze([
    ['dlq_id', 'INTEGER', 0, 1],
    ['subscription_key', 'TEXT', 1, 0],
    ['cursor', 'INTEGER', 1, 0],
    ['event_type', 'TEXT', 1, 0],
    ['failure_code', 'TEXT', 1, 0],
    ['attempts', 'INTEGER', 1, 0],
    ['failed_at', 'INTEGER', 1, 0],
  ]),
})

function compactSql(value) {
  return String(value || '').toLowerCase().replace(/[\s"`]+/gu, '')
}

function exactColumns(db, table, expected) {
  const actual = db.prepare(`
    SELECT name, upper(type) AS type, "notnull" AS isNotNull, pk
    FROM pragma_table_info(?) ORDER BY cid
  `).all(table)
  return actual.length === expected.length && actual.every((column, index) => {
    const [name, type, isNotNull, primaryKeyPosition] = expected[index]
    return column.name === name
      && column.type === type
      && Number(column.isNotNull) === isNotNull
      && Number(column.pk) === primaryKeyPosition
  })
}

function tableSql(db, table) {
  return compactSql(db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table)?.sql)
}

function containsAll(value, fragments) {
  return fragments.every((fragment) => value.includes(fragment))
}

export function hasAgentEventSubscriptionChecks(value) {
  const sql = compactSql(value)
  const eventTypes = compactSql(TURN_EVENT_TYPES
    .map((type) => `'${type.replaceAll("'", "''")}'`)
    .join(', '))
  return containsAll(sql, [
    "check(length(subscription_key)=64andsubscription_keynotglob'*[^0-9a-f]*')",
    'check(length(publisher_id)between1and128)',
    'check(length(publisher_key_id)between1and256)',
    "check(length(package_digest)=71andsubstr(package_digest,1,7)='sha256-'andsubstr(package_digest,8)notglob'*[^0-9a-f]*')",
    "check(length(publication_digest)=71andsubstr(publication_digest,1,7)='sha256-'andsubstr(publication_digest,8)notglob'*[^0-9a-f]*')",
    'check(length(release_id)between1and128)',
    "check(length(release_content_digest)=71andsubstr(release_content_digest,1,7)='sha256-'andsubstr(release_content_digest,8)notglob'*[^0-9a-f]*')",
    "check(typeof(release_digest_version)='integer'andrelease_digest_version>=1)",
    'check(length(plugin_id)between1and80)',
    'check(length(plugin_version)between1and128)',
    'check(length(subscription_id)between1and128)',
    `check(event_typein(${eventTypes}))`,
    "check(typeof(contract_version)='integer'andcontract_version=2)",
    "check(statusin('active','disabled'))",
    "check(typeof(acked_cursor)='integer'andacked_cursor>=0)",
    "check(typeof(scanned_cursor)='integer'andscanned_cursor>=acked_cursor)",
    "check(typeof(stream_epoch)='integer'andstream_epoch>=1)",
    "check(typeof(lease_generation)='integer'andlease_generation>=0)",
    "check(typeof(retry_attempts)='integer'andretry_attempts>=0)",
    "check(typeof(retry_max_attempts)='integer'andretry_max_attemptsbetween1and100)",
    "check(typeof(retry_base_delay_ms)='integer'andretry_base_delay_msbetween1and604800000)",
    "check(typeof(retry_max_delay_ms)='integer'andretry_max_delay_msbetweenretry_base_delay_msand604800000)",
    "check(typeof(created_at)='integer'andcreated_at>=0)",
    "check(typeof(updated_at)='integer'andupdated_at>=created_at)",
    "check((lease_ownerisnullandlease_expires_atisnull)or(lease_ownerisnotnullandlength(lease_owner)between1and256andtypeof(lease_expires_at)='integer'andlease_expires_at>=0))",
    "check((retry_cursorisnullandretry_attempts=0andretry_not_beforeisnull)or(typeof(retry_cursor)='integer'andretry_cursor>scanned_cursorandretry_attemptsbetween1andretry_max_attempts-1andtypeof(retry_not_before)='integer'andretry_not_before>=0))",
  ])
}

export function hasAgentEventSubscriptionDlqChecks(value) {
  const sql = compactSql(value)
  const eventTypes = compactSql(TURN_EVENT_TYPES
    .map((type) => `'${type.replaceAll("'", "''")}'`)
    .join(', '))
  return containsAll(sql, [
    "check(typeof(dlq_id)='integer'anddlq_id>0)",
    "check(typeof(cursor)='integer'andcursor>0)",
    `check(event_typein(${eventTypes}))`,
    "check(length(failure_code)between1and128andfailure_codenotglob'*[^a-z0-9_]*')",
    "check(typeof(attempts)='integer'andattemptsbetween1and100)",
    "check(typeof(failed_at)='integer'andfailed_at>=0)",
  ])
}

export function collectAgentEventSubscriptionSchemaProblems(db) {
  const missing = []
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    if (!exactColumns(db, table, columns)) missing.push(`table-shape:${table}`)
  }

  const subscriptionSql = tableSql(db, 'agent_event_subscriptions')
  if (!hasAgentEventSubscriptionChecks(subscriptionSql)) {
    missing.push('constraints:agent_event_subscriptions')
  }

  const dlqSql = tableSql(db, 'agent_event_subscription_dlq')
  if (!hasAgentEventSubscriptionDlqChecks(dlqSql)) {
    missing.push('constraints:agent_event_subscription_dlq')
  }
  return missing
}
