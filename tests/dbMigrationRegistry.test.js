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
import { migrateToV50 } from '../server/migrations/v50DefaultExecutionPermissions.js'
import { migrateToV51 } from '../server/migrations/v51TurnCheckpoints.js'
import { migrateToV52 } from '../server/migrations/v52DefaultOutputDirectory.js'
import { migrateToV53 } from '../server/migrations/v53PermissionModeEvents.js'
import { migrateToV54 } from '../server/migrations/v54ApprovalMetadataSource.js'
import { migrateToV56 } from '../server/migrations/v56McpToolRiskDeclarations.js'
import { migrateToV57 } from '../server/migrations/v57EventWriteFailures.js'
import { migrateToV58 } from '../server/migrations/v58CronTaskGrants.js'
import { migrateToV59 } from '../server/migrations/v59SessionBranches.js'
import { migrateToV60 } from '../server/migrations/v60RuntimePluginStates.js'
import { migrateToV61 } from '../server/migrations/v61EvolutionEvidence.js'
import { migrateToV62 } from '../server/migrations/v62EvolutionExclusions.js'
import { migrateToV63 } from '../server/migrations/v63EvolutionCandidates.js'
import { migrateToV64 } from '../server/migrations/v64EvolutionReplay.js'
import { migrateToV65 } from '../server/migrations/v65EvolutionEvaluations.js'
import { migrateToV66 } from '../server/migrations/v66EvolutionApprovals.js'

test('schema migration registry is contiguous and owns the latest version', () => {
  const legacy = Array.from({ length: 29 }, (_, index) => ({
    version: index + 2,
    up() {},
  }))
  const plan = createSchemaMigrationPlan(legacy)

  assert.deepEqual(
    plan.map(({ version }) => version),
    Array.from({ length: LATEST_SCHEMA_VERSION - 1 }, (_, index) => index + 2),
  )
  assert.equal(LATEST_SCHEMA_VERSION, 66)
  assert.equal(DB_SCHEMA_VERSION, LATEST_SCHEMA_VERSION)
  assert.equal(schemaMigrations.at(-1).version, LATEST_SCHEMA_VERSION)
})

test('v66 persists one immutable local-owner decision per evaluation', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
      INSERT INTO evolution_replay_runs (id) VALUES ('replay-1');
      INSERT INTO evolution_evaluations (id) VALUES ('evaluation-1');
    `)
    migrateToV66(db)
    migrateToV66(db)
    db.prepare(`
      INSERT INTO evolution_approval_decisions (
        id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
        candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        rollback_baseline_sha256, rollback_target_json, review_snapshot_json,
        approver_mode, decision_fingerprint, created_at
      ) VALUES ('approval-1', 'user-1', 'evaluation-1', 'replay-1', 'candidate-1',
        'approved', 'reviewed', ?, ?, ?, ?, '{}', '{}', 'local_owner_loopback', ?, 1)
    `).run(...Array.from({ length: 5 }, (_, index) => String.fromCharCode(97 + index).repeat(64)))
    assert.deepEqual(
      db.prepare('SELECT decision, approver_mode FROM evolution_approval_decisions').get(),
      { decision: 'approved', approver_mode: 'local_owner_loopback' },
    )
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_approval_decisions (
        id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
        candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        rollback_baseline_sha256, rollback_target_json, review_snapshot_json,
        approver_mode, decision_fingerprint, created_at
      ) SELECT 'approval-2', user_id, evaluation_id, replay_id, candidate_id,
        'rejected', reason, candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        rollback_baseline_sha256, rollback_target_json, review_snapshot_json,
        approver_mode, decision_fingerprint, 2 FROM evolution_approval_decisions
    `).run(), /UNIQUE constraint failed/)
    assert.throws(() => db.prepare(`
      UPDATE evolution_approval_decisions SET approver_mode = 'remote' WHERE id = 'approval-1'
    `).run(), /CHECK constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_approval_decisions').get().count, 0)
  } finally {
    db.close()
  }
})

