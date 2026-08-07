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

test('schema migration registry is contiguous and owns the latest version', () => {
  const legacy = Array.from({ length: 29 }, (_, index) => ({
    version: index + 2,
    up() {},
  }))
  const plan = createSchemaMigrationPlan(legacy)

  assert.deepEqual(plan.map(({ version }) => version), Array.from({ length: 38 }, (_, index) => index + 2))
  assert.equal(LATEST_SCHEMA_VERSION, 39)
  assert.equal(DB_SCHEMA_VERSION, LATEST_SCHEMA_VERSION)
  assert.equal(schemaMigrations.at(-1).version, LATEST_SCHEMA_VERSION)
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
      db.prepare('PRAGMA table_info(sessions)').all().some((row) => row.name === 'revision'),
      true,
    )
    for (const table of [
      'mcp_oauth_credentials',
      'workspace_trust',
      'user_tool_risk_overrides',
      'mcp_oauth_pending_authorizations',
      'webhook_replay_guard',
      'connector_idempotency',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table)
    }
  } finally {
    db.close()
  }
})
