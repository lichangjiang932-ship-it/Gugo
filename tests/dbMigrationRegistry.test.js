import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { DB_SCHEMA_VERSION } from '../server/db.js'
import {
  LATEST_SCHEMA_VERSION,
  createSchemaMigrationPlan,
  runSchemaMigrations,
  schemaMigrations,
} from '../server/migrations/index.js'
import { migrateToV49 } from '../server/migrations/v49HookArgumentMatcher.js'

test('schema migration registry is contiguous and owns the latest version', () => {
  const legacy = Array.from({ length: 29 }, (_, index) => ({
    version: index + 2,
    up() {},
  }))
  const plan = createSchemaMigrationPlan(legacy)

  assert.deepEqual(plan.map(({ version }) => version), Array.from({ length: 48 }, (_, index) => index + 2))
  assert.equal(LATEST_SCHEMA_VERSION, 49)
  assert.equal(DB_SCHEMA_VERSION, LATEST_SCHEMA_VERSION)
  assert.equal(schemaMigrations.at(-1).version, LATEST_SCHEMA_VERSION)
})

test('v49 adds the hook argument matcher without rebuilding existing hooks', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE hooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event TEXT NOT NULL,
        tool_pattern TEXT,
        kind TEXT NOT NULL,
        command TEXT,
        url TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        blocking INTEGER NOT NULL DEFAULT 1,
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO hooks
        (id, user_id, event, tool_pattern, kind, enabled, blocking, timeout_ms, created_at, updated_at)
      VALUES ('hook-1', 'user-1', 'pre_tool_use', 'write_*', 'http', 1, 1, 5000, 1, 1);
    `)

    migrateToV49(db)
    migrateToV49(db)

    assert.equal(
      db.prepare('PRAGMA table_info(hooks)').all().some((row) => row.name === 'argument_matcher_json'),
      true,
    )
    assert.deepEqual(
      db.prepare('SELECT tool_pattern, argument_matcher_json FROM hooks WHERE id = ?').get('hook-1'),
      { tool_pattern: 'write_*', argument_matcher_json: null },
    )
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_hooks_user_event'").get(),
    )
  } finally {
    db.close()
  }
})

test('v49 repairs a database whose hooks table is missing', () => {
  const db = new Database(':memory:')
  try {
    migrateToV49(db)
    migrateToV49(db)

    const columns = new Map(
      db.prepare('PRAGMA table_info(hooks)').all().map((column) => [column.name, column]),
    )
    assert.deepEqual([...columns.keys()], [
      'id',
      'user_id',
      'event',
      'tool_pattern',
      'argument_matcher_json',
      'kind',
      'command',
      'url',
      'headers_json',
      'enabled',
      'blocking',
      'timeout_ms',
      'created_at',
      'updated_at',
    ])
    assert.equal(columns.get('user_id').notnull, 1)
    assert.equal(columns.get('event').notnull, 1)
    assert.equal(columns.get('enabled').dflt_value, '1')
    assert.equal(columns.get('blocking').dflt_value, '1')
    assert.equal(columns.get('timeout_ms').dflt_value, '5000')
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_hooks_user_event'").get(),
    )

    db.prepare(`
      INSERT INTO hooks
        (id, user_id, event, tool_pattern, argument_matcher_json, kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'hook-created-by-v49',
      'user-1',
      'notification',
      '*',
      '{"path":"*.env"}',
      'http',
      1,
      1,
    )
    assert.equal(
      db.prepare('SELECT argument_matcher_json FROM hooks WHERE id = ?').get('hook-created-by-v49').argument_matcher_json,
      '{"path":"*.env"}',
    )
  } finally {
    db.close()
  }
})

test('schema migration registry rejects gaps and duplicate versions', () => {
  assert.throws(
    () => createSchemaMigrationPlan([{ version: 29, up() {} }]),
    /must be contiguous/,
  )
  assert.throws(
    () => createSchemaMigrationPlan([
      { version: 30, up() {} },
      { version: 31, up() {} },
    ]),
    /must be contiguous/,
  )
})

test('schema migration registry upgrades a v30 database through every registered migration', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '30');
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY);
      CREATE TABLE model_providers (id TEXT PRIMARY KEY);
      CREATE TABLE turn_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
    `)

    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.equal(
      Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value),
      LATEST_SCHEMA_VERSION,
    )
    assert.equal(
      db.prepare('PRAGMA table_info(model_providers)').all().some((row) => row.name === 'supports_pdf'),
      true,
    )
    assert.equal(
      db.prepare('PRAGMA table_info(model_providers)').all().some((row) => row.name === 'model_profiles_json'),
      true,
    )
    assert.equal(
      db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'revision'),
      true,
    )
    assert.equal(
      db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'pinned_at'),
      true,
    )
    for (const table of [
      'mcp_oauth_credentials',
      'workspace_trust',
      'user_tool_risk_overrides',
      'mcp_oauth_pending_authorizations',
      'webhook_replay_guard',
      'connector_idempotency',
      'web_search_configs',
      'managed_attachments',
      'turn_execution_leases',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table)
    }
  } finally {
    db.close()
  }
})
