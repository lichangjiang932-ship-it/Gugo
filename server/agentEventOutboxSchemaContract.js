const EXPECTED_COLUMNS = Object.freeze({
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

const OUTBOX_CHECK_FRAGMENTS = Object.freeze([
  "check(typeof(cursor)='integer'andcursor>0)",
  'check(length(event_id)between1and512)',
  'check(length(event_type)between1and128)',
  "check(json_valid(envelope_json)andjson_type(envelope_json)='object')",
  "check(length(event_fingerprint)=64andevent_fingerprintnotglob'*[^0-9a-f]*')",
  "check(typeof(created_at)='integer'andcreated_at>=0)",
])

export function hasAgentEventOutboxChecks(value) {
  return containsAll(compactSql(value), OUTBOX_CHECK_FRAGMENTS)
}

function hasSingletonStreamMetadata(db) {
  try {
    const rows = db.prepare(`
      SELECT stream_key, epoch, truncated_through
      FROM agent_event_stream_metadata ORDER BY stream_key
    `).all()
    return rows.length === 1
      && rows[0].stream_key === 'global'
      && Number.isSafeInteger(rows[0].epoch)
      && rows[0].epoch >= 1
      && Number.isSafeInteger(rows[0].truncated_through)
      && rows[0].truncated_through >= 0
  } catch {
    return false
  }
}

export function collectAgentEventOutboxSchemaProblems(db) {
  const missing = []
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    if (!exactColumns(db, table, columns)) missing.push(`table-shape:${table}`)
  }

  const outboxSql = tableSql(db, 'agent_event_outbox')
  if (!hasAgentEventOutboxChecks(outboxSql)) missing.push('constraints:agent_event_outbox')

  const metadataSql = tableSql(db, 'agent_event_stream_metadata')
  if (!containsAll(metadataSql, [
    "check(stream_key='global')",
    "check(typeof(epoch)='integer'andepoch>=1)",
    "check(typeof(truncated_through)='integer'andtruncated_through>=0)",
  ]) || !metadataSql.endsWith(')withoutrowid')) {
    missing.push('constraints:agent_event_stream_metadata')
  }
  if (!hasSingletonStreamMetadata(db)) {
    missing.push('singleton:agent_event_stream_metadata.global')
  }
  return missing
}
