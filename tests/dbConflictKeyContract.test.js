import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import Database from 'better-sqlite3'

import {
  REQUIRED_PRIMARY_KEYS,
  REQUIRED_UNIQUE_KEYS,
  collectMissingRequiredKeyConstraints,
} from '../server/dbSchemaContract.js'

const SERVER_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server',
)
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const WRITE_SIGNAL_PATTERN = /\b(?:INSERT|REPLACE)\b/gi
const INSERT_INTO_PATTERN = /\b(?:INSERT\s+(?:OR\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\s+)?|REPLACE\s+)INTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi
const LEGACY_CONFLICT_WRITE_PATTERN = /\b(?:INSERT\s+OR\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\s+INTO|REPLACE\s+INTO)\b/gi
const LEGACY_CONFLICT_WRITE_TEST_PATTERN = /\b(?:INSERT\s+OR\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\s+INTO|REPLACE\s+INTO)\b/i
const ON_CONFLICT_PATTERN = /\bON\s+CONFLICT\b/gi
const ON_CONFLICT_TEST_PATTERN = /\bON\s+CONFLICT\b/i
const ON_CONFLICT_TARGET_PATTERN = /^\s*\(([^)]*)\)/
const EXPECTED_RUNTIME_ON_CONFLICT_CALLS = 61
const EXPECTED_RUNTIME_ON_CONFLICT_TARGETS = 52
const REQUIRED_NON_RUNTIME_KEY_IDS = new Set([
  'agent_event_outbox.cursor',
  'agent_event_subscription_dlq.dlq_id',
  'agent_event_subscription_dlq.subscription_key,cursor',
  'agent_event_stream_metadata.stream_key',
  'pinned_memories.id',
  'session_meters.session_id',
  'todos.id',
  'users.email',
])

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function uniqueKeyId(table, columns) {
  return `${table}.${columns.join(',')}`
}

function runtimeSourceFiles(directory = SERVER_DIRECTORY) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (directory === SERVER_DIRECTORY && entry.name === 'migrations') return []
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return runtimeSourceFiles(fullPath)
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : []
  }).sort()
}

function walkSyntaxTree(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node, parent)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue
    if (Array.isArray(value)) {
      for (const child of value) walkSyntaxTree(child, visit, node)
    } else if (value && typeof value === 'object') {
      walkSyntaxTree(value, visit, node)
    }
  }
}

function containsUpsertSignal(fragments) {
  return [fragments.join(' '), fragments.join('')].some((value) => (
    /\bON\s+CONFLICT\b/i.test(value)
    || /\bREPLACE\s+INTO\b/i.test(value)
    || (/\bINSERT\b/i.test(value) && /\bINTO\b/i.test(value))
  ))
}

function templateContainsUpsertSignal(node) {
  return containsUpsertSignal(node.quasis.map((quasi) => quasi.value.raw))
}

function staticStringValue(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const { cooked, raw } = node.quasis[0]?.value || {}
    return typeof cooked === 'string' ? cooked : raw ?? null
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringValue(node.left)
    const right = staticStringValue(node.right)
    return typeof left === 'string' && typeof right === 'string' ? left + right : null
  }
  return null
}

function concatenationFragments(node) {
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return [
      ...concatenationFragments(node.left),
      ...concatenationFragments(node.right),
    ]
  }
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((quasi) => quasi.value.raw)
  }
  const value = staticStringValue(node)
  return typeof value === 'string' ? [value] : ['']
}

