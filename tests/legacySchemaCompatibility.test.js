import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import { LEGACY_SCHEMA_MIGRATIONS } from '../server/migrations/legacyCompatibility.js'

function readSchemaVersion(db) {
  return Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
  )
}

function runLegacyMigrationsThrough(db, targetVersion) {
  const applied = []
  for (const migration of LEGACY_SCHEMA_MIGRATIONS) {
    const currentVersion = readSchemaVersion(db)
    if (migration.version <= currentVersion || migration.version > targetVersion) continue
    assert.equal(migration.version, currentVersion + 1)
    migration.up(db)
    assert.equal(readSchemaVersion(db), migration.version)
    applied.push(migration.version)
  }
  return applied
}

function assertRunnerRerunIsNoop(db, targetVersion) {
  assert.deepEqual(runLegacyMigrationsThrough(db, targetVersion), [])
  assert.equal(readSchemaVersion(db), targetVersion)
}

test('legacy compatibility adapter provides the exact contiguous v2-v30 chain', () => {
  assert.deepEqual(
    LEGACY_SCHEMA_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 29 }, (_, index) => index + 2),
  )
  for (const migration of LEGACY_SCHEMA_MIGRATIONS) {
    assert.equal(typeof migration.up, 'function', `v${migration.version}`)
  }
})

test('v14 to v15 preserves valid jobs, removes orphans, and enforces ownership', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '14');

      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner-v15');

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
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
        title TEXT,
        kind TEXT,
        status TEXT,
        sort_order INTEGER,
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE job_artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE
      );

      INSERT INTO jobs (
        id, user_id, title, prompt, status, progress, cancel_requested,
        created_at, updated_at, started_at, finished_at, error
      ) VALUES
        ('valid-job', 'owner-v15', 'valid', 'keep me', 'queued', 10, 0, 1, 2, NULL, NULL, NULL),
        ('orphan-job', 'missing-owner', 'orphan', 'remove me', 'queued', 20, 0, 3, 4, NULL, NULL, NULL);
      INSERT INTO job_steps (id, job_id, parent_step_id) VALUES
        ('valid-step', 'valid-job', NULL),
        ('orphan-step', 'orphan-job', NULL);
      INSERT INTO job_events (id, job_id) VALUES
        (1, 'valid-job'),
        (2, 'orphan-job');
      INSERT INTO job_artifacts (id, job_id) VALUES
        ('valid-artifact', 'valid-job'),
        ('orphan-artifact', 'orphan-job');
    `)

    assert.deepEqual(runLegacyMigrationsThrough(db, 15), [15])
    assert.deepEqual(
      db.prepare('SELECT id, user_id, prompt, progress FROM jobs ORDER BY id').all(),
      [{ id: 'valid-job', user_id: 'owner-v15', prompt: 'keep me', progress: 10 }],
    )
    assert.deepEqual(
      db.prepare('SELECT id FROM job_steps ORDER BY id').all(),
      [{ id: 'valid-step' }],
    )
    assert.deepEqual(
      db.prepare('SELECT id FROM job_events ORDER BY id').all(),
      [{ id: 1 }],
    )
    assert.deepEqual(
      db.prepare('SELECT id FROM job_artifacts ORDER BY id').all(),
      [{ id: 'valid-artifact' }],
    )

    const userIdColumn = db.prepare('PRAGMA table_info(jobs)').all()
      .find(({ name }) => name === 'user_id')
    assert.equal(userIdColumn.notnull, 1)
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(jobs)').all()
        .filter(({ from }) => from === 'user_id')
        .map(({ table, to, on_delete: onDelete }) => ({ table, to, onDelete })),
      [{ table: 'users', to: 'id', onDelete: 'CASCADE' }],
    )
    const indexes = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
        .map(({ name }) => name),
    )
    for (const index of [
      'idx_jobs_status_created',
      'idx_jobs_user_created',
      'idx_jobs_user_status',
      'idx_job_steps_parent',
    ]) {
      assert.equal(indexes.has(index), true, index)
    }
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assertRunnerRerunIsNoop(db, 15)
  } finally {
    db.close()
  }
})

test('v16 to v17 preserves MCP servers and admits the http transport', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '16');

      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner-v17');

      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','sse')),
        command TEXT,
        args_json TEXT,
        env_json TEXT,
        cwd TEXT,
        url TEXT,
        headers_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_approve_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_mcp_servers_user ON mcp_servers(user_id, enabled);
      INSERT INTO mcp_servers VALUES (
        'mcp-v17', 'owner-v17', 'legacy-sse', 'sse', NULL, '[]', '{}',
        NULL, 'https://example.test/sse', '{}', 1, '[]', 10, 11
      );
    `)

    assert.deepEqual(runLegacyMigrationsThrough(db, 17), [17])
    assert.deepEqual(
      db.prepare(`
        SELECT id, user_id, name, transport, url, created_at, updated_at
          FROM mcp_servers
      `).all(),
      [{
        id: 'mcp-v17',
        user_id: 'owner-v17',
        name: 'legacy-sse',
        transport: 'sse',
        url: 'https://example.test/sse',
        created_at: 10,
        updated_at: 11,
      }],
    )
    assert.doesNotThrow(() => db.prepare(`
      INSERT INTO mcp_servers (
        id, user_id, name, transport, url, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 'http', ?, 1, 12, 13)
    `).run('mcp-http', 'owner-v17', 'streamable-http', 'https://example.test/mcp'))
    assert.throws(
      () => db.prepare(`
        INSERT INTO mcp_servers (
          id, user_id, name, transport, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, 'websocket', 1, 14, 15)
      `).run('mcp-invalid', 'owner-v17', 'invalid'),
      /CHECK constraint failed/u,
    )
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assertRunnerRerunIsNoop(db, 17)
  } finally {
    db.close()
  }
})