test('v65 persists independent structured evaluations with constrained verdicts', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
      INSERT INTO evolution_replay_runs (id) VALUES ('replay-1');
    `)
    migrateToV65(db)
    migrateToV65(db)
    db.prepare(`
      INSERT INTO evolution_evaluations (
        id, user_id, replay_id, candidate_id, rubric_version, evaluator_model,
        independent, verdict, summary, case_assessments_json, metrics_json,
        issues_json, evaluation_fingerprint, created_at
      ) VALUES ('evaluation-1', 'user-1', 'replay-1', 'candidate-1', 'v1',
        'reviewer', 1, 'inconclusive', 'summary', '[]', '{}', '[]', ?, 1)
    `).run('a'.repeat(64))
    assert.deepEqual(
      db.prepare('SELECT independent, verdict, evaluator_model FROM evolution_evaluations').get(),
      { independent: 1, verdict: 'inconclusive', evaluator_model: 'reviewer' },
    )
    assert.throws(() => db.prepare(`
      UPDATE evolution_evaluations SET independent = 0 WHERE id = 'evaluation-1'
    `).run(), /CHECK constraint failed/)
    assert.throws(() => db.prepare(`
      UPDATE evolution_evaluations SET verdict = 'approved' WHERE id = 'evaluation-1'
    `).run(), /CHECK constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_evaluations').get().count, 0)
  } finally {
    db.close()
  }
})

test('v64 persists immutable replay suites and constrained completed runs', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
    `)
    migrateToV64(db)
    migrateToV64(db)
    db.prepare(`
      INSERT INTO evolution_replay_suites (
        id, user_id, name, dataset_fingerprint, curation_version,
        source_record_ids_json, cases_json, suite_fingerprint, created_at
      ) VALUES ('suite-1', 'user-1', 'Suite', ?, 'v1', '[]', '[]', ?, 1)
    `).run('a'.repeat(64), 'b'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_replay_runs (
        id, user_id, suite_id, candidate_id, baseline_content, baseline_sha256,
        candidate_sha256, model_name, temperature, max_tokens, isolation_mode,
        results_json, run_fingerprint, created_at
      ) VALUES ('run-1', 'user-1', 'suite-1', 'candidate-1', 'baseline', ?, ?, 'model', 0, 512, 'model_no_tools', '[]', ?, 2)
    `).run('c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64))
    assert.deepEqual(
      db.prepare('SELECT isolation_mode, temperature, max_tokens FROM evolution_replay_runs').get(),
      { isolation_mode: 'model_no_tools', temperature: 0, max_tokens: 512 },
    )
    assert.throws(() => db.prepare(`
      UPDATE evolution_replay_runs SET max_tokens = 0 WHERE id = 'run-1'
    `).run(), /CHECK constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_replay_runs').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_replay_suites').get().count, 0)
  } finally {
    db.close()
  }
})

test('v63 persists inert user-scoped candidate objects with constrained kinds', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES ('user-1')")
    migrateToV63(db)
    migrateToV63(db)
    db.prepare(`
      INSERT INTO evolution_candidates (
        id, user_id, kind, target, title, summary, content,
        assumptions_json, expected_impact_json, permissions_requested_json,
        dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
        generator_model, generator_mode, content_sha256, created_at
      ) VALUES (
        'candidate-1', 'user-1', 'prompt', 'prompt:system', 'Title', 'Summary', 'Content',
        '[]', '[]', '[]', ?, 'v1', '[]', '[]',
        'model-a', 'background_model_no_tools', ?, 10
      )
    `).run('a'.repeat(64), 'b'.repeat(64))
    assert.deepEqual(
      db.prepare('SELECT id, kind, target, generator_mode FROM evolution_candidates').get(),
      {
        id: 'candidate-1',
        kind: 'prompt',
        target: 'prompt:system',
        generator_mode: 'background_model_no_tools',
      },
    )
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_candidates (
        id, user_id, kind, target, title, summary, content,
        assumptions_json, expected_impact_json, permissions_requested_json,
        dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
        generator_mode, content_sha256, created_at
      ) VALUES ('bad', 'user-1', 'executable', 'plugin:x', 'T', 'S', 'C', '[]', '[]', '[]', ?, 'v1', '[]', '[]', 'background_model_no_tools', ?, 11)
    `).run('a'.repeat(64), 'b'.repeat(64)), /CHECK constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_candidates').get().count, 0)
  } finally {
    db.close()
  }
})

