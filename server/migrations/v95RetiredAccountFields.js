function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function columnExists(db, table, column) {
  return tableExists(db, table)
    && db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

const HISTORICAL_LEDGER_COLUMNS = Object.freeze([
  { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
  { name: 'user_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'package_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'model_name', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'credits', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'balance', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
])
const HISTORICAL_LEDGER_MARKERS = Object.freeze(['package_id', 'model_name', 'credits', 'balance'])

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function migrationError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
    ...details,
  })
}

function isHistoricalLedgerForeignKey(row) {
  return String(row.table || '').toLowerCase() === 'users'
    && String(row.from || '').toLowerCase() === 'user_id'
    && String(row.to || '').toLowerCase() === 'id'
    && String(row.on_update || '').toUpperCase() === 'NO ACTION'
    && String(row.on_delete || '').toUpperCase() === 'CASCADE'
}

function classifyLedgerTable(db) {
  if (!tableExists(db, 'ledger')) return 'absent'

  const columns = db.prepare('PRAGMA table_xinfo("ledger")').all()
  const exactColumns = columns.length === HISTORICAL_LEDGER_COLUMNS.length
    && columns.every((column, index) => {
      const expected = HISTORICAL_LEDGER_COLUMNS[index]
      return column.name === expected.name
        && String(column.type || '').trim().toUpperCase() === expected.type
        && Number(column.notnull) === expected.notnull
        && Number(column.pk) === expected.pk
        && Number(column.hidden || 0) === 0
        && column.dflt_value == null
    })
  const foreignKeys = db.prepare('PRAGMA foreign_key_list("ledger")').all()
  const exactForeignKey = foreignKeys.length === 1 && isHistoricalLedgerForeignKey(foreignKeys[0])

  if (exactColumns && exactForeignKey) return 'historical'

  const columnNames = new Set(columns.map((column) => String(column.name || '').toLowerCase()))
  const markerCount = HISTORICAL_LEDGER_MARKERS
    .filter((name) => columnNames.has(name))
    .length
  if (exactColumns || markerCount >= 2) return 'ambiguous'
  return 'unrelated'
}

function stripSqlStringsAndComments(sql) {
  const source = String(sql || '')
  let result = ''
  let state = 'code'

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        state = 'code'
        result += char
      } else {
        result += ' '
      }
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        result += '  '
        index += 1
        state = 'code'
      } else {
        result += char === '\n' || char === '\r' ? char : ' '
      }
      continue
    }
    if (state === 'string') {
      if (char === "'" && next === "'") {
        result += '  '
        index += 1
      } else if (char === "'") {
        result += ' '
        state = 'code'
      } else {
        result += char === '\n' || char === '\r' ? char : ' '
      }
      continue
    }
    if (char === '-' && next === '-') {
      result += '  '
      index += 1
      state = 'line-comment'
    } else if (char === '/' && next === '*') {
      result += '  '
      index += 1
      state = 'block-comment'
    } else if (char === "'") {
      result += ' '
      state = 'string'
    } else {
      result += char
    }
  }
  return result
}

function sqlReferencesLedger(sql) {
  const code = stripSqlStringsAndComments(sql)
  return /(^|[^\p{L}\p{N}_$])ledger(?=$|[^\p{L}\p{N}_$])/iu.test(code)
}

function hasCanonicalLedgerIndex(db) {
  const index = db.prepare('PRAGMA index_list("ledger")').all()
    .find((row) => row.name === 'idx_ledger_user')
  if (!index || Number(index.unique) !== 0 || Number(index.partial) !== 0) return false
  const columns = db.prepare('PRAGMA index_info("idx_ledger_user")').all()
  return columns.length === 2
    && columns[0].name === 'user_id'
    && columns[1].name === 'created_at'
}

function findLedgerDependencies(db) {
  const dependencies = []
  const tables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND lower(name) <> 'ledger'
    ORDER BY name
  `).all()
  for (const { name } of tables) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all()
    for (const foreignKey of foreignKeys) {
      if (String(foreignKey.table || '').toLowerCase() !== 'ledger') continue
      dependencies.push({
        type: 'foreign_key',
        name,
        from: foreignKey.from,
        to: foreignKey.to,
        onDelete: foreignKey.on_delete,
        onUpdate: foreignKey.on_update,
      })
    }
  }

  const externalSchemaObjects = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE type IN ('view', 'trigger') AND sql IS NOT NULL
      AND NOT (type = 'trigger' AND lower(tbl_name) = 'ledger')
    ORDER BY type, name
  `).all()
  for (const object of externalSchemaObjects) {
    if (!sqlReferencesLedger(object.sql)) continue
    dependencies.push({ type: object.type, name: object.name, table: object.tbl_name })
  }

  const ownedSchemaObjects = db.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE lower(tbl_name) = 'ledger' AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all()
  for (const object of ownedSchemaObjects) {
    if (object.type === 'index' && object.name === 'idx_ledger_user' && hasCanonicalLedgerIndex(db)) continue
    dependencies.push({ type: object.type, name: object.name, table: 'ledger' })
  }
  return dependencies
}

/**
 * Remove obsolete platform-accounting storage from historical databases.
 *
 * These names are intentionally confined to this one-way migration. Gugo is a
 * local-first BYOK runtime: it has no platform balance, package, or charge
 * system. SQLite DROP COLUMN preserves every unrelated column, including local
 * extensions added by older installations.
 */
export function migrateToV95(db) {
  db.transaction(() => {
    const ledgerKind = classifyLedgerTable(db)
    if (ledgerKind === 'ambiguous') {
      throw migrationError(
        'DB_MIGRATION_AMBIGUOUS_RETIRED_LEDGER',
        'A ledger table resembles the retired account table but has an unknown schema; refusing to delete local extension data.',
      )
    }
    if (ledgerKind === 'historical') {
      const dependencies = findLedgerDependencies(db)
      if (dependencies.length) {
        throw migrationError(
          'DB_MIGRATION_EXTERNAL_LEDGER_DEPENDENCY',
          'The retired account ledger is still referenced by local extension schema; refusing a destructive migration.',
          { dependencies },
        )
      }
      db.exec('DROP TABLE ledger')
    }
    if (columnExists(db, 'users', 'credits')) {
      db.exec('ALTER TABLE users DROP COLUMN credits')
    }
    if (columnExists(db, 'session_meters', 'cost_credits')) {
      db.exec('ALTER TABLE session_meters DROP COLUMN cost_credits')
    }
    if (columnExists(db, 'subagent_runs', 'credits')) {
      db.exec('ALTER TABLE subagent_runs DROP COLUMN credits')
    }
    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length) {
      const error = new Error('Retired account-field migration would leave foreign-key violations')
      error.code = 'DB_MIGRATION_FOREIGN_KEY_VIOLATION'
      error.violations = foreignKeyViolations
      throw error
    }
  }).immediate()
}
