import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'

import { DB_SCHEMA_VERSION, checkRateLimit, getDb, migrateFromJson } from '../server/db.js'

// 每个测试进程使用独立数据库目录，避免并行测试冲突
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-tests', String(process.pid))

function cleanDb() {
  const db = getDb()
  for (const table of ['ledger', 'sessions', 'login_codes', 'users', 'rate_limits']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('legacy JSON migration is idempotent for ledger rows', () => {
  const store = {
    users: {
      user_1: {
        id: 'user_1',
        email: 'legacy@example.com',
        credits: 100,
        createdAt: 1700000000000,
      },
    },
    sessions: {},
    ledger: [
      {
        id: 'legacy-ledger-1',
        userId: 'user_1',
        type: 'recharge',
        packageId: 'local-10',
        credits: 100,
        balance: 100,
        createdAt: 1700000001000,
      },
    ],
  }

  migrateFromJson(store)
  assert.doesNotThrow(() => migrateFromJson(store))

  const rows = getDb().prepare('SELECT * FROM ledger WHERE id = ?').all('legacy-ledger-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].balance, 100)
})

test('legacy sqlite schema upgrades before creating user-scoped indexes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-legacy-db-'))
  const dbPath = path.join(dir, 'app.db')
  const legacyDb = new Database(dbPath)
  legacyDb.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT
    );
    CREATE TABLE job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      parent_step_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE TABLE job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE job_artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      icon TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_assets (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (skill_id, path)
    );
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO meta (key, value) VALUES ('schema_version', '1');
  `)
  legacyDb.close()

  const script = `
    process.env.APP_DB_PATH = ${JSON.stringify(dbPath)};
    const { getDbStatus, closeDb } = await import('./server/db.js');
    const status = getDbStatus();
    console.log(JSON.stringify(status));
    closeDb();
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const status = JSON.parse(result.stdout.trim())
    assert.equal(status.ok, true)
    assert.equal(status.schemaVersion, String(DB_SCHEMA_VERSION))
    assert.ok(status.tables.includes('mcp_servers'))
    assert.ok(status.tables.includes('tool_audit'))
    assert.ok(status.tables.includes('subagent_runs'))
    assert.ok(status.tables.includes('memories'))
    assert.ok(status.tables.includes('compaction_archive'))
    assert.ok(status.tables.includes('hooks'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rate limit cleanup does not delete other keys with longer windows', () => {
  const now = 1_700_000_000_000
  const db = getDb()

  assert.equal(checkRateLimit({
    key: 'login_code:client',
    windowMs: 60 * 60 * 1000,
    maxRequests: 5,
    now,
  }).allowed, true)

  assert.equal(checkRateLimit({
    key: 'tool:client',
    windowMs: 60 * 1000,
    maxRequests: 20,
    now: now + 2 * 60 * 1000,
  }).allowed, true)

  const loginRow = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get('login_code:client')
  assert.ok(loginRow, 'short-window cleanup must not delete long-window rate rows')
})