test('v62 persists reversible user-scoped evidence exclusions', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES ('user-1')")
    migrateToV62(db)
    migrateToV62(db)
    db.prepare(`
      INSERT INTO evolution_evidence_exclusions (user_id, evidence_id, reason, created_at)
      VALUES ('user-1', 'feedback:abc', 'duplicate', 10)
    `).run()
    assert.deepEqual(
      db.prepare('SELECT evidence_id, reason, created_at FROM evolution_evidence_exclusions').get(),
      { evidence_id: 'feedback:abc', reason: 'duplicate', created_at: 10 },
    )
    assert.throws(
      () => db.prepare(`
        INSERT INTO evolution_evidence_exclusions (user_id, evidence_id, created_at)
        VALUES ('user-1', 'feedback:abc', 11)
      `).run(),
      /UNIQUE constraint failed/,
    )
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_evidence_exclusions').get().count, 0)
  } finally {
    db.close()
  }
})

test('v61 persists user-scoped evolution feedback and preserves referential cleanup', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO sessions (token, user_id) VALUES ('session-1', 'user-1');
    `)
    migrateToV61(db)
    migrateToV61(db)

    db.prepare(`
      INSERT INTO evolution_feedback (id, user_id, session_id, body, created_at)
      VALUES ('feedback-1', 'user-1', 'session-1', 'use clearer errors', 10)
    `).run()
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_evolution_feedback_user_created'").get(),
    )
    db.prepare("DELETE FROM sessions WHERE token = 'session-1'").run()
    assert.equal(
      db.prepare("SELECT session_id FROM evolution_feedback WHERE id = 'feedback-1'").get().session_id,
      null,
    )
    assert.throws(
      () => db.prepare(`
        INSERT INTO evolution_feedback (id, user_id, body, created_at)
        VALUES ('feedback-empty', 'user-1', '', 11)
      `).run(),
      /CHECK constraint failed/,
    )
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_feedback').get().count, 0)
  } finally {
    db.close()
  }
})

test('v60 persists runtime plugin state with boolean enforcement and is idempotent', () => {
  const db = new Database(':memory:')
  try {
    migrateToV60(db)
    migrateToV60(db)

    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_plugin_states'").get(),
    )
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_runtime_plugin_states_enabled'").get(),
    )
    db.prepare('INSERT INTO runtime_plugin_states (plugin_id, updated_at) VALUES (?, ?)')
      .run('default-disabled', 10)
    assert.deepEqual(
      db.prepare('SELECT enabled, last_error, updated_at FROM runtime_plugin_states WHERE plugin_id = ?')
        .get('default-disabled'),
      { enabled: 0, last_error: null, updated_at: 10 },
    )
    assert.throws(
      () => db.prepare(`
        INSERT INTO runtime_plugin_states (plugin_id, enabled, updated_at)
        VALUES (?, ?, ?)
      `).run('invalid-enabled', 2, 11),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v59 persists session lineage and releases children when a parent is deleted', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        id TEXT,
        title TEXT
      );
      INSERT INTO sessions (token, user_id, id, title)
      VALUES ('parent', 'user-1', 'parent', 'Parent');
    `)
    migrateToV59(db)
    migrateToV59(db)
    db.prepare(`
      INSERT INTO sessions
        (token, user_id, id, title, parent_session_id, branch_label, forked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('child', 'user-1', 'child', 'Child', 'parent', 'Alternative', 100)

    assert.deepEqual(
      db.prepare('SELECT parent_session_id, branch_label, forked_at FROM sessions WHERE token = ?').get('child'),
      { parent_session_id: 'parent', branch_label: 'Alternative', forked_at: 100 },
    )
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user_parent'").get(),
    )
    db.prepare('DELETE FROM sessions WHERE token = ?').run('parent')
    assert.equal(
      db.prepare('SELECT parent_session_id FROM sessions WHERE token = ?').get('child').parent_session_id,
      null,
    )
  } finally {
    db.close()
  }
})

test('v58 persists cron grants and scheduled job provenance', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE cron_jobs (id TEXT PRIMARY KEY);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO cron_jobs (id) VALUES ('cron-legacy');
      INSERT INTO jobs (id, created_at) VALUES ('job-legacy', 1);
    `)
    migrateToV58(db)
    migrateToV58(db)

    assert.deepEqual(
      db.prepare('SELECT grants_json FROM cron_jobs WHERE id = ?').get('cron-legacy'),
      { grants_json: '[]' },
    )
    assert.deepEqual(
      db.prepare('SELECT source_type, source_id, grants_json FROM jobs WHERE id = ?').get('job-legacy'),
      { source_type: null, source_id: null, grants_json: '[]' },
    )
    db.prepare('UPDATE jobs SET source_type = ?, source_id = ?, grants_json = ? WHERE id = ?')
      .run('cron', 'cron-1', '[{"tool":"bash_exec"}]', 'job-legacy')
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_source'").get(),
    )
  } finally {
    db.close()
  }
})

