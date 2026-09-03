import {
  collectMissingRequiredKeyConstraints,
  databaseSchemaIncompleteError,
} from '../dbSchemaContract.js'
import { hasColumn } from './index.js'

const VERSION = 108
const REQUIRED_COLUMNS = Object.freeze({
  users: ['id', 'email', 'created_at', 'updated_at', 'password_hash', 'password_salt', 'password_set_at'],
  user_tool_permissions: ['user_id', 'tool_name', 'enabled', 'updated_at'],
  pinned_memories: ['id', 'user_id', 'kind', 'title', 'content', 'tokens', 'enabled', 'created_at', 'updated_at'],
  todos: ['id', 'user_id', 'title', 'status', 'priority', 'project', 'created_at', 'updated_at', 'completed_at'],
  effort_settings: ['user_id', 'effort', 'max_steps', 'reasoning_depth', 'updated_at'],
  session_meters: ['session_id', 'user_id', 'tokens_in', 'tokens_out', 'tokens_cached', 'turns', 'updated_at'],
})
const REQUIRED_INDEXES = Object.freeze({
  idx_user_tool_permissions_user: {
    table: 'user_tool_permissions',
    columns: ['user_id'],
  },
  idx_pinned_memories_user: {
    table: 'pinned_memories',
    columns: ['user_id', 'updated_at'],
  },
  idx_todos_user_status: {
    table: 'todos',
    columns: ['user_id', 'status', 'priority'],
  },
  idx_session_meters_user: {
    table: 'session_meters',
    columns: ['user_id', 'updated_at'],
  },
})
const USER_OWNED_TABLES = Object.freeze([
  'user_tool_permissions',
  'pinned_memories',
  'todos',
  'effort_settings',
  'session_meters',
])

function assertUnifiedBootstrapSchema(db) {
  const missing = []
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set(
      db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name),
    )
    for (const column of columns) {
      if (!actual.has(column)) missing.push(`column:${table}.${column}`)
    }
  }
  missing.push(...collectMissingRequiredKeyConstraints(db, { expectedVersion: VERSION }))
  if (hasColumn(db, 'session_meters', 'cost_credits')) {
    missing.push('retired-column:session_meters.cost_credits')
  }
  for (const [index, expected] of Object.entries(REQUIRED_INDEXES)) {
    const indexRow = db.prepare(
      "SELECT tbl_name AS tableName FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(index)
    const indexMetadata = db.prepare(`
      SELECT name, "unique" AS isUnique, partial
      FROM pragma_index_list(?) WHERE name = ?
    `).get(expected.table, index)
    if (!indexRow || !indexMetadata || indexRow.tableName !== expected.table) {
      missing.push(`index:${index}`)
      continue
    }
    const actual = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      .all(index)
      .map((row) => row.name)
    if (actual.length !== expected.columns.length
      || actual.some((column, position) => column !== expected.columns[position])) {
      missing.push(`index-columns:${index}`)
    }
    if (Number(indexMetadata.isUnique) !== 0) {
      missing.push(`index-unique:${index}`)
    }
    if (Number(indexMetadata.partial) !== 0) {
      missing.push(`index-partial:${index}`)
    }
  }
  for (const table of USER_OWNED_TABLES) {
    const cascade = db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table)
      .some((row) => row.from === 'user_id'
        && row.table === 'users'
        && row.to === 'id'
        && row.on_delete === 'CASCADE')
    if (!cascade) missing.push(`foreign-key:${table}.user_id`)
  }
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'reasonix_schema_version'").get()) {
    missing.push('retired-meta-key:reasonix_schema_version')
  }
  if (missing.length > 0) {
    throw databaseSchemaIncompleteError({
      expectedVersion: VERSION,
      stage: 'migration-v108',
      missing,
    })
  }
}

function ensurePasswordColumns(db) {
  if (!hasColumn(db, 'users', 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT')
  }
  if (!hasColumn(db, 'users', 'password_salt')) {
    db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT')
  }
  if (!hasColumn(db, 'users', 'password_set_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_set_at INTEGER')
  }
}

/** Fold the former out-of-band bootstrap repairs into the primary registry. */
export function migrateToV108(db) {
  ensurePasswordColumns(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tool_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tool_permissions_user
      ON user_tool_permissions(user_id);

    CREATE TABLE IF NOT EXISTS pinned_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'user',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_memories_user
      ON pinned_memories(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      project TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_todos_user_status
      ON todos(user_id, status, priority DESC);

    CREATE TABLE IF NOT EXISTS effort_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      effort TEXT NOT NULL DEFAULT 'medium',
      max_steps INTEGER NOT NULL DEFAULT 12,
      reasoning_depth INTEGER NOT NULL DEFAULT 2,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_meters (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_cached INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_meters_user
      ON session_meters(user_id, updated_at DESC);
  `)
  if (hasColumn(db, 'session_meters', 'cost_credits')) {
    db.exec('ALTER TABLE session_meters DROP COLUMN cost_credits')
  }
  db.prepare("DELETE FROM meta WHERE key = 'reasonix_schema_version'").run()
  assertUnifiedBootstrapSchema(db)
}
