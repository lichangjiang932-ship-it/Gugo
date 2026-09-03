import { hasAgentEventOutboxChecks } from '../agentEventOutboxSchemaContract.js'
import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'

const VERSION = 113
const REQUIRED_COLUMNS = Object.freeze({
  agent_event_outbox: Object.freeze([
    ['cursor', 'INTEGER', 0, 1],
    ['event_id', 'TEXT', 1, 0],
    ['user_id', 'TEXT', 1, 0],
    ['event_type', 'TEXT', 1, 0],
    ['envelope_json', 'TEXT', 1, 0],
    ['event_fingerprint', 'TEXT', 1, 0],
    ['created_at', 'INTEGER', 1, 0],
  ]),
  agent_event_stream_metadata: Object.freeze([
    ['stream_key', 'TEXT', 1, 1],
    ['epoch', 'INTEGER', 1, 0],
    ['truncated_through', 'INTEGER', 1, 0],
  ]),
})
const REQUIRED_INDEXES = Object.freeze({
  idx_agent_event_outbox_user_cursor: Object.freeze(['user_id', 'cursor']),
  idx_agent_event_outbox_type_cursor: Object.freeze(['event_type', 'cursor']),
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

function hasExactUniqueKey(db, table, columns) {
  return db.prepare(`
    SELECT name, "unique" AS isUnique, partial
    FROM pragma_index_list(?)
  `).all(table).some((index) => {
    if (Number(index.isUnique) !== 1 || Number(index.partial) !== 0) return false
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index.name)
      .map((row) => row.name)
    return actual.length === columns.length
      && actual.every((column, position) => column === columns[position])
  })
}

function assertOutboxIndexes(db, missing) {
  for (const [name, columns] of Object.entries(REQUIRED_INDEXES)) {
    const schema = db.prepare(`
      SELECT tbl_name AS tableName FROM sqlite_schema
      WHERE type = 'index' AND name = ?
    `).get(name)
    const metadata = db.prepare(`
      SELECT "unique" AS isUnique, partial
      FROM pragma_index_list('agent_event_outbox') WHERE name = ?
    `).get(name)
    if (!schema
      || schema.tableName !== 'agent_event_outbox'
      || !metadata
      || Number(metadata.isUnique) !== 0
      || Number(metadata.partial) !== 0) {
      missing.push(`index:${name}`)
      continue
    }
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(name)
      .map((row) => row.name)
    if (actual.length !== columns.length
      || actual.some((column, position) => column !== columns[position])) {
      missing.push(`index-columns:${name}`)
    }
  }
}

function hasMetadataChecks(tableSql) {
  const sql = String(tableSql || '').replace(/\s+/gu, ' ')
  return /\bstream_key\s+TEXT\s+PRIMARY\s+KEY\s+NOT\s+NULL\s+CHECK\s*\(\s*stream_key\s*=\s*'global'\s*\)/iu.test(sql)
    && /\bepoch\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*typeof\s*\(\s*epoch\s*\)\s*=\s*'integer'\s+AND\s+epoch\s*>=\s*1\s*\)/iu.test(sql)
    && /\btruncated_through\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*typeof\s*\(\s*truncated_through\s*\)\s*=\s*'integer'\s+AND\s+truncated_through\s*>=\s*0\s*\)/iu.test(sql)
    && /\)\s+WITHOUT\s+ROWID\s*$/iu.test(sql)
}

function assertV113Schema(db, { initialized = false } = {}) {
  const missing = []
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    if (!exactColumns(db, table, columns)) missing.push(`table-shape:${table}`)
  }

  const outboxSql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_event_outbox'
  `).get()?.sql || ''
  if (!/(?:\(|,)\s*cursor\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/iu.test(outboxSql)) {
    missing.push('autoincrement-primary-key:agent_event_outbox.cursor')
  }
  if (!hasAgentEventOutboxChecks(outboxSql)) {
    missing.push('constraints:agent_event_outbox')
  }
  if (!hasExactUniqueKey(db, 'agent_event_outbox', ['event_id'])) {
    missing.push('unique-key:agent_event_outbox.event_id')
  }
  const ownerForeignKeys = db.prepare(`
    SELECT * FROM pragma_foreign_key_list('agent_event_outbox')
  `).all()
  if (ownerForeignKeys.length !== 1
    || ownerForeignKeys[0].from !== 'user_id'
    || ownerForeignKeys[0].table !== 'users'
    || ownerForeignKeys[0].to !== 'id'
    || ownerForeignKeys[0].on_delete !== 'CASCADE') {
    missing.push('foreign-key:agent_event_outbox.user_id')
  }

  const metadataSql = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'agent_event_stream_metadata'
  `).get()?.sql
  if (!hasMetadataChecks(metadataSql)) {
    missing.push('constraints:agent_event_stream_metadata')
  }
  if (initialized) {
    assertOutboxIndexes(db, missing)
    const metadataRows = db.prepare(`
      SELECT stream_key, epoch, truncated_through
      FROM agent_event_stream_metadata ORDER BY stream_key
    `).all()
    if (metadataRows.length !== 1
      || metadataRows[0].stream_key !== 'global'
      || !Number.isSafeInteger(metadataRows[0].epoch)
      || metadataRows[0].epoch < 1
      || !Number.isSafeInteger(metadataRows[0].truncated_through)
      || metadataRows[0].truncated_through < 0) {
      missing.push('singleton:agent_event_stream_metadata.global')
    }
  }

  if (missing.length > 0) {
    throw databaseSchemaIncompleteError({
      expectedVersion: VERSION,
      stage: 'migration-v113',
      missing,
    })
  }
}

/**
 * Durable capture for Agent Event replay. Delivery state intentionally lives
 * elsewhere: v113 only guarantees that a committed Turn event has a stable,
 * globally ordered transport envelope available to future consumers.
 */
export function migrateToV113(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_event_outbox (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT CHECK (
        typeof(cursor) = 'integer' AND cursor > 0
      ),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 512),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
      envelope_json TEXT NOT NULL CHECK (
        json_valid(envelope_json) AND json_type(envelope_json) = 'object'
      ),
      event_fingerprint TEXT NOT NULL CHECK (
        length(event_fingerprint) = 64
        AND event_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      created_at INTEGER NOT NULL CHECK (
        typeof(created_at) = 'integer' AND created_at >= 0
      )
    );

    CREATE TABLE IF NOT EXISTS agent_event_stream_metadata (
      stream_key TEXT PRIMARY KEY NOT NULL CHECK (stream_key = 'global'),
      epoch INTEGER NOT NULL CHECK (
        typeof(epoch) = 'integer' AND epoch >= 1
      ),
      truncated_through INTEGER NOT NULL CHECK (
        typeof(truncated_through) = 'integer' AND truncated_through >= 0
      )
    ) WITHOUT ROWID;

  `)
  assertV113Schema(db)
  db.exec(`
    INSERT INTO agent_event_stream_metadata (
      stream_key, epoch, truncated_through
    ) VALUES ('global', 1, 0)
    ON CONFLICT(stream_key) DO NOTHING;

    CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_user_cursor
      ON agent_event_outbox(user_id, cursor);
    CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_type_cursor
      ON agent_event_outbox(event_type, cursor);
  `)
  assertV113Schema(db, { initialized: true })
}
