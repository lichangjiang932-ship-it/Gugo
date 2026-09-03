import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-db-schema-preflight-'))
const originalDataDir = process.env.APP_DATA_DIR
const originalDbPath = process.env.APP_DB_PATH

const {
  DB_SCHEMA_VERSION,
  closeDb,
  getDb,
  getSchemaVersion,
} = await import('../server/db.js')

function selectDatabase(filePath) {
  closeDb()
  process.env.APP_DATA_DIR = path.dirname(filePath)
  process.env.APP_DB_PATH = filePath
}

function seedVersionDatabase(filePath, value, { includeVersion = true } = {}) {
  const db = new Database(filePath)
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE preflight_sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO preflight_sentinel (id, value) VALUES ('sentinel', 'preserve-me');
  `)
  if (includeVersion) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(value))
  }
  db.close()
}

function databaseSnapshot(filePath) {
  const db = new Database(filePath, { readonly: true })
  try {
    return {
      pragmas: {
        applicationId: db.pragma('application_id', { simple: true }),
        journalMode: db.pragma('journal_mode', { simple: true }),
        schemaVersion: db.pragma('schema_version', { simple: true }),
        userVersion: db.pragma('user_version', { simple: true }),
      },
      schema: db.prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all(),
      meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
      sentinel: db.prepare('SELECT id, value FROM preflight_sentinel ORDER BY id').all(),
    }
  } finally {
    db.close()
  }
}

function databaseFileSnapshot(filePath) {
  const stat = fs.statSync(filePath, { bigint: true })
  return {
    bytes: fs.readFileSync(filePath),
    mtimeNs: stat.mtimeNs,
    size: stat.size,
    shmExists: fs.existsSync(`${filePath}-shm`),
    walExists: fs.existsSync(`${filePath}-wal`),
  }
}

function initializeCurrentDatabase(filePath) {
  selectDatabase(filePath)
  const db = getDb()
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  closeDb()
  return db
}

function schemaSnapshot(filePath) {
  const db = new Database(filePath, { readonly: true })
  try {
    return db.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all()
  } finally {
    db.close()
  }
}

function tableSchemaSql(db, table) {
  const sql = db.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table)?.sql
  assert.ok(sql, `${table} schema must exist`)
  return sql
}

function explicitIndexSql(db, tables) {
  return db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'index' AND tbl_name IN (${tables.map(() => '?').join(', ')})
      AND sql IS NOT NULL
    ORDER BY name
  `).all(...tables).map((row) => row.sql)
}

const V113_OUTBOX_CHECK_MUTATIONS = Object.freeze([
  {
    label: 'cursor',
    pattern: /cursor INTEGER PRIMARY KEY AUTOINCREMENT CHECK \(\s*typeof\(cursor\) = 'integer' AND cursor > 0\s*\)/u,
    replacement: 'cursor INTEGER PRIMARY KEY AUTOINCREMENT',
  },
  {
    label: 'event-id',
    pattern: /event_id TEXT NOT NULL UNIQUE CHECK \(length\(event_id\) BETWEEN 1 AND 512\)/u,
    replacement: 'event_id TEXT NOT NULL UNIQUE',
  },
  {
    label: 'event-type',
    pattern: /event_type TEXT NOT NULL CHECK \(length\(event_type\) BETWEEN 1 AND 128\)/u,
    replacement: 'event_type TEXT NOT NULL',
  },
  {
    label: 'envelope-json',
    pattern: /envelope_json TEXT NOT NULL CHECK \(\s*json_valid\(envelope_json\) AND json_type\(envelope_json\) = 'object'\s*\)/u,
    replacement: 'envelope_json TEXT NOT NULL',
  },
  {
    label: 'event-fingerprint',
    pattern: /event_fingerprint TEXT NOT NULL CHECK \(\s*length\(event_fingerprint\) = 64\s*AND event_fingerprint NOT GLOB '\*\[\^0-9a-f\]\*'\s*\)/u,
    replacement: 'event_fingerprint TEXT NOT NULL',
  },
  {
    label: 'created-at',
    pattern: /created_at INTEGER NOT NULL CHECK \(\s*typeof\(created_at\) = 'integer' AND created_at >= 0\s*\)/u,
    replacement: 'created_at INTEGER NOT NULL',
  },
])

