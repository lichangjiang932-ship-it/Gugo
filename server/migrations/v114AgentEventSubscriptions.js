import { TURN_EVENT_TYPES } from '../../shared/turnEvents.js'
import {
  hasAgentEventSubscriptionChecks,
  hasAgentEventSubscriptionDlqChecks,
} from '../agentEventSubscriptionSchemaContract.js'
import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'

const VERSION = 114
const EVENT_TYPE_SQL = TURN_EVENT_TYPES.map((type) => `'${type.replaceAll("'", "''")}'`).join(', ')

const REQUIRED_COLUMNS = Object.freeze({
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

const REQUIRED_INDEXES = Object.freeze({
  idx_agent_event_subscriptions_retention: Object.freeze({
    table: 'agent_event_subscriptions',
    columns: ['status', 'stream_epoch', 'scanned_cursor'],
  }),
  idx_agent_event_subscriptions_lease: Object.freeze({
    table: 'agent_event_subscriptions',
    columns: ['status', 'lease_expires_at', 'subscription_key'],
  }),
  idx_agent_event_subscription_dlq_time: Object.freeze({
    table: 'agent_event_subscription_dlq',
    columns: ['subscription_key', 'failed_at', 'dlq_id'],
  }),
})

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

function exactUniqueKey(db, table, columns) {
  return db.prepare(`
    SELECT name, "unique" AS isUnique, partial FROM pragma_index_list(?)
  `).all(table).some((index) => {
    if (Number(index.isUnique) !== 1 || Number(index.partial) !== 0) return false
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index.name)
      .map((row) => row.name)
    return actual.length === columns.length
      && actual.every((column, position) => column === columns[position])
  })
}

function assertIndexes(db, missing) {
  for (const [name, spec] of Object.entries(REQUIRED_INDEXES)) {
    const schema = db.prepare(`
      SELECT tbl_name AS tableName FROM sqlite_schema
      WHERE type = 'index' AND name = ?
    `).get(name)
    const metadata = db.prepare(`
      SELECT "unique" AS isUnique, partial
      FROM pragma_index_list(?) WHERE name = ?
    `).get(spec.table, name)
    if (!schema
      || schema.tableName !== spec.table
      || !metadata
      || Number(metadata.isUnique) !== 0
      || Number(metadata.partial) !== 0) {
      missing.push(`index:${name}`)
      continue
    }
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(name)
      .map((row) => row.name)
    if (actual.length !== spec.columns.length
      || actual.some((column, position) => column !== spec.columns[position])) {
      missing.push(`index-columns:${name}`)
    }
  }
}

function assertV114Schema(db, { initialized = false } = {}) {
  const missing = []
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!exactColumns(db, table, columns)) missing.push(`table-shape:${table}`)
  }
  const subscriptionSql = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'agent_event_subscriptions'
  `).get()?.sql
  if (!hasAgentEventSubscriptionChecks(subscriptionSql)) {
    missing.push('constraints:agent_event_subscriptions')
  }
  const dlqSql = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'agent_event_subscription_dlq'
  `).get()?.sql
  if (!/(?:\(|,)\s*dlq_id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/iu.test(dlqSql || '')) {
    missing.push('autoincrement-primary-key:agent_event_subscription_dlq.dlq_id')
  }
  if (!hasAgentEventSubscriptionDlqChecks(dlqSql)) {
    missing.push('constraints:agent_event_subscription_dlq')
  }
  if (!exactUniqueKey(db, 'agent_event_subscription_dlq', ['subscription_key', 'cursor'])) {
    missing.push('unique-key:agent_event_subscription_dlq.subscription_key,cursor')
  }
  const foreignKeys = db.prepare(`
    SELECT * FROM pragma_foreign_key_list('agent_event_subscription_dlq')
  `).all()
  if (foreignKeys.length !== 1
    || foreignKeys[0].from !== 'subscription_key'
    || foreignKeys[0].table !== 'agent_event_subscriptions'
    || foreignKeys[0].to !== 'subscription_key'
    || foreignKeys[0].on_delete !== 'CASCADE') {
    missing.push('foreign-key:agent_event_subscription_dlq.subscription_key')
  }
  if (initialized) assertIndexes(db, missing)
  if (missing.length > 0) {
    throw databaseSchemaIncompleteError({
      expectedVersion: VERSION,
      stage: 'migration-v114',
      missing,
    })
  }
}