function conflictTargetsInLiteral(sql, relativePath, line) {
  const targets = []
  const errors = []
  const writeSignals = [...sql.matchAll(WRITE_SIGNAL_PATTERN)]
  const inserts = [...sql.matchAll(INSERT_INTO_PATTERN)]
  const conflicts = [...sql.matchAll(ON_CONFLICT_PATTERN)]
  const legacyWrites = [...sql.matchAll(LEGACY_CONFLICT_WRITE_PATTERN)]

  errors.push(...legacyWrites.map(() => (
    `${relativePath}:${line}: legacy SQLite conflict algorithm is forbidden`
  )))

  for (const conflict of conflicts) {
    const target = ON_CONFLICT_TARGET_PATTERN.exec(
      sql.slice(conflict.index + conflict[0].length),
    )
    const insert = inserts.filter(({ index }) => index < conflict.index).at(-1)
    const writeSignal = writeSignals.filter(({ index }) => index < conflict.index).at(-1)
    const columns = target?.[1].split(',').map((column) => column.trim().toLowerCase()) || []
    const table = insert?.[1]?.toLowerCase() || ''
    const usesLegacyConflictAlgorithm = insert
      && LEGACY_CONFLICT_WRITE_TEST_PATTERN.test(insert[0])

    if (!table || insert.index !== writeSignal?.index
      || columns.length === 0 || columns.some((column) => (
      !SQL_IDENTIFIER_PATTERN.test(column)
    )) || usesLegacyConflictAlgorithm) {
      if (!usesLegacyConflictAlgorithm) errors.push(`${relativePath}:${line}`)
      continue
    }
    targets.push({ table, columns, file: relativePath })
  }

  return { callCount: conflicts.length, errors, targets }
}

function conflictTargetsInSource(source, relativePath) {
  const targets = []
  const errors = []
  let callCount = 0
  let syntaxTree

  try {
    syntaxTree = parse(source, {
      ecmaVersion: 'latest',
      locations: true,
      sourceType: 'module',
    })
  } catch (error) {
    errors.push(`${relativePath}:${error.loc?.line || 1}: ${error.message}`)
    return { callCount, errors, targets }
  }

  walkSyntaxTree(syntaxTree, (node, parent) => {
    const isConcatenationChild = parent?.type === 'BinaryExpression' && parent.operator === '+'
    if (isConcatenationChild && (
      node.type === 'BinaryExpression'
      || node.type === 'Literal'
      || node.type === 'TemplateLiteral'
    )) return

    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const sql = staticStringValue(node)
      if (sql === null) {
        if (containsUpsertSignal(concatenationFragments(node))) {
          errors.push(`${relativePath}:${node.loc.start.line}: dynamic INSERT/ON CONFLICT concatenation`)
        }
        return
      }

      const literalResult = conflictTargetsInLiteral(sql, relativePath, node.loc.start.line)
      callCount += literalResult.callCount
      errors.push(...literalResult.errors)
      targets.push(...literalResult.targets)
      return
    }

    if (node.type === 'TemplateLiteral' && node.expressions.length > 0) {
      if (templateContainsUpsertSignal(node)) {
        errors.push(`${relativePath}:${node.loc.start.line}: dynamic INSERT/ON CONFLICT template`)
      }
      return
    }

    const sql = staticStringValue(node)
    if (sql === null || (!ON_CONFLICT_TEST_PATTERN.test(sql)
      && !LEGACY_CONFLICT_WRITE_TEST_PATTERN.test(sql))) return

    const literalResult = conflictTargetsInLiteral(sql, relativePath, node.loc.start.line)
    callCount += literalResult.callCount
    errors.push(...literalResult.errors)
    targets.push(...literalResult.targets)
  })

  return { callCount, errors, targets }
}

function runtimeConflictTargets() {
  const targets = []
  const errors = []
  let callCount = 0

  for (const filePath of runtimeSourceFiles()) {
    const source = readFileSync(filePath, 'utf8')
    const relativePath = path.relative(SERVER_DIRECTORY, filePath).split(path.sep).join('/')
    const sourceResult = conflictTargetsInSource(source, relativePath)
    callCount += sourceResult.callCount
    errors.push(...sourceResult.errors)
    targets.push(...sourceResult.targets)
  }
  return { callCount, errors, targets }
}

