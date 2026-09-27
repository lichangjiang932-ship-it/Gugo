import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'

import { migrateToV121 } from '../server/migrations/v121GoalPlanColumnRepair.js'

/**
 * The shape an earlier build left behind: the two tables exist, but without the
 * columns added later. `CREATE TABLE IF NOT EXISTS` in v118 cannot add them, so
 * these databases stayed broken — every plan write failed with "no column named
 * version" while reads kept working, which is why it looked like "no plan yet"
 * instead of an error.
 */
function createLegacyGoalPlanDatabase() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE goal_plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      supersedes_plan_id TEXT,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE goal_plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return db
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name)
}

function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)
}

test('a database created before the columns existed is repaired', () => {
  const db = createLegacyGoalPlanDatabase()
  try {
    assert.equal(columnsOf(db, 'goal_plans').includes('version'), false, 'the fixture must start broken')
    assert.equal(columnsOf(db, 'goal_plan_steps').includes('evidence_turn_id'), false)

    migrateToV121(db)

    const planColumns = columnsOf(db, 'goal_plans')
    assert.ok(planColumns.includes('version'), 'the optimistic-lock counter exists')
    assert.ok(planColumns.includes('approved_by'), 'the approver is recorded')
    const stepColumns = columnsOf(db, 'goal_plan_steps')
    assert.ok(stepColumns.includes('evidence_turn_id'))
    assert.ok(stepColumns.includes('evidence_tool_call_id'))
    // Without this index one tool call could be cited as proof for several steps.
    assert.ok(indexNames(db).includes('idx_goal_plan_steps_evidence'), 'the one-proof-per-step index exists')

    // The repaired columns are usable, which is the whole point: a plan write that
    // used to fail with "no column named version" now succeeds.
    db.prepare(`INSERT INTO users (id) VALUES ('u1')`).run()
    db.prepare(`
      INSERT INTO goal_plans (id, user_id, session_id, objective, status, revision, version, created_at, updated_at)
      VALUES ('p1', 'u1', 's1', '目标', 'awaiting_approval', 1, 1, 1, 1)
    `).run()
    db.prepare(`UPDATE goal_plans SET version = version + 1, approved_by = 'u1' WHERE id = 'p1'`).run()
    assert.equal(db.prepare("SELECT version FROM goal_plans WHERE id = 'p1'").get().version, 2)
  } finally {
    db.close()
  }
})

test('repairing twice is safe, and a current database is left alone', () => {
  const legacy = createLegacyGoalPlanDatabase()
  try {
    migrateToV121(legacy)
    // Migrations are recorded as applied, but a re-run must not throw if one is
    // ever replayed against a database that already has the columns.
    assert.doesNotThrow(() => migrateToV121(legacy))
    assert.equal(columnsOf(legacy, 'goal_plans').filter((name) => name === 'version').length, 1)
  } finally {
    legacy.close()
  }

  // A database created from the current v118 already has everything; the repair
  // must be a no-op rather than a duplicate-column failure.
  const current = new Database(':memory:')
  try {
    current.exec(`
      CREATE TABLE goal_plans (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, objective TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
        supersedes_plan_id TEXT, approved_at INTEGER, approved_by TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE goal_plan_steps (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, user_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        title TEXT NOT NULL, acceptance_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}', evidence_verified INTEGER NOT NULL DEFAULT 0,
        evidence_turn_id TEXT, evidence_tool_call_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    assert.doesNotThrow(() => migrateToV121(current))
    assert.equal(columnsOf(current, 'goal_plans').filter((name) => name === 'version').length, 1)
    assert.ok(indexNames(current).includes('idx_goal_plan_steps_evidence'))
  } finally {
    current.close()
  }
})
