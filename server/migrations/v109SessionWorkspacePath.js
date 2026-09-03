import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'

const VERSION = 109
const REQUIRED_SESSION_COLUMNS = Object.freeze([
  'token',
  'id',
  'user_id',
  'title',
  'expires_at',
  'created_at',
  'updated_at',
  'last_viewed_at',
  'archived_at',
  'revision',
  'pinned_at',
  'parent_session_id',
  'branch_label',
  'forked_at',
])

function invalidSchema(missing) {
  throw databaseSchemaIncompleteError({
    expectedVersion: VERSION,
    stage: 'migration-v109',
    missing,
  })
}

function sessionColumns(db) {
  return db.prepare('SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?)')
    .all('sessions')
}

function assertWorkspaceColumnShape(column) {
  const missing = []
  if (String(column?.type || '').trim().toUpperCase() !== 'TEXT') {
    missing.push('column-type:sessions.workspace_path')
  }
  if (Number(column?.not_null) !== 0) {
    missing.push('column-nullability:sessions.workspace_path')
  }
  if (Number(column?.pk) !== 0) {
    missing.push('column-primary-key:sessions.workspace_path')
  }
  if (missing.length) invalidSchema(missing)
}

/** Persist the selected local workspace beside durable chat-session metadata. */
export function migrateToV109(db) {
  const columns = sessionColumns(db)
  if (!columns.length) invalidSchema(['table:sessions'])
  const names = new Set(columns.map((column) => column.name))
  const missing = REQUIRED_SESSION_COLUMNS
    .filter((column) => !names.has(column))
    .map((column) => `column:sessions.${column}`)
  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name)
  if (primaryKey.length !== 1 || primaryKey[0] !== 'token') {
    missing.push('primary-key:sessions')
  }
  if (missing.length) invalidSchema(missing)

  const existing = columns.find((column) => column.name === 'workspace_path')
  if (existing) {
    assertWorkspaceColumnShape(existing)
  } else {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_path TEXT')
    assertWorkspaceColumnShape(sessionColumns(db).find((column) => column.name === 'workspace_path'))
  }
}
