const TABLE = 'session_transcript_recovery_fences'
const EXPECTED_COLUMNS = Object.freeze([
  ['user_id', 'TEXT', 1],
  ['session_id', 'TEXT', 2],
  ['turn_id', 'TEXT', 3],
  ['suppressed_through_sequence', 'INTEGER', 0],
])

export function collectSessionTranscriptRecoverySchemaProblems(db) {
  const missing = []
  const columns = db.prepare(`
    SELECT name, upper(type) AS type, "notnull" AS is_not_null, pk
    FROM pragma_table_info(?) ORDER BY cid
  `).all(TABLE)
  if (columns.length !== EXPECTED_COLUMNS.length
    || columns.some((column, index) => {
      const [name, type, primaryKeyPosition] = EXPECTED_COLUMNS[index] || []
      return column.name !== name || column.type !== type
        || Number(column.is_not_null) !== 1 || Number(column.pk) !== primaryKeyPosition
    })) {
    missing.push(`table-shape:${TABLE}`)
  }
  const foreignKeys = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(TABLE)
  for (const [from, table, to] of [['user_id', 'users', 'id'], ['session_id', 'sessions', 'token']]) {
    if (!foreignKeys.some((key) => key.from === from && key.table === table
      && key.to === to && key.on_delete === 'CASCADE')) {
      missing.push(`foreign-key:${TABLE}.${from}`)
    }
  }
  const sql = String(db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(TABLE)?.sql || '').toLowerCase().replace(/[\s"`]+/gu, '')
  if (!sql.includes("check(typeof(suppressed_through_sequence)='integer'andsuppressed_through_sequence>=-1)")) {
    missing.push(`constraints:${TABLE}`)
  }
  return missing
}