const V113_STREAM_CHECK_MUTATIONS = Object.freeze([
  {
    label: 'stream-key',
    pattern: /stream_key TEXT PRIMARY KEY NOT NULL CHECK \(stream_key = 'global'\)/u,
    replacement: 'stream_key TEXT PRIMARY KEY NOT NULL',
  },
  {
    label: 'epoch',
    pattern: /epoch INTEGER NOT NULL CHECK \(\s*typeof\(epoch\) = 'integer' AND epoch >= 1\s*\)/u,
    replacement: 'epoch INTEGER NOT NULL',
  },
  {
    label: 'truncated-through',
    pattern: /truncated_through INTEGER NOT NULL CHECK \(\s*typeof\(truncated_through\) = 'integer' AND truncated_through >= 0\s*\)/u,
    replacement: 'truncated_through INTEGER NOT NULL',
  },
  {
    label: 'without-rowid',
    pattern: /\)\s+WITHOUT ROWID\s*$/u,
    replacement: ')',
  },
])

function rebuildV113Table(db, table, { pattern, replacement }) {
  const sourceSql = tableSchemaSql(db, table)
  const indexes = explicitIndexSql(db, [table])
  const weakened = sourceSql.replace(pattern, replacement)
  assert.notEqual(weakened, sourceSql)
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    db.exec(`DROP TABLE ${table}`)
    db.exec(weakened)
    for (const sql of indexes) db.exec(sql)
    if (table === 'agent_event_stream_metadata') {
      db.exec(`
        INSERT INTO agent_event_stream_metadata (
          stream_key, epoch, truncated_through
        ) VALUES ('global', 1, 0)
      `)
    }
  }).immediate()
}

const V114_SUBSCRIPTION_CHECK_MUTATIONS = Object.freeze([
  {
    label: 'publisher-id',
    pattern: /publisher_id TEXT NOT NULL CHECK \(length\(publisher_id\) BETWEEN 1 AND 128\)/u,
    replacement: 'publisher_id TEXT NOT NULL',
  },
  {
    label: 'publisher-key-id',
    pattern: /publisher_key_id TEXT NOT NULL CHECK \(length\(publisher_key_id\) BETWEEN 1 AND 256\)/u,
    replacement: 'publisher_key_id TEXT NOT NULL',
  },
  {
    label: 'release-id',
    pattern: /release_id TEXT NOT NULL CHECK \(length\(release_id\) BETWEEN 1 AND 128\)/u,
    replacement: 'release_id TEXT NOT NULL',
  },
  {
    label: 'release-digest-version',
    pattern: /release_digest_version INTEGER NOT NULL CHECK \(\s*typeof\(release_digest_version\) = 'integer' AND release_digest_version >= 1\s*\)/u,
    replacement: 'release_digest_version INTEGER NOT NULL',
  },
  {
    label: 'plugin-id',
    pattern: /plugin_id TEXT NOT NULL CHECK \(length\(plugin_id\) BETWEEN 1 AND 80\)/u,
    replacement: 'plugin_id TEXT NOT NULL',
  },
  {
    label: 'plugin-version',
    pattern: /plugin_version TEXT NOT NULL CHECK \(length\(plugin_version\) BETWEEN 1 AND 128\)/u,
    replacement: 'plugin_version TEXT NOT NULL',
  },
  {
    label: 'subscription-id',
    pattern: /subscription_id TEXT NOT NULL CHECK \(length\(subscription_id\) BETWEEN 1 AND 128\)/u,
    replacement: 'subscription_id TEXT NOT NULL',
  },
  {
    label: 'retry-attempts',
    pattern: /retry_attempts INTEGER NOT NULL CHECK \(\s*typeof\(retry_attempts\) = 'integer' AND retry_attempts >= 0\s*\)/u,
    replacement: 'retry_attempts INTEGER NOT NULL',
  },
  {
    label: 'created-at',
    pattern: /created_at INTEGER NOT NULL CHECK \(\s*typeof\(created_at\) = 'integer' AND created_at >= 0\s*\)/u,
    replacement: 'created_at INTEGER NOT NULL',
  },
  {
    label: 'updated-at',
    pattern: /updated_at INTEGER NOT NULL CHECK \(\s*typeof\(updated_at\) = 'integer' AND updated_at >= created_at\s*\)/u,
    replacement: 'updated_at INTEGER NOT NULL',
  },
])

