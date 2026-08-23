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
  for (const table of ['sessions', 'login_codes', 'users', 'rate_limits']) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('legacy JSON migration ignores retired billing data while preserving users and sessions idempotently', () => {
  const store = {
    users: {
      user_1: {
        id: 'user_1',
        email: 'legacy@example.com',
        credits: 100,
        createdAt: 1700000000000,
      },
    },
    sessions: {
      'legacy-session-token': 'user_1',
    },
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

  const db = getDb()
  const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get('user_1')
  assert.deepEqual(user, {
    id: 'user_1',
    email: 'legacy@example.com',
    created_at: 1700000000000,
  })
  const sessions = db.prepare(
    'SELECT token, user_id FROM sessions WHERE token = ?',
  ).all('legacy-session-token')
  assert.deepEqual(sessions, [{ token: 'legacy-session-token', user_id: 'user_1' }])
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get(),
    undefined,
  )
  assert.equal(
    db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'credits'),
    false,
  )
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
    assert.ok(status.tables.includes('cron_jobs'))
    assert.ok(status.tables.includes('channels'))
    assert.ok(status.tables.includes('channel_agents'))
    assert.ok(status.tables.includes('channel_messages'))
    assert.ok(status.tables.includes('channel_messages_fts'))
    assert.ok(status.tables.includes('bridge_sessions'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fresh database reopens without retired billing schema or side-effect data loss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-fresh-reopen-'))
  const dbPath = path.join(dir, 'app.db')
  const initializeScript = `
    process.env.APP_DB_PATH = ${JSON.stringify(dbPath)};
    const { getDb, closeDb } = await import('./server/db.js');
    getDb();
    closeDb();
  `
  const verifyScript = `
    process.env.APP_DB_PATH = ${JSON.stringify(dbPath)};
    const { getDb, closeDb } = await import('./server/db.js');
    const db = getDb();
    const tableExists = (table) => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table));
    const hasColumn = (table, column) => db.prepare(
      'PRAGMA table_info(' + table + ')'
    ).all().some((row) => row.name === column);
    const state = {
      ledgerExists: tableExists('ledger'),
      usersCreditsExists: hasColumn('users', 'credits'),
      subagentCreditsExists: hasColumn('subagent_runs', 'credits'),
      sessionCostCreditsExists: hasColumn('session_meters', 'cost_credits'),
      sideEffectTableExists: tableExists('side_effect_executions'),
      sideEffect: db.prepare(\`
        SELECT owner_id, scope_kind, scope_key, tool_call_id, idempotency_key,
               tool_name, args_digest, status, outcome_json, created_at,
               updated_at, prepared_at, finished_at
          FROM side_effect_executions
         WHERE owner_id = ? AND scope_key = ? AND tool_call_id = ?
      \`).get('reopen-owner', 'turn:reopen', 'call-reopen'),
    };
    console.log(JSON.stringify(state));
    closeDb();
  `

  try {
    const initialized = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', initializeScript],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout)

    const seedDb = new Database(dbPath)
    try {
      seedDb.prepare(`
        INSERT INTO side_effect_executions (
          owner_id, scope_kind, scope_key, tool_call_id, idempotency_key,
          tool_name, args_digest, status, outcome_json, created_at,
          updated_at, prepared_at, finished_at
        ) VALUES (?, 'turn', ?, ?, ?, 'write_file', ?, 'committed', ?, 101, 102, 101, 102)
      `).run(
        'reopen-owner',
        'turn:reopen',
        'call-reopen',
        'idem-reopen',
        'a'.repeat(64),
        JSON.stringify({ ok: true, marker: 'fresh-reopen' }),
      )
    } finally {
      seedDb.close()
    }

    const expected = {
      ledgerExists: false,
      usersCreditsExists: false,
      subagentCreditsExists: false,
      sessionCostCreditsExists: false,
      sideEffectTableExists: true,
      sideEffect: {
        owner_id: 'reopen-owner',
        scope_kind: 'turn',
        scope_key: 'turn:reopen',
        tool_call_id: 'call-reopen',
        idempotency_key: 'idem-reopen',
        tool_name: 'write_file',
        args_digest: 'a'.repeat(64),
        status: 'committed',
        outcome_json: JSON.stringify({ ok: true, marker: 'fresh-reopen' }),
        created_at: 101,
        updated_at: 102,
        prepared_at: 101,
        finished_at: 102,
      },
    }

    for (let startup = 1; startup <= 2; startup += 1) {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', verifyScript],
        { cwd: process.cwd(), encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.deepEqual(JSON.parse(result.stdout.trim()), expected, `startup ${startup}`)
    }
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

/* ── E2/E3/E4: 外键 + NOT NULL + 索引 ── */

function fkList(db, table) {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all()
}
function colInfo(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().find((r) => r.name === col)
}

test('E2: jobs.user_id is NOT NULL and cascades from users', () => {
  const db = getDb()
  const uid = colInfo(db, 'jobs', 'user_id')
  assert.equal(uid.notnull, 1, 'jobs.user_id must be NOT NULL')
  const fks = fkList(db, 'jobs')
  const userFk = fks.find((f) => f.table === 'users' && f.from === 'user_id')
  assert.ok(userFk, 'jobs.user_id must reference users')
  assert.equal(userFk.on_delete, 'CASCADE')
})

test('E2: inserting a job with unknown user_id is rejected by FK', () => {
  const db = getDb()
  const now = Date.now()
  assert.throws(() => {
    db.prepare(
      'INSERT INTO jobs (id, user_id, title, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run('job_fk_test', 'ghost-user', 't', 'p', 'queued', now, now)
  }, /FOREIGN KEY/)
})

test('E2: deleting a user cascades to their jobs', () => {
  const db = getDb()
  const now = Date.now()
  db.prepare('INSERT INTO users (id, email, created_at, updated_at) VALUES (?,?,?,?)')
    .run('cascade-user', 'cascade@example.com', now, now)
  db.prepare(
    'INSERT INTO jobs (id, user_id, title, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
  ).run('job_cascade', 'cascade-user', 't', 'p', 'queued', now, now)
  db.prepare('DELETE FROM users WHERE id = ?').run('cascade-user')
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get('job_cascade')
  assert.equal(row, undefined, 'job should be cascade-deleted with its user')
})

test('E3 (已撤回 FK): tool_audit/subagent_runs/subagents_custom/hooks/compaction_archive 仍是 user_id NOT NULL 的弱引用', () => {
  // 产品决策：这些表的 user_id 是既有弱引用契约（多处调用不建 user 行直写），
  // 强加外键会破坏契约，故 V15 只保留 NOT NULL，不加 CASCADE FK。
  const db = getDb()
  for (const table of ['tool_audit', 'subagent_runs', 'subagents_custom', 'hooks', 'compaction_archive']) {
    const uid = colInfo(db, table, 'user_id')
    assert.ok(uid, `${table} 应有 user_id 列`)
    assert.equal(uid.notnull, 1, `${table}.user_id 应为 NOT NULL`)
  }
})

test('E4: job_steps.parent_step_id has an index', () => {
  const db = getDb()
  const indexes = db.prepare('PRAGMA index_list(job_steps)').all()
  let found = false
  for (const idx of indexes) {
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name)
    if (cols.includes('parent_step_id')) found = true
  }
  assert.ok(found, 'job_steps.parent_step_id must be indexed')
})