test('v18 to v19 preserves notifications and expands the kind constraint', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '18');

      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner-v19');
      CREATE TABLE jobs (id TEXT PRIMARY KEY);

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('info','success','warn','error','job')),
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        link TEXT,
        data_json TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_notifications_user_created
        ON notifications(user_id, created_at DESC);
      CREATE INDEX idx_notifications_user_read
        ON notifications(user_id, read_at, created_at DESC);
      INSERT INTO notifications VALUES (
        'notice-v19', 'owner-v19', 'warn', 'preserve', 'legacy body',
        '/legacy', '{"legacy":true}', NULL, 19
      );
    `)

    assert.deepEqual(runLegacyMigrationsThrough(db, 19), [19])
    assert.deepEqual(
      db.prepare(`
        SELECT id, user_id, kind, title, body, link, data_json, read_at, created_at
          FROM notifications
      `).all(),
      [{
        id: 'notice-v19',
        user_id: 'owner-v19',
        kind: 'warn',
        title: 'preserve',
        body: 'legacy body',
        link: '/legacy',
        data_json: '{"legacy":true}',
        read_at: null,
        created_at: 19,
      }],
    )
    assert.doesNotThrow(() => db.prepare(`
      INSERT INTO notifications (
        id, user_id, kind, title, body, created_at
      ) VALUES (?, ?, 'approval', ?, '', 20)
    `).run('approval-v19', 'owner-v19', 'approval requested'))
    assert.throws(
      () => db.prepare(`
        INSERT INTO notifications (
          id, user_id, kind, title, body, created_at
        ) VALUES (?, ?, 'unknown', ?, '', 21)
      `).run('invalid-v19', 'owner-v19', 'invalid'),
      /CHECK constraint failed/u,
    )
    assert.equal(
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_approvals'",
      ).get() != null,
      true,
    )
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assertRunnerRerunIsNoop(db, 19)
  } finally {
    db.close()
  }
})

test('v26 to v27 preserves non-shell grants and removes legacy bash wildcard grants', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '26');

      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner-v27');

      CREATE TABLE approval_tool_grants (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, tool_name)
      );
      INSERT INTO approval_tool_grants VALUES
        ('owner-v27', 'bash_exec', 26),
        ('owner-v27', 'read_file', 27),
        ('owner-v27', 'web_search', 28);
    `)

    assert.deepEqual(runLegacyMigrationsThrough(db, 27), [27])
    assert.deepEqual(
      db.prepare(`
        SELECT user_id, tool_name, command_prefix, created_at
          FROM approval_tool_grants
         ORDER BY tool_name
      `).all(),
      [
        {
          user_id: 'owner-v27',
          tool_name: 'read_file',
          command_prefix: '',
          created_at: 27,
        },
        {
          user_id: 'owner-v27',
          tool_name: 'web_search',
          command_prefix: '',
          created_at: 28,
        },
      ],
    )
    assert.doesNotThrow(() => {
      const insert = db.prepare(`
        INSERT INTO approval_tool_grants (
          user_id, tool_name, command_prefix, created_at
        ) VALUES (?, 'bash_exec', ?, 29)
      `)
      insert.run('owner-v27', 'git status')
      insert.run('owner-v27', 'npm test')
    })
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assertRunnerRerunIsNoop(db, 27)
  } finally {
    db.close()
  }
})