function weakenSubscriptionCheck(db, { pattern, replacement }) {
  const subscriptionSql = tableSchemaSql(db, 'agent_event_subscriptions')
  const dlqSql = tableSchemaSql(db, 'agent_event_subscription_dlq')
  const indexes = explicitIndexSql(db, [
    'agent_event_subscriptions',
    'agent_event_subscription_dlq',
  ])
  const weakened = subscriptionSql.replace(pattern, replacement)
  assert.notEqual(weakened, subscriptionSql)
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    db.exec('DROP TABLE agent_event_subscription_dlq')
    db.exec('DROP TABLE agent_event_subscriptions')
    db.exec(weakened)
    db.exec(dlqSql)
    for (const sql of indexes) db.exec(sql)
  }).immediate()
}

function weakenDlqAutoincrement(db) {
  const dlqSql = tableSchemaSql(db, 'agent_event_subscription_dlq')
  const indexes = explicitIndexSql(db, ['agent_event_subscription_dlq'])
  const weakened = dlqSql.replace(
    /INTEGER PRIMARY KEY AUTOINCREMENT/u,
    'INTEGER PRIMARY KEY',
  )
  assert.notEqual(weakened, dlqSql)
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    db.exec('DROP TABLE agent_event_subscription_dlq')
    db.exec(weakened)
    for (const sql of indexes) db.exec(sql)
  }).immediate()
}

function rebuildSessionsWithoutPrimaryKey(db) {
  const tableSql = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'sessions'
  `).get()?.sql
  assert.ok(tableSql, 'sessions table DDL must exist')
  const replacementSql = tableSql
    .replace(/^CREATE TABLE\s+sessions\b/u, 'CREATE TABLE sessions_without_primary_key')
    .replace(/\btoken\s+TEXT\s+PRIMARY KEY\b/u, 'token TEXT NOT NULL')
  assert.notEqual(replacementSql, tableSql, 'sessions primary key must be removed')

  const columns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all('sessions')
    .map((row) => `"${String(row.name).replaceAll('"', '""')}"`)
    .join(', ')
  const sessionIndexes = db.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE tbl_name = 'sessions'
      AND type = 'index'
      AND sql IS NOT NULL
    ORDER BY name
  `).all()
  const triggers = db.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND sql IS NOT NULL
    ORDER BY name
  `).all()
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const entry of triggers) {
      const name = `"${String(entry.name).replaceAll('"', '""')}"`
      db.exec(`DROP TRIGGER ${name}`)
    }
    db.exec(replacementSql)
    db.exec(`
      INSERT INTO sessions_without_primary_key (${columns})
      SELECT ${columns} FROM sessions
    `)
    db.exec('DROP TABLE sessions')
    db.exec('ALTER TABLE sessions_without_primary_key RENAME TO sessions')
    for (const entry of sessionIndexes) db.exec(entry.sql)
    for (const entry of triggers) db.exec(entry.sql)
  }).immediate()

  assert.deepEqual(
    db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
      .all('sessions'),
    [],
  )
}

test.afterEach(() => {
  closeDb()
})