/** Add durable v2 consumer identity, fenced cursor state, retry, and DLQ storage. */
export function migrateToV114(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_event_subscriptions (
      subscription_key TEXT PRIMARY KEY NOT NULL CHECK (
        length(subscription_key) = 64
        AND subscription_key NOT GLOB '*[^0-9a-f]*'
      ),
      publisher_id TEXT NOT NULL CHECK (length(publisher_id) BETWEEN 1 AND 128),
      publisher_key_id TEXT NOT NULL CHECK (length(publisher_key_id) BETWEEN 1 AND 256),
      package_digest TEXT NOT NULL CHECK (
        length(package_digest) = 71
        AND substr(package_digest, 1, 7) = 'sha256-'
        AND substr(package_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      publication_digest TEXT NOT NULL CHECK (
        length(publication_digest) = 71
        AND substr(publication_digest, 1, 7) = 'sha256-'
        AND substr(publication_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
      release_content_digest TEXT NOT NULL CHECK (
        length(release_content_digest) = 71
        AND substr(release_content_digest, 1, 7) = 'sha256-'
        AND substr(release_content_digest, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      release_digest_version INTEGER NOT NULL CHECK (
        typeof(release_digest_version) = 'integer' AND release_digest_version >= 1
      ),
      plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 80),
      plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 128),
      subscription_id TEXT NOT NULL CHECK (length(subscription_id) BETWEEN 1 AND 128),
      event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_SQL})),
      contract_version INTEGER NOT NULL CHECK (
        typeof(contract_version) = 'integer' AND contract_version = 2
      ),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      acked_cursor INTEGER NOT NULL CHECK (
        typeof(acked_cursor) = 'integer' AND acked_cursor >= 0
      ),
      scanned_cursor INTEGER NOT NULL CHECK (
        typeof(scanned_cursor) = 'integer' AND scanned_cursor >= acked_cursor
      ),
      stream_epoch INTEGER NOT NULL CHECK (
        typeof(stream_epoch) = 'integer' AND stream_epoch >= 1
      ),
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL CHECK (
        typeof(lease_generation) = 'integer' AND lease_generation >= 0
      ),
      lease_expires_at INTEGER,
      retry_cursor INTEGER,
      retry_attempts INTEGER NOT NULL CHECK (
        typeof(retry_attempts) = 'integer' AND retry_attempts >= 0
      ),
      retry_not_before INTEGER,
      retry_max_attempts INTEGER NOT NULL CHECK (
        typeof(retry_max_attempts) = 'integer' AND retry_max_attempts BETWEEN 1 AND 100
      ),
      retry_base_delay_ms INTEGER NOT NULL CHECK (
        typeof(retry_base_delay_ms) = 'integer'
        AND retry_base_delay_ms BETWEEN 1 AND 604800000
      ),
      retry_max_delay_ms INTEGER NOT NULL CHECK (
        typeof(retry_max_delay_ms) = 'integer'
        AND retry_max_delay_ms BETWEEN retry_base_delay_ms AND 604800000
      ),
      created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at >= 0
      ),
      updated_at INTEGER NOT NULL CHECK (
        typeof(updated_at) = 'integer' AND updated_at >= created_at
      ),
      CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (
          lease_owner IS NOT NULL
          AND length(lease_owner) BETWEEN 1 AND 256
          AND typeof(lease_expires_at) = 'integer'
          AND lease_expires_at >= 0
        )
      ),
      CHECK (
        (retry_cursor IS NULL AND retry_attempts = 0 AND retry_not_before IS NULL)
        OR (
          typeof(retry_cursor) = 'integer'
          AND retry_cursor > scanned_cursor
          AND retry_attempts BETWEEN 1 AND retry_max_attempts - 1
          AND typeof(retry_not_before) = 'integer'
          AND retry_not_before >= 0
        )
      )
    );

    CREATE TABLE IF NOT EXISTS agent_event_subscription_dlq (
      dlq_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
        typeof(dlq_id) = 'integer' AND dlq_id > 0
      ),
      subscription_key TEXT NOT NULL
        REFERENCES agent_event_subscriptions(subscription_key) ON DELETE CASCADE,
      cursor INTEGER NOT NULL CHECK (typeof(cursor) = 'integer' AND cursor > 0),
      event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPE_SQL})),
      failure_code TEXT NOT NULL CHECK (
        length(failure_code) BETWEEN 1 AND 128
        AND failure_code NOT GLOB '*[^A-Z0-9_]*'
      ),
      attempts INTEGER NOT NULL CHECK (
        typeof(attempts) = 'integer' AND attempts BETWEEN 1 AND 100
      ),
      failed_at INTEGER NOT NULL CHECK (
        typeof(failed_at) = 'integer' AND failed_at >= 0
      ),
      UNIQUE(subscription_key, cursor)
    );
  `)
  assertV114Schema(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_event_subscriptions_retention
      ON agent_event_subscriptions(status, stream_epoch, scanned_cursor);
    CREATE INDEX IF NOT EXISTS idx_agent_event_subscriptions_lease
      ON agent_event_subscriptions(status, lease_expires_at, subscription_key);
    CREATE INDEX IF NOT EXISTS idx_agent_event_subscription_dlq_time
      ON agent_event_subscription_dlq(subscription_key, failed_at, dlq_id);
  `)
  assertV114Schema(db, { initialized: true })
}