test('v57 stores exhausted event write-behind failures for diagnostics', () => {
  const db = new Database(':memory:')
  try {
    migrateToV57(db)
    migrateToV57(db)
    db.prepare(`INSERT INTO event_write_failures
      (user_id, session_id, turn_id, event_id, event_sequence, event_type,
        payload_json, error_message, attempts, failed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('u-1', 's-1', 't-1', 'e-1', 4, 'assistant.delta', '{"text":"x"}', 'disk full', 3, 100)
    const row = db.prepare('SELECT * FROM event_write_failures WHERE event_id = ?').get('e-1')
    assert.equal(row.event_type, 'assistant.delta')
    assert.equal(row.attempts, 3)
    assert.equal(row.error_message, 'disk full')
  } finally {
    db.close()
  }
})

test('v56 persists MCP per-tool risk declarations without rewriting existing rows', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE mcp_servers (id TEXT PRIMARY KEY); INSERT INTO mcp_servers (id) VALUES ('legacy-mcp');")
    migrateToV56(db)
    migrateToV56(db)

    const column = db.prepare('PRAGMA table_info(mcp_servers)').all()
      .find((item) => item.name === 'tools_json')
    assert.equal(column.notnull, 1)
    assert.equal(column.dflt_value, "'{}'")
    assert.equal(db.prepare('SELECT tools_json FROM mcp_servers WHERE id = ?').get('legacy-mcp').tools_json, '{}')
  } finally {
    db.close()
  }
})

test('v54 persists approval metadata source and backfills legacy rows as fallback', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE pending_approvals (id TEXT PRIMARY KEY);
      INSERT INTO pending_approvals (id) VALUES ('legacy-approval');
    `)
    migrateToV54(db)
    migrateToV54(db)

    const column = db.prepare('PRAGMA table_info(pending_approvals)').all()
      .find((item) => item.name === 'metadata_source')
    assert.equal(column.notnull, 1)
    assert.equal(column.dflt_value, "'fallback'")
    assert.equal(
      db.prepare('SELECT metadata_source FROM pending_approvals WHERE id = ?').get('legacy-approval').metadata_source,
      'fallback',
    )
    db.prepare('INSERT INTO pending_approvals (id, metadata_source) VALUES (?, ?)')
      .run('declared-approval', 'declared')
    assert.throws(
      () => db.prepare('INSERT INTO pending_approvals (id, metadata_source) VALUES (?, ?)')
        .run('invalid-approval', 'guessed'),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v53 stores queryable permission-mode transition history', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('user-1');")
    migrateToV53(db)
    migrateToV53(db)
    db.prepare(`
      INSERT INTO permission_mode_events
        (user_id, from_mode, to_mode, transition_kind, justification, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-1', 'normal', 'bypass', 'widened', 'trusted local machine', 1)
    assert.deepEqual(
      db.prepare('SELECT from_mode, to_mode, transition_kind, justification FROM permission_mode_events').get(),
      { from_mode: 'normal', to_mode: 'bypass', transition_kind: 'widened', justification: 'trusted local machine' },
    )
  } finally {
    db.close()
  }
})

test('v52 persists a user default output directory without changing all-files access', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE local_file_access_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        all_files_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('user-1');
      INSERT INTO local_file_access_settings VALUES ('user-1', 1, 1);
    `)
    migrateToV52(db)
    migrateToV52(db)

    const columns = db.prepare('PRAGMA table_info(local_file_access_settings)').all().map((row) => row.name)
    assert.deepEqual(columns, ['user_id', 'all_files_enabled', 'updated_at', 'default_output_directory'])
    assert.deepEqual(
      db.prepare('SELECT all_files_enabled, default_output_directory FROM local_file_access_settings WHERE user_id = ?').get('user-1'),
      { all_files_enabled: 1, default_output_directory: null },
    )
  } finally {
    db.close()
  }
})

test('v51 adds one mutable checkpoint row per turn', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    `)
    migrateToV51(db)
    migrateToV51(db)

    const columns = db.prepare('PRAGMA table_info(turn_checkpoints)').all().map((row) => row.name)
    assert.deepEqual(columns, [
      'user_id',
      'session_id',
      'turn_id',
      'event_sequence',
      'state_json',
      'created_at',
      'updated_at',
    ])
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_turn_checkpoints_updated'").get(),
    )
  } finally {
    db.close()
  }
})

test('v50 upgrades only legacy default execution permissions', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE user_approval_settings (user_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO user_approval_settings VALUES ('legacy', 'normal', 1), ('explicit', 'plan', 1);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        is_default INTEGER NOT NULL,
        persona_manifest_json TEXT
      );
    `)
    const baseline = JSON.stringify({ version: 1, capabilityIds: [], recommendedConnectorIds: [], defaultPermissionMode: 'normal' })
    const custom = JSON.stringify({ version: 1, capabilityIds: ['coding'], recommendedConnectorIds: [], defaultPermissionMode: 'normal' })
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run('default', 1, baseline)
    db.prepare('INSERT INTO agents VALUES (?, ?, ?)').run('custom', 1, custom)

    migrateToV50(db)
    migrateToV50(db)

    assert.equal(db.prepare('SELECT mode FROM user_approval_settings WHERE user_id = ?').get('legacy').mode, 'bypass')
    assert.equal(db.prepare('SELECT mode FROM user_approval_settings WHERE user_id = ?').get('explicit').mode, 'plan')
    assert.equal(JSON.parse(db.prepare('SELECT persona_manifest_json FROM agents WHERE id = ?').get('default').persona_manifest_json).defaultPermissionMode, 'bypass')
    assert.equal(JSON.parse(db.prepare('SELECT persona_manifest_json FROM agents WHERE id = ?').get('custom').persona_manifest_json).defaultPermissionMode, 'normal')
  } finally {
    db.close()
  }
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
      'turn_checkpoints',
      'permission_mode_events',
      'runtime_plugin_states',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table)
    }
  } finally {
    db.close()
  }
})