test.after(() => {
  closeDb()
  if (originalDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = originalDataDir
  if (originalDbPath === undefined) delete process.env.APP_DB_PATH
  else process.env.APP_DB_PATH = originalDbPath
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('existing databases fail closed on future or invalid schema versions without mutation', () => {
  const cases = [
    { label: 'future', value: DB_SCHEMA_VERSION + 1, code: 'DB_SCHEMA_VERSION_UNSUPPORTED' },
    { label: 'negative', value: -1, code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'fractional', value: 1.5, code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'nan', value: 'not-a-version', code: 'DB_SCHEMA_VERSION_INVALID' },
    { label: 'infinity', value: 'Infinity', code: 'DB_SCHEMA_VERSION_INVALID' },
  ]

  for (const entry of cases) {
    const filePath = path.join(tempDir, `${entry.label}.db`)
    seedVersionDatabase(filePath, entry.value)
    const before = databaseSnapshot(filePath)
    const fileBefore = databaseFileSnapshot(filePath)
    selectDatabase(filePath)

    assert.throws(() => getDb(), (error) => error?.code === entry.code)
    assert.throws(() => getDb(), (error) => error?.code === entry.code)
    assert.deepEqual(databaseSnapshot(filePath), before)
    assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
  }
})

test('an existing meta table without schema_version fails closed without mutation', () => {
  const filePath = path.join(tempDir, 'missing-version.db')
  seedVersionDatabase(filePath, null, { includeVersion: false })
  const before = databaseSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(() => getDb(), (error) => error?.code === 'DB_SCHEMA_VERSION_INVALID')
  assert.deepEqual(databaseSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a database claiming the current version fails closed on an incomplete schema without mutation', () => {
  const filePath = path.join(tempDir, 'spoofed-current-version.db')
  seedVersionDatabase(filePath, DB_SCHEMA_VERSION)
  const before = databaseSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.retryable === false
      && error?.details?.stage === 'preflight'
      && error?.details?.missing?.includes('table:users'),
  )
  assert.deepEqual(databaseSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a non-empty database without meta fails closed before a legacy migration can delete data', () => {
  const noMetaPath = path.join(tempDir, 'no-meta.db')
  const seed = new Database(noMetaPath)
  seed.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO jobs (id, title) VALUES ('preserve-job', 'must survive preflight');
  `)
  seed.close()
  const fileBefore = databaseFileSnapshot(noMetaPath)

  selectDatabase(noMetaPath)
  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.details?.missing?.includes('table:meta'),
  )
  assert.deepEqual(databaseFileSnapshot(noMetaPath), fileBefore)
  const verify = new Database(noMetaPath, { readonly: true })
  try {
    assert.deepEqual(verify.prepare('SELECT id, title FROM jobs').all(), [
      { id: 'preserve-job', title: 'must survive preflight' },
    ])
  } finally {
    verify.close()
  }
})

test('a new empty database still initializes normally', () => {
  const emptyPath = path.join(tempDir, 'empty.db')
  selectDatabase(emptyPath)
  const empty = getDb()
  assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION)
  assert.ok(empty.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get())
})

test('current-version databases with a missing critical column, index, or autoincrement key fail closed without mutation', () => {
  const cases = [
    {
      label: 'missing-column',
      mutate(db) {
        db.exec(`
          DROP INDEX idx_memories_user_agent;
          ALTER TABLE memories DROP COLUMN agent_id;
        `)
      },
      expectedMissing: 'column:memories.agent_id',
    },
    {
      label: 'missing-index',
      mutate(db) {
        db.exec('DROP INDEX idx_turn_artifacts_turn')
      },
      expectedMissing: 'index:idx_turn_artifacts_turn',
    },
    {
      label: 'missing-agent-event-autoincrement',
      mutate(db) {
        db.exec(`
          DROP TABLE agent_event_outbox;
          CREATE TABLE agent_event_outbox (
            cursor INTEGER PRIMARY KEY CHECK (
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
          CREATE INDEX idx_agent_event_outbox_user_cursor
            ON agent_event_outbox(user_id, cursor);
          CREATE INDEX idx_agent_event_outbox_type_cursor
            ON agent_event_outbox(event_type, cursor);
        `)
      },
      expectedMissing: 'autoincrement-primary-key:agent_event_outbox.cursor',
    },
    ...V113_OUTBOX_CHECK_MUTATIONS.map((mutation) => ({
      label: `missing-agent-event-outbox-${mutation.label}-check`,
      mutate(db) {
        rebuildV113Table(db, 'agent_event_outbox', mutation)
      },
      expectedMissing: 'constraints:agent_event_outbox',
    })),
    ...V113_STREAM_CHECK_MUTATIONS.map((mutation) => ({
      label: `missing-agent-event-stream-${mutation.label}-constraint`,
      mutate(db) {
        rebuildV113Table(db, 'agent_event_stream_metadata', mutation)
      },
      expectedMissing: 'constraints:agent_event_stream_metadata',
    })),
    {
      label: 'invalid-agent-event-stream-table-shape',
      mutate(db) {
        rebuildV113Table(db, 'agent_event_stream_metadata', {
          pattern: /epoch INTEGER NOT NULL/u,
          replacement: 'epoch BLOB NOT NULL',
        })
      },
      expectedMissing: 'table-shape:agent_event_stream_metadata',
    },
    {
      label: 'non-singleton-agent-event-stream-metadata',
      mutate(db) {
        db.pragma('ignore_check_constraints = ON')
        db.prepare(`
          INSERT INTO agent_event_stream_metadata (
            stream_key, epoch, truncated_through
          ) VALUES ('unexpected', 1, 0)
        `).run()
      },
      expectedMissing: 'singleton:agent_event_stream_metadata.global',
    },
    {
      label: 'missing-subscription-contract-check',
      mutate(db) {
        weakenSubscriptionCheck(db, {
          pattern: /contract_version INTEGER NOT NULL CHECK \(\s*typeof\(contract_version\) = 'integer' AND contract_version = 2\s*\)/u,
          replacement: 'contract_version INTEGER NOT NULL',
        })
      },
      expectedMissing: 'constraints:agent_event_subscriptions',
    },
    ...V114_SUBSCRIPTION_CHECK_MUTATIONS.map((mutation) => ({
      label: `missing-subscription-${mutation.label}-check`,
      mutate(db) {
        weakenSubscriptionCheck(db, mutation)
      },
      expectedMissing: 'constraints:agent_event_subscriptions',
    })),
    {
      label: 'missing-subscription-index',
      mutate(db) {
        db.exec('DROP INDEX idx_agent_event_subscriptions_lease')
      },
      expectedMissing: 'index:idx_agent_event_subscriptions_lease',
    },
    {
      label: 'missing-subscription-dlq-autoincrement',
      mutate(db) {
        weakenDlqAutoincrement(db)
      },
      expectedMissing: 'autoincrement-primary-key:agent_event_subscription_dlq.dlq_id',
    },
  ]

  for (const entry of cases) {
    const filePath = path.join(tempDir, `${entry.label}.db`)
    initializeCurrentDatabase(filePath)
    const mutate = new Database(filePath)
    try {
      entry.mutate(mutate)
    } finally {
      mutate.close()
    }
    const before = schemaSnapshot(filePath)
    const fileBefore = databaseFileSnapshot(filePath)
    selectDatabase(filePath)

    assert.throws(
      () => getDb(),
      (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
        && error?.details?.stage === 'preflight'
        && error?.details?.missing?.includes(entry.expectedMissing),
      entry.label,
    )
    assert.deepEqual(schemaSnapshot(filePath), before)
    assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
  }
})

test('a current v108 database missing the tool-permission conflict key fails preflight without mutation', () => {
  const filePath = path.join(tempDir, 'missing-tool-permission-primary-key.db')
  initializeCurrentDatabase(filePath)
  const mutate = new Database(filePath)
  try {
    mutate.exec(`
      DROP TABLE user_tool_permissions;
      CREATE TABLE user_tool_permissions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_user_tool_permissions_user
        ON user_tool_permissions(user_id);
    `)
    assert.deepEqual(
      mutate.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
        .all('user_tool_permissions'),
      [],
    )
    assert.ok(mutate.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('user_tool_permissions')
      .some((row) => row.from === 'user_id'
        && row.table === 'users'
        && row.to === 'id'
        && row.on_delete === 'CASCADE'))
  } finally {
    mutate.close()
  }
  const before = schemaSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.details?.stage === 'preflight'
      && error?.details?.missing?.includes('primary-key:user_tool_permissions'),
  )
  assert.deepEqual(schemaSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a current v108 database missing the session identity key fails preflight without mutation', () => {
  const filePath = path.join(tempDir, 'missing-session-primary-key.db')
  initializeCurrentDatabase(filePath)
  const mutate = new Database(filePath)
  try {
    mutate.prepare(`
      INSERT INTO users (id, email, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('session-owner', 'session-owner@example.test', 1, 1)
    mutate.prepare(`
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run('preserved-session', 'session-owner', 2, 1)
    rebuildSessionsWithoutPrimaryKey(mutate)
    assert.deepEqual(
      mutate.prepare('SELECT token, user_id FROM sessions ORDER BY token').all(),
      [{ token: 'preserved-session', user_id: 'session-owner' }],
    )
  } finally {
    mutate.close()
  }
  const before = schemaSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.details?.stage === 'preflight'
      && error?.details?.missing?.includes('primary-key:sessions'),
  )
  assert.deepEqual(schemaSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a current v108 database missing the user identity key fails preflight without mutation', () => {
  const filePath = path.join(tempDir, 'missing-user-primary-key.db')
  initializeCurrentDatabase(filePath)
  const mutate = new Database(filePath)
  try {
    mutate.pragma('foreign_keys = OFF')
    mutate.exec(`
      CREATE TABLE users_without_primary_key (
        id TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        password_hash TEXT,
        password_salt TEXT,
        password_set_at INTEGER
      );
      INSERT INTO users_without_primary_key SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_without_primary_key RENAME TO users;
    `)
    assert.deepEqual(
      mutate.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
        .all('users'),
      [],
    )
    assert.ok(mutate.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('effort_settings')
      .some((row) => row.from === 'user_id'
        && row.table === 'users'
        && row.to === 'id'
        && row.on_delete === 'CASCADE'))
  } finally {
    mutate.close()
  }
  const before = schemaSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.details?.stage === 'preflight'
      && error?.details?.missing?.includes('primary-key:users'),
  )
  assert.deepEqual(schemaSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('a current v108 database missing complete user email uniqueness fails preflight without mutation', () => {
  const filePath = path.join(tempDir, 'missing-user-email-unique-key.db')
  initializeCurrentDatabase(filePath)
  const mutate = new Database(filePath)
  try {
    mutate.pragma('foreign_keys = OFF')
    mutate.exec(`
      CREATE TABLE users_without_email_unique (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        password_hash TEXT,
        password_salt TEXT,
        password_set_at INTEGER
      );
      INSERT INTO users_without_email_unique SELECT * FROM users;
      INSERT INTO users_without_email_unique (id, email, created_at, updated_at)
        VALUES ('duplicate-email-a', 'shared@example.test', 1, 1);
      INSERT INTO users_without_email_unique (id, email, created_at, updated_at)
        VALUES ('duplicate-email-b', 'shared@example.test', 2, 2);
      DROP TABLE users;
      ALTER TABLE users_without_email_unique RENAME TO users;
      CREATE UNIQUE INDEX idx_users_email_with_id ON users(email, id);
      CREATE UNIQUE INDEX idx_users_email_partial
        ON users(email) WHERE id = 'duplicate-email-a';
    `)
    const uniqueIndexes = mutate.prepare(`
      SELECT name, "unique" AS is_unique, partial
      FROM pragma_index_list(?)
    `).all('users')
    const hasCompleteUniqueEmail = uniqueIndexes.some((index) => {
      if (Number(index.is_unique) !== 1 || Number(index.partial) !== 0) return false
      const columns = mutate.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name)
        .map((row) => row.name)
      return columns.length === 1 && columns[0] === 'email'
    })
    assert.equal(hasCompleteUniqueEmail, false)
    assert.equal(
      mutate.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?')
        .get('shared@example.test').count,
      2,
    )
  } finally {
    mutate.close()
  }
  const before = schemaSnapshot(filePath)
  const fileBefore = databaseFileSnapshot(filePath)
  selectDatabase(filePath)

  assert.throws(
    () => getDb(),
    (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
      && error?.details?.stage === 'preflight'
      && error?.details?.missing?.includes('unique-key:users.email'),
  )
  assert.deepEqual(schemaSnapshot(filePath), before)
  assert.deepEqual(databaseFileSnapshot(filePath), fileBefore)
})

test('fresh and v5→v6, v27→v28, and v29→v30 fixtures converge idempotently with valid integrity and foreign keys', () => {
  const cases = [
    {
      label: 'v5-to-v6',
      version: 5,
      mutate(db) {
        db.exec(`
          DROP INDEX idx_memories_user_agent;
          ALTER TABLE memories DROP COLUMN agent_id;
        `)
      },
      verify(db) {
        assert.ok(db.prepare('SELECT name FROM pragma_table_info(?) WHERE name = ?')
          .get('memories', 'agent_id'))
        assert.deepEqual(
          db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
            .all('idx_memories_user_agent')
            .map((row) => row.name),
          ['user_id', 'agent_id', 'pinned', 'last_used_at'],
        )
        assert.ok(db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('memories')
          .some((row) => row.from === 'agent_id'
            && row.table === 'agents'
            && row.to === 'id'
            && row.on_delete === 'SET NULL'))
      },
    },
    {
      label: 'v27-to-v28',
      version: 27,
      mutate(db) {
        for (const column of [
          'kind',
          'context_window',
          'supports_tools',
          'supports_streaming',
          'supports_vision',
          'first_token_timeout_ms',
          'idle_timeout_ms',
          'failover_enabled',
          'keep_alive',
        ]) {
          db.exec(`ALTER TABLE model_providers DROP COLUMN ${column}`)
        }
      },
      verify(db) {
        const columns = new Map(db.prepare('SELECT name, "notnull" AS isNotNull FROM pragma_table_info(?)')
          .all('model_providers')
          .map((row) => [row.name, row]))
        for (const column of [
          'kind',
          'context_window',
          'supports_tools',
          'supports_streaming',
          'supports_vision',
          'first_token_timeout_ms',
          'idle_timeout_ms',
          'failover_enabled',
          'keep_alive',
        ]) {
          assert.equal(columns.get(column)?.isNotNull, 0, column)
        }
      },
    },
    {
      label: 'v29-to-v30',
      version: 29,
      mutate(db) {
        db.exec('DROP TABLE turn_artifacts')
      },
      verify(db) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turn_artifacts'").get())
        assert.deepEqual(
          db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
            .all('idx_turn_artifacts_turn')
            .map((row) => row.name),
          ['user_id', 'session_id', 'turn_id', 'created_at'],
        )
        const filenameIndex = db.prepare(`
          SELECT "unique" AS isUnique, partial
          FROM pragma_index_list(?) WHERE name = 'idx_turn_artifacts_filename'
        `).get('turn_artifacts')
        assert.deepEqual(filenameIndex, { isUnique: 1, partial: 0 })
      },
    },
  ]

  const freshPath = path.join(tempDir, 'fresh-integrity.db')
  initializeCurrentDatabase(freshPath)
  const fresh = new Database(freshPath, { readonly: true })
  try {
    assert.deepEqual(fresh.pragma('foreign_key_check'), [])
    assert.deepEqual(fresh.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  } finally {
    fresh.close()
  }

  for (const entry of cases) {
    const filePath = path.join(tempDir, `${entry.label}-transition.db`)
    initializeCurrentDatabase(filePath)
    const fixture = new Database(filePath)
    try {
      fixture.pragma('foreign_keys = OFF')
      entry.mutate(fixture)
      // The fixture starts from the current schema only to reuse its legacy
      // tables. Remove post-target Agent Event tables before lowering the
      // version so v113-v115 replay against the historical shape they own.
      fixture.exec(`
        DROP TABLE agent_event_subscription_dlq;
        DROP TABLE agent_event_subscriptions;
        DROP TABLE agent_event_stream_metadata;
        DROP TABLE agent_event_outbox;
      `)
      fixture.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
        .run(String(entry.version))
    } finally {
      fixture.close()
    }

    selectDatabase(filePath)
    const migrated = getDb()
    assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION, entry.label)
    entry.verify(migrated)
    assert.deepEqual(migrated.pragma('foreign_key_check'), [], entry.label)
    assert.deepEqual(migrated.pragma('integrity_check'), [{ integrity_check: 'ok' }], entry.label)
    closeDb()
    const migratedSchema = schemaSnapshot(filePath)

    selectDatabase(filePath)
    const reopened = getDb()
    assert.equal(getSchemaVersion(), DB_SCHEMA_VERSION, `${entry.label} reopen`)
    assert.deepEqual(reopened.pragma('foreign_key_check'), [], `${entry.label} reopen`)
    closeDb()
    assert.deepEqual(schemaSnapshot(filePath), migratedSchema, `${entry.label} idempotence`)
  }
})