function declaredConflictKeyIds() {
  const ids = new Set()
  for (const [table, columns] of Object.entries(REQUIRED_PRIMARY_KEYS)) {
    ids.add(uniqueKeyId(table, columns))
  }
  for (const [table, keys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    for (const columns of keys) ids.add(uniqueKeyId(table, columns))
  }
  return ids
}

function createContractDatabase({
  missingPrimaryKey = '',
  missingUniqueKey = '',
} = {}) {
  const db = new Database(':memory:')
  const columnsByTable = new Map()
  const addColumns = (table, columns) => {
    const existing = columnsByTable.get(table) || new Set()
    for (const column of columns) existing.add(column)
    columnsByTable.set(table, existing)
  }

  for (const [table, columns] of Object.entries(REQUIRED_PRIMARY_KEYS)) {
    addColumns(table, columns)
  }
  for (const [table, keys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    for (const columns of keys) addColumns(table, columns)
  }

  for (const [table, columns] of [...columnsByTable].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const definitions = [...columns].map((column) => `${quoteIdentifier(column)} TEXT NOT NULL`)
    definitions.push(`${quoteIdentifier('contract_extra')} TEXT`)

    const primaryKey = REQUIRED_PRIMARY_KEYS[table]
    if (primaryKey && table !== missingPrimaryKey) {
      definitions.push(`PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(', ')})`)
    }
    for (const uniqueKey of REQUIRED_UNIQUE_KEYS[table] || []) {
      if (uniqueKeyId(table, uniqueKey) === missingUniqueKey) continue
      definitions.push(`UNIQUE (${uniqueKey.map(quoteIdentifier).join(', ')})`)
    }
    db.exec(`CREATE TABLE ${quoteIdentifier(table)} (${definitions.join(', ')})`)
  }
  return db
}

test('the synthetic runtime UPSERT key contract is internally complete', () => {
  const db = createContractDatabase()
  try {
    assert.deepEqual(collectMissingRequiredKeyConstraints(db), [])
  } finally {
    db.close()
  }
})

test('the runtime UPSERT scanner fails closed on ambiguous or dynamic SQL', () => {
  const crossLiteral = conflictTargetsInSource(`
    const insert = 'INSERT INTO users (id) VALUES (?)'
    const conflict = 'ON CONFLICT(id) DO NOTHING'
  `, 'cross-literal.js')
  assert.equal(crossLiteral.callCount, 1)
  assert.equal(crossLiteral.targets.length, 0)
  assert.equal(crossLiteral.errors.length, 1)

  const dynamicClause = conflictTargetsInSource(
    'const sql = `INSERT INTO users (id) VALUES (?) ${conflictClause}`',
    'dynamic-clause.js',
  )
  assert.equal(dynamicClause.callCount, 0)
  assert.equal(dynamicClause.targets.length, 0)
  assert.equal(dynamicClause.errors.length, 1)

  const insertOrReplace = conflictTargetsInSource(`
    const sql = 'INSERT OR REPLACE INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING'
  `, 'insert-or-replace.js')
  assert.equal(insertOrReplace.callCount, 1)
  assert.equal(insertOrReplace.targets.length, 0)
  assert.equal(insertOrReplace.errors.length, 1)

  for (const algorithm of ['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE']) {
    const legacyInsert = conflictTargetsInSource(`
      const sql = 'INSERT OR ${algorithm} INTO users (id) VALUES (?)'
    `, `insert-or-${algorithm.toLowerCase()}.js`)
    assert.equal(legacyInsert.callCount, 0, algorithm)
    assert.equal(legacyInsert.targets.length, 0, algorithm)
    assert.equal(legacyInsert.errors.length, 1, algorithm)
  }

  const replaceInto = conflictTargetsInSource(`
    const sql = 'REPLACE INTO users (id) VALUES (?)'
  `, 'replace-into.js')
  assert.equal(replaceInto.callCount, 0)
  assert.equal(replaceInto.targets.length, 0)
  assert.equal(replaceInto.errors.length, 1)

  const unsupportedInsert = conflictTargetsInSource(`
    const sql = 'INSERT INTO users (id) VALUES (?); INSERT INTO "accounts" (id) VALUES (?) ON CONFLICT(id) DO NOTHING'
  `, 'unsupported-insert.js')
  assert.equal(unsupportedInsert.callCount, 1)
  assert.equal(unsupportedInsert.targets.length, 0)
  assert.equal(unsupportedInsert.errors.length, 1)

  const targetlessConflict = conflictTargetsInSource(`
    const sql = 'INSERT INTO users (id) VALUES (?) ON CONFLICT DO NOTHING'
  `, 'targetless-conflict.js')
  assert.equal(targetlessConflict.callCount, 1)
  assert.equal(targetlessConflict.targets.length, 0)
  assert.equal(targetlessConflict.errors.length, 1)

  const staticConcatenation = conflictTargetsInSource(`
    const sql = 'INSERT INTO users (id) VALUES (?) ON ' + 'CONFLICT(id) DO NOTHING'
  `, 'static-concatenation.js')
  assert.deepEqual(staticConcatenation, {
    callCount: 1,
    errors: [],
    targets: [{ table: 'users', columns: ['id'], file: 'static-concatenation.js' }],
  })

  const dynamicConcatenation = conflictTargetsInSource(`
    const sql = 'INSERT INTO users (id) VALUES (?) ' + conflictClause
  `, 'dynamic-concatenation.js')
  assert.equal(dynamicConcatenation.callCount, 0)
  assert.equal(dynamicConcatenation.targets.length, 0)
  assert.equal(dynamicConcatenation.errors.length, 1)
})

test('every runtime ON CONFLICT target is declared by the schema contract', () => {
  const { callCount, errors, targets } = runtimeConflictTargets()
  assert.deepEqual(errors, [], 'every runtime ON CONFLICT target must be statically discoverable')
  assert.equal(callCount, EXPECTED_RUNTIME_ON_CONFLICT_CALLS)
  assert.equal(targets.length, EXPECTED_RUNTIME_ON_CONFLICT_CALLS)

  const targetIds = [...new Set(targets.map(({ table, columns }) => (
    uniqueKeyId(table, columns)
  )))].sort()
  assert.equal(targetIds.length, EXPECTED_RUNTIME_ON_CONFLICT_TARGETS)

  const declaredIds = declaredConflictKeyIds()
  assert.deepEqual(
    [...REQUIRED_NON_RUNTIME_KEY_IDS].filter((targetId) => !declaredIds.has(targetId)),
    [],
    'non-runtime schema constraints must remain registered in dbSchemaContract.js',
  )
  assert.deepEqual(
    targetIds,
    [...declaredIds].filter((targetId) => (
      !REQUIRED_NON_RUNTIME_KEY_IDS.has(targetId)
    )).sort(),
    'runtime UPSERT conflict keys must exactly match dbSchemaContract.js',
  )
})

test('every required primary key is independently enforced with exact column order', () => {
  for (const [table, columns] of Object.entries(REQUIRED_PRIMARY_KEYS)) {
    const db = createContractDatabase({ missingPrimaryKey: table })
    try {
      if (columns.length > 1) {
        db.exec(`
          CREATE UNIQUE INDEX ${quoteIdentifier(`wrong_order_${table}`)}
          ON ${quoteIdentifier(table)} (${[...columns].reverse().map(quoteIdentifier).join(', ')})
        `)
      }
      assert.deepEqual(
        collectMissingRequiredKeyConstraints(db),
        [`primary-key:${table}`],
        table,
      )
    } finally {
      db.close()
    }
  }
})

test('every required UNIQUE key rejects partial and superset substitutes', () => {
  for (const [table, keys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    for (const columns of keys) {
      const keyId = uniqueKeyId(table, columns)
      const db = createContractDatabase({ missingUniqueKey: keyId })
      try {
        db.exec(`
          CREATE UNIQUE INDEX ${quoteIdentifier(`superset_${table}`)}
          ON ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}, contract_extra);
          CREATE UNIQUE INDEX ${quoteIdentifier(`partial_${table}`)}
          ON ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')})
          WHERE contract_extra IS NOT NULL;
        `)
        assert.deepEqual(
          collectMissingRequiredKeyConstraints(db),
          [`unique-key:${keyId}`],
          keyId,
        )
      } finally {
        db.close()
      }
    }
  }
})
