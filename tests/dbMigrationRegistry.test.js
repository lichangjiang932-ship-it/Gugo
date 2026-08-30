import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { DB_SCHEMA_VERSION } from '../server/db.js'
import {
  LATEST_SCHEMA_VERSION,
  createSchemaMigrationPlan,
  runSchemaMigrations,
  schemaMigrations,
} from '../server/migrations/index.js'
import { migrateToV49 } from '../server/migrations/v49HookArgumentMatcher.js'
import { migrateToV43 } from '../server/migrations/v43TurnExecutionLeases.js'
import { migrateToV44 } from '../server/migrations/v44TurnSteering.js'
import { migrateToV46 } from '../server/migrations/v46FileSnapshots.js'
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
import { migrateToV67 } from '../server/migrations/v67EvolutionCanaries.js'
import { migrateToV68 } from '../server/migrations/v68EvolutionCanaryRollback.js'
import { migrateToV69 } from '../server/migrations/v69TurnRecoveryStates.js'
import { migrateToV70 } from '../server/migrations/v70ModelProviderReadiness.js'
import { migrateToV71 } from '../server/migrations/v71EvolutionModelProviders.js'
import { migrateToV72 } from '../server/migrations/v72SubagentModelBindings.js'
import { migrateToV73 } from '../server/migrations/v73EvolutionModelRevisions.js'
import { migrateToV74 } from '../server/migrations/v74RuntimePluginReleases.js'
import { migrateToV75 } from '../server/migrations/v75RuntimePluginReleaseRevision.js'
import { migrateToV76 } from '../server/migrations/v76RuntimePluginReleaseContentIdentity.js'
import { migrateToV77 } from '../server/migrations/v77UserDataClearOperations.js'
import { migrateToV78 } from '../server/migrations/v78RuntimePluginReleaseRetention.js'
import { migrateToV79 } from '../server/migrations/v79SideEffectExecutions.js'
import { migrateToV80 } from '../server/migrations/v80SideEffectRecoveryMetadata.js'
import { migrateToV81 } from '../server/migrations/v81EvolutionPromotions.js'
import { migrateToV82 } from '../server/migrations/v82EvolutionOnlineGrades.js'
import { migrateToV83 } from '../server/migrations/v83EvolutionPromotionOnlineGrades.js'
import { migrateToV84 } from '../server/migrations/v84EvolutionConfigChanges.js'
import { migrateToV88 } from '../server/migrations/v88EvolutionOperations.js'
import { migrateToV89 } from '../server/migrations/v89EvolutionOperationLeases.js'
import { migrateToV90 } from '../server/migrations/v90EvolutionOperationRecoveryChallenge.js'
import { migrateToV91 } from '../server/migrations/v91PendingApprovalPolicyProvenance.js'
import { migrateToV92 } from '../server/migrations/v92HookSideEffectExecutions.js'
import { migrateToV93 } from '../server/migrations/v93TurnExecutionFencing.js'
import { migrateToV94 } from '../server/migrations/v94SessionContentOutbox.js'
import { migrateToV95 } from '../server/migrations/v95RetiredAccountFields.js'
import { migrateToV96 } from '../server/migrations/v96SideEffectRecoveryPlans.js'
import { migrateToV97 } from '../server/migrations/v97CompactionArchiveStorage.js'
import { migrateToV98 } from '../server/migrations/v98ManagedAttachmentUploadLeases.js'
import { migrateToV99 } from '../server/migrations/v99CompactionArchiveGovernanceJournal.js'
import { migrateToV100 } from '../server/migrations/v100RuntimePluginPermissionGrants.js'
import { migrateToV101 } from '../server/migrations/v101RuntimePluginPermissionOwners.js'
import { migrateToV102 } from '../server/migrations/v102FileSnapshotAfterIdentity.js'
import { migrateToV103 } from '../server/migrations/v103RuntimePluginMutationBarrier.js'
import { migrateToV104 } from '../server/migrations/v104RuntimePluginMutationRecoveryReceipts.js'
import { migrateToV106 } from '../server/migrations/v106EvolutionAutoLoop.js'

function createRuntimePluginMutationBarrierPrerequisites(db, {
  includePermissionGrants = true,
} = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_states (plugin_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS runtime_plugin_releases (
      release_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_plugin_release_pins (
      plugin_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      PRIMARY KEY (plugin_id, release_id, reference_kind, reference_id)
    );
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      turn_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_turn_checkpoints (
      step_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_events (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_write_failures (
      id INTEGER PRIMARY KEY,
      checkpoint_state_json TEXT
    );
  `)
  if (includePermissionGrants) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_plugin_permission_grants (
        plugin_id TEXT PRIMARY KEY
      );
    `)
  }
}

function createV106DraftDatabase({ unresolvedSessionScope = false } = {}) {
  const db = new Database(':memory:')
  const fingerprint = (character) => character.repeat(64)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '106');

    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('draft-user');

    CREATE TABLE runtime_plugin_states (
      plugin_id TEXT PRIMARY KEY,
      active_release_id TEXT,
      release_revision INTEGER
    );
    CREATE TABLE runtime_plugin_releases (
      release_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL
    );
    CREATE TABLE runtime_plugin_release_pins (
      plugin_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      PRIMARY KEY (plugin_id, release_id, reference_kind, reference_id)
    );
    CREATE TABLE runtime_plugin_permission_grants (plugin_id TEXT PRIMARY KEY);
    CREATE TABLE turn_checkpoints (turn_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE job_turn_checkpoints (step_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE turn_events (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE event_write_failures (
      id INTEGER PRIMARY KEY,
      checkpoint_state_json TEXT,
      payload_json TEXT
    );

    CREATE TABLE runtime_plugin_mutation_barrier_generations (
      plugin_id TEXT PRIMARY KEY,
      last_generation INTEGER NOT NULL,
      UNIQUE (plugin_id, last_generation)
    );
    CREATE TABLE runtime_plugin_mutation_barriers (
      plugin_id TEXT PRIMARY KEY
        REFERENCES runtime_plugin_mutation_barrier_generations(plugin_id) ON DELETE RESTRICT,
      token TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL,
      operation TEXT NOT NULL,
      phase TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      store_revision TEXT,
      created_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      recovery_required INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO runtime_plugin_mutation_barrier_generations VALUES
      ('completed-plugin', 3),
      ('draft-plugin', 7);
    INSERT INTO runtime_plugin_mutation_barriers VALUES (
      'draft-plugin', 'token-0000000007', 7, 'uninstall', 'guarding', 1, NULL, 10, 11, 0
    );

    CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
    CREATE TABLE evolution_replay_suites (id TEXT PRIMARY KEY);
    CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
    CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
    CREATE TABLE evolution_approval_decisions (id TEXT PRIMARY KEY);
    CREATE TABLE evolution_canary_releases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_ids_json TEXT NOT NULL
    );
    CREATE TABLE evolution_promotions (id TEXT PRIMARY KEY);
    INSERT INTO evolution_approval_decisions VALUES ('draft-approval');
    INSERT INTO evolution_canary_releases VALUES (
      'draft-canary', 'draft-user', '["canary-session"]'
    );
    INSERT INTO evolution_promotions VALUES ('draft-promotion');

    CREATE TABLE evolution_auto_configs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
      generator_provider_id TEXT NOT NULL,
      generator_model TEXT NOT NULL,
      replay_provider_id TEXT NOT NULL,
      replay_model TEXT NOT NULL,
      evaluator_provider_id TEXT NOT NULL,
      evaluator_model TEXT NOT NULL,
      session_ids_json TEXT NOT NULL CHECK (
        json_valid(session_ids_json)
        AND json_type(session_ids_json) = 'array'
        AND json_array_length(session_ids_json) BETWEEN 1 AND 10
      ),
      minimum_signal_count INTEGER NOT NULL,
      maximum_source_records INTEGER NOT NULL,
      cooldown_ms INTEGER NOT NULL,
      traffic_percent INTEGER NOT NULL,
      canary_max_outcomes INTEGER NOT NULL,
      canary_max_age_ms INTEGER NOT NULL,
      rollback_policy_json TEXT NOT NULL,
      config_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO evolution_auto_configs VALUES (
      'draft-user', 1, 'prompt:workspace-instructions', 'Preserve the verified scope',
      'generator-provider', 'generator-model', 'replay-provider', 'replay-model',
      'evaluator-provider', 'evaluator-model', '["config-session"]',
      1, 1, 60000, 1, 6, 300000, '{}', 3, 20, 21
    );

    CREATE TABLE evolution_auto_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
      evidence_fingerprint TEXT NOT NULL CHECK (length(evidence_fingerprint) = 64),
      dataset_fingerprint TEXT NOT NULL CHECK (length(dataset_fingerprint) = 64),
      source_record_ids_json TEXT NOT NULL CHECK (
        json_valid(source_record_ids_json) AND json_type(source_record_ids_json) = 'array'
      ),
      source_evidence_ids_json TEXT NOT NULL CHECK (
        json_valid(source_evidence_ids_json) AND json_type(source_evidence_ids_json) = 'array'
      ),
      signal_count INTEGER NOT NULL CHECK (signal_count >= 1),
      signal_cutoff_at INTEGER NOT NULL CHECK (signal_cutoff_at >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'rejected', 'canary_active',
        'validated', 'rolled_back', 'stopped', 'failed'
      )),
      stage TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 120),
      candidate_id TEXT,
      replay_suite_id TEXT,
      replay_id TEXT,
      evaluation_id TEXT,
      approval_id TEXT,
      canary_id TEXT,
      verdict TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (user_id, config_revision, evidence_fingerprint)
    );
  `)

  const insertRun = db.prepare(`
    INSERT INTO evolution_auto_runs (
      id, user_id, config_revision, evidence_fingerprint, dataset_fingerprint,
      source_record_ids_json, source_evidence_ids_json, signal_count,
      signal_cutoff_at, state, stage, candidate_id, replay_suite_id, replay_id,
      evaluation_id, approval_id, canary_id, verdict, error_code, error_message,
      created_at, updated_at, finished_at
    ) VALUES (?, 'draft-user', ?, ?, ?, '[]', '[]', 1, 19, 'queued', 'draft',
      NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, NULL)
  `)
  if (unresolvedSessionScope) {
    insertRun.run('unresolved-run', 4, fingerprint('a'), fingerprint('b'), null, 30, 31)
  } else {
    insertRun.run('config-run', 3, fingerprint('a'), fingerprint('b'), null, 30, 31)
    insertRun.run(
      'canary-run',
      4,
      fingerprint('c'),
      fingerprint('d'),
      'draft-canary',
      32,
      33,
    )
  }
  return db
}

function draftV106DataSnapshot(db) {
  return {
    generations: db.prepare(`
      SELECT plugin_id, last_generation
      FROM runtime_plugin_mutation_barrier_generations ORDER BY plugin_id
    `).all(),
    barriers: db.prepare(`
      SELECT * FROM runtime_plugin_mutation_barriers ORDER BY plugin_id
    `).all(),
    configs: db.prepare('SELECT * FROM evolution_auto_configs ORDER BY user_id').all(),
    runs: db.prepare(`
      SELECT id, user_id, config_revision, evidence_fingerprint,
        dataset_fingerprint, source_record_ids_json,
        source_evidence_ids_json, signal_count, signal_cutoff_at,
        state, stage, candidate_id, replay_suite_id, replay_id,
        evaluation_id, approval_id, canary_id, verdict, error_code,
        error_message, created_at, updated_at, finished_at
      FROM evolution_auto_runs ORDER BY id
    `).all(),
    approvals: db.prepare('SELECT id FROM evolution_approval_decisions ORDER BY id').all(),
    canaries: db.prepare('SELECT * FROM evolution_canary_releases ORDER BY id').all(),
    promotions: db.prepare('SELECT id FROM evolution_promotions ORDER BY id').all(),
  }
}

function draftV106SchemaSnapshot(db) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all()
}

test('v107 repairs a pre-release v106 draft without losing persisted data', () => {
  const db = createV106DraftDatabase()
  try {
    const before = draftV106DataSnapshot(db)

    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      String(LATEST_SCHEMA_VERSION),
    )

    const generations = db.prepare(`
      SELECT plugin_id, last_generation, generation_claimed
      FROM runtime_plugin_mutation_barrier_generations
      ORDER BY plugin_id
    `).all()
    assert.deepEqual(generations, [
      { plugin_id: 'completed-plugin', last_generation: 3, generation_claimed: 1 },
      { plugin_id: 'draft-plugin', last_generation: 7, generation_claimed: 1 },
    ])
    assert.deepEqual(
      db.prepare(`
        SELECT id, session_ids_json, promotion_id
        FROM evolution_auto_runs ORDER BY id
      `).all(),
      [
        { id: 'canary-run', session_ids_json: '["canary-session"]', promotion_id: null },
        { id: 'config-run', session_ids_json: '["config-session"]', promotion_id: null },
      ],
    )
    assert.deepEqual(
      db.prepare(`
        SELECT id, decision_origin, automation_run_id
        FROM evolution_approval_decisions
      `).get(),
      { id: 'draft-approval', decision_origin: 'human_review', automation_run_id: null },
    )
    assert.deepEqual(
      db.prepare(`
        SELECT id, decision_origin, automation_run_id
        FROM evolution_promotions
      `).get(),
      { id: 'draft-promotion', decision_origin: 'human_review', automation_run_id: null },
    )

    db.prepare("UPDATE evolution_auto_runs SET state = 'promoted' WHERE id = 'config-run'").run()
    assert.equal(
      db.prepare("SELECT state FROM evolution_auto_runs WHERE id = 'config-run'").get().state,
      'promoted',
    )
    db.prepare("UPDATE evolution_auto_runs SET state = 'queued' WHERE id = 'config-run'").run()

    assert.deepEqual(draftV106DataSnapshot(db), before)

    const approvalIndex = db.prepare(`
      SELECT "unique" AS isUnique, partial
      FROM pragma_index_list('evolution_approval_decisions')
      WHERE name = 'idx_evolution_approval_automation_run'
    `).get()
    const promotionIndex = db.prepare(`
      SELECT "unique" AS isUnique, partial
      FROM pragma_index_list('evolution_promotions')
      WHERE name = 'idx_evolution_promotion_automation_run'
    `).get()
    assert.deepEqual(approvalIndex, { isUnique: 1, partial: 1 })
    assert.deepEqual(promotionIndex, { isUnique: 1, partial: 1 })
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])

    const schemaAfterFirstRun = draftV106SchemaSnapshot(db)
    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.deepEqual(draftV106SchemaSnapshot(db), schemaAfterFirstRun)
  } finally {
    db.close()
  }
})

test('v107 preserves existing non-null automation run references', () => {
  const db = createV106DraftDatabase()
  try {
    migrateToV106(db)
    db.prepare(`
      UPDATE evolution_approval_decisions
      SET automation_run_id = ?, decision_origin = 'automatic_policy'
      WHERE id = ?
    `).run('config-run', 'draft-approval')
    db.prepare(`
      UPDATE evolution_promotions
      SET automation_run_id = ?, decision_origin = 'automatic_policy'
      WHERE id = ?
    `).run('canary-run', 'draft-promotion')

    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.deepEqual(
      db.prepare(`
        SELECT id, decision_origin, automation_run_id
        FROM evolution_approval_decisions
      `).get(),
      {
        id: 'draft-approval',
        decision_origin: 'automatic_policy',
        automation_run_id: 'config-run',
      },
    )
    assert.deepEqual(
      db.prepare(`
        SELECT id, decision_origin, automation_run_id
        FROM evolution_promotions
      `).get(),
      {
        id: 'draft-promotion',
        decision_origin: 'automatic_policy',
        automation_run_id: 'canary-run',
      },
    )
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('v107 rolls back every write when barrier generations disagree', () => {
  const db = createV106DraftDatabase()
  try {
    db.prepare(`
      UPDATE runtime_plugin_mutation_barrier_generations
      SET last_generation = 8 WHERE plugin_id = 'draft-plugin'
    `).run()
    const beforeSchema = draftV106SchemaSnapshot(db)
    const beforeData = draftV106DataSnapshot(db)

    assert.throws(
      () => runSchemaMigrations(db),
      (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
        && error?.details?.stage === 'migration-v107'
        && error?.details?.missing?.includes('data:runtime_plugin_mutation_barrier_generations')
        && error?.details?.pluginId === 'draft-plugin'
        && error?.details?.barrierGeneration === 7
        && error?.details?.lastGeneration === 8,
    )
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '106')
    assert.deepEqual(draftV106SchemaSnapshot(db), beforeSchema)
    assert.deepEqual(draftV106DataSnapshot(db), beforeData)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('v107 rolls back every write when a draft run session scope cannot be proven', () => {
  const db = createV106DraftDatabase({ unresolvedSessionScope: true })
  try {
    const beforeSchema = draftV106SchemaSnapshot(db)
    const beforeData = draftV106DataSnapshot(db)

    assert.throws(
      () => runSchemaMigrations(db),
      (error) => error?.code === 'DB_SCHEMA_INCOMPLETE'
        && error?.details?.stage === 'migration-v107'
        && error?.details?.missing?.includes('column:evolution_auto_runs.session_ids_json')
        && error?.details?.unresolvedRunId === 'unresolved-run',
    )
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '106')
    assert.deepEqual(draftV106SchemaSnapshot(db), beforeSchema)
    assert.deepEqual(draftV106DataSnapshot(db), beforeData)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('v103 persists a fail-closed plugin mutation barrier across identity and checkpoint writes', () => {
  const db = new Database(':memory:')
  try {
    createRuntimePluginMutationBarrierPrerequisites(db)
    migrateToV103(db)
    migrateToV103(db)

    db.prepare(`
      INSERT INTO runtime_plugin_mutation_barrier_generations (plugin_id, last_generation)
      VALUES ('sample-plugin', 1)
    `).run()
    db.prepare(`
      INSERT INTO runtime_plugin_mutation_barriers (
        plugin_id, token, generation, operation, phase, owner_pid,
        store_revision, created_at, heartbeat_at, recovery_required
      ) VALUES ('sample-plugin', 'token-000000000001', 1, 'uninstall',
        'guarding', 1, NULL, 1, 1, 0)
    `).run()

    for (const statement of [
      "INSERT INTO runtime_plugin_states (plugin_id) VALUES ('sample-plugin')",
      "INSERT INTO runtime_plugin_releases (release_id, plugin_id) VALUES ('release-a', 'sample-plugin')",
      "INSERT INTO runtime_plugin_release_pins (plugin_id, release_id, reference_kind, reference_id) VALUES ('sample-plugin', 'release-a', 'manual', 'ref-a')",
      "INSERT INTO runtime_plugin_permission_grants (plugin_id) VALUES ('sample-plugin')",
    ]) {
      assert.throws(
        () => db.prepare(statement).run(),
        /runtime plugin mutation blocked by package lifecycle barrier/u,
        statement,
      )
    }

    const runtimeReference = JSON.stringify({
      executionEnvironment: {
        runtimePlugins: [{ id: 'sample-plugin', releaseId: 'release-a' }],
        unpinnedPluginIds: [],
      },
    })
    const unpinnedReference = JSON.stringify({
      executionEnvironment: {
        runtimePlugins: [],
        unpinnedPluginIds: ['sample-plugin'],
      },
    })
    for (const [statement, id, payload] of [
      ['INSERT INTO turn_checkpoints (turn_id, state_json) VALUES (?, ?)', 'turn-a', runtimeReference],
      ['INSERT INTO job_turn_checkpoints (step_id, state_json) VALUES (?, ?)', 'step-a', unpinnedReference],
      ['INSERT INTO turn_events (id, payload_json) VALUES (?, ?)', 'event-a', runtimeReference],
      ['INSERT INTO event_write_failures (id, checkpoint_state_json) VALUES (?, ?)', 1, unpinnedReference],
    ]) {
      assert.throws(
        () => db.prepare(statement).run(id, payload),
        /runtime plugin mutation blocked by package lifecycle barrier/u,
        statement,
      )
    }

    assert.equal(
      db.prepare("INSERT INTO runtime_plugin_states (plugin_id) VALUES ('other-plugin')").run().changes,
      1,
    )
    assert.equal(
      db.prepare('INSERT INTO turn_checkpoints (turn_id, state_json) VALUES (?, ?)')
        .run('turn-other', JSON.stringify({
          executionEnvironment: {
            runtimePlugins: [{ id: 'other-plugin' }],
            unpinnedPluginIds: [],
          },
        })).changes,
      1,
    )
  } finally {
    db.close()
  }
})

test('v104 persists immutable plugin mutation recovery receipts', () => {
  const db = new Database(':memory:')
  try {
    migrateToV104(db)
    migrateToV104(db)
    const receipt = {
      receiptId: 'recovery-receipt-0001',
      pluginId: 'sample-plugin',
      generation: 1,
      tokenFingerprint: `sha256-${'a'.repeat(64)}`,
      storeRevision: `sha256-${'b'.repeat(64)}`,
      evidence: JSON.stringify({ packageAbsent: true, runtimeInactive: true }),
    }
    assert.equal(db.prepare(`
      INSERT INTO runtime_plugin_mutation_recovery_receipts (
        receipt_id, plugin_id, generation, operation, token_fingerprint,
        barrier_store_revision, observed_store_revision, evidence_json, verified_at
      ) VALUES (?, ?, ?, 'uninstall', ?, NULL, ?, ?, 100)
    `).run(
      receipt.receiptId,
      receipt.pluginId,
      receipt.generation,
      receipt.tokenFingerprint,
      receipt.storeRevision,
      receipt.evidence,
    ).changes, 1)
    assert.throws(
      () => db.prepare(`
        UPDATE runtime_plugin_mutation_recovery_receipts SET verified_at = 101
        WHERE receipt_id = ?
      `).run(receipt.receiptId),
      /recovery receipts are append-only/u,
    )
    assert.throws(
      () => db.prepare(`
        DELETE FROM runtime_plugin_mutation_recovery_receipts WHERE receipt_id = ?
      `).run(receipt.receiptId),
      /recovery receipts are append-only/u,
    )
  } finally {
    db.close()
  }
})

test('v102 adds nullable post-write identities and keeps legacy snapshots unbound', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES (\'owner-v102\');')
    migrateToV46(db)
    db.prepare(`
      INSERT INTO file_snapshots (
        id, user_id, session_id, turn_id, tool_call_id, tool_name,
        file_path, before_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-v102', 'owner-v102', 'session', 'turn', 'call', 'edit_file', 'file.txt', null, 1)

    migrateToV102(db)
    migrateToV102(db)

    const columns = db.prepare('PRAGMA table_info(file_snapshots)').all().map((row) => row.name)
    for (const column of ['after_exists', 'after_sha256', 'after_bytes', 'finalized_at']) {
      assert.equal(columns.includes(column), true, column)
    }
    assert.deepEqual(
      db.prepare(`
        SELECT after_exists, after_sha256, after_bytes, finalized_at
        FROM file_snapshots WHERE id = 'legacy-v102'
      `).get(),
      { after_exists: null, after_sha256: null, after_bytes: null, finalized_at: null },
    )
    assert.throws(
      () => db.prepare('UPDATE file_snapshots SET after_sha256 = ? WHERE id = ?')
        .run('not-a-digest', 'legacy-v102'),
      /CHECK constraint failed/u,
    )
  } finally {
    db.close()
  }
})

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
  assert.equal(LATEST_SCHEMA_VERSION, 107)
  assert.equal(DB_SCHEMA_VERSION, LATEST_SCHEMA_VERSION)
  assert.equal(schemaMigrations.at(-1).version, LATEST_SCHEMA_VERSION)
})

test('v95 removes only retired account fields and preserves local runtime data', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        credits INTEGER NOT NULL DEFAULT 0,
        mfa_secret TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        package_id TEXT,
        model_name TEXT,
        credits INTEGER NOT NULL,
        balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_ledger_user ON ledger(user_id, created_at);
      CREATE TABLE session_meters (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_session_meters_user ON session_meters(user_id);
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        model_name TEXT,
        credits INTEGER,
        status TEXT NOT NULL
      );
      CREATE INDEX idx_subagent_runs_user ON subagent_runs(user_id);
      CREATE TABLE side_effect_executions (
        owner_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome_json TEXT,
        PRIMARY KEY (owner_id, scope_key, tool_call_id)
      );
      CREATE INDEX idx_side_effect_status ON side_effect_executions(owner_id, status);
      INSERT INTO users VALUES ('owner-v95', 'owner-v95@example.com', 900, 'local-mfa', 1, 2);
      INSERT INTO sessions VALUES ('session-v95', 'owner-v95');
      INSERT INTO ledger VALUES ('ledger-v95', 'owner-v95', 'usage', NULL, 'local-model', 10, 900, 1);
      INSERT INTO session_meters VALUES ('meter-v95', 'owner-v95', 42, 17, 3);
      INSERT INTO subagent_runs VALUES ('run-v95', 'owner-v95', 'local-model', 8, 'completed');
      INSERT INTO side_effect_executions
        VALUES ('owner-v95', 'turn:v95', 'call-v95', 'committed', '{"ok":true}');
    `)
    const sideEffectRows = db.prepare(
      'SELECT * FROM side_effect_executions ORDER BY owner_id, scope_key, tool_call_id',
    ).all()
    const sideEffectSchema = db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE tbl_name = 'side_effect_executions'
      ORDER BY type, name
    `).all()

    migrateToV95(db)
    migrateToV95(db)

    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get(), undefined)
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'credits'), false)
    assert.equal(db.prepare('PRAGMA table_info(session_meters)').all().some((row) => row.name === 'cost_credits'), false)
    assert.equal(db.prepare('PRAGMA table_info(subagent_runs)').all().some((row) => row.name === 'credits'), false)
    assert.deepEqual(
      db.prepare('SELECT id, email, mfa_secret, created_at, updated_at FROM users').get(),
      {
        id: 'owner-v95',
        email: 'owner-v95@example.com',
        mfa_secret: 'local-mfa',
        created_at: 1,
        updated_at: 2,
      },
    )
    assert.deepEqual(db.prepare('SELECT * FROM sessions').get(), {
      token: 'session-v95',
      user_id: 'owner-v95',
    })
    assert.deepEqual(db.prepare('SELECT * FROM session_meters').get(), {
      session_id: 'meter-v95',
      user_id: 'owner-v95',
      tokens_in: 42,
      turns: 3,
    })
    assert.deepEqual(db.prepare('SELECT * FROM subagent_runs').get(), {
      id: 'run-v95',
      user_id: 'owner-v95',
      model_name: 'local-model',
      status: 'completed',
    })
    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_meters_user'").get()), true)
    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_subagent_runs_user'").get()), true)
    assert.deepEqual(
      db.prepare('SELECT * FROM side_effect_executions ORDER BY owner_id, scope_key, tool_call_id').all(),
      sideEffectRows,
    )
    assert.deepEqual(db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE tbl_name = 'side_effect_executions'
      ORDER BY type, name
    `).all(), sideEffectSchema)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db.close()
  }
})

test('v95 rolls back every schema change and version write when a retired column is still referenced', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '94');
      CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0, keep TEXT);
      CREATE TABLE ledger (id TEXT PRIMARY KEY, keep TEXT);
      CREATE TABLE session_meters (
        session_id TEXT PRIMARY KEY,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX block_cost_credit_drop ON session_meters(cost_credits);
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, credits INTEGER, status TEXT);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_suites (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_approval_decisions (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_releases (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_promotions (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('owner', 5, 'user-data');
      INSERT INTO ledger VALUES ('ledger', 'ledger-data');
      INSERT INTO session_meters VALUES ('meter', 6, 7);
      INSERT INTO subagent_runs VALUES ('run', 8, 'complete');
    `)
    createRuntimePluginMutationBarrierPrerequisites(db, { includePermissionGrants: false })

    assert.throws(() => runSchemaMigrations(db), /cost_credits|error in index/u)
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '94')
    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get()), true)
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(session_meters)').all().some((row) => row.name === 'cost_credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(subagent_runs)').all().some((row) => row.name === 'credits'), true)
    assert.deepEqual(db.prepare('SELECT * FROM users').get(), { id: 'owner', credits: 5, keep: 'user-data' })
    assert.deepEqual(db.prepare('SELECT * FROM ledger').get(), { id: 'ledger', keep: 'ledger-data' })

    db.exec('DROP INDEX block_cost_credit_drop')
    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      String(LATEST_SCHEMA_VERSION),
    )
    assert.deepEqual(db.prepare('SELECT * FROM ledger').get(), { id: 'ledger', keep: 'ledger-data' })
  } finally {
    db.close()
  }
})

test('v95 refuses an extended historical ledger instead of deleting plugin-owned data', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '94');
      CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        package_id TEXT,
        model_name TEXT,
        credits INTEGER NOT NULL,
        balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        plugin_payload TEXT
      );
      CREATE INDEX idx_ledger_user ON ledger(user_id, created_at);
      CREATE TABLE session_meters (
        session_id TEXT PRIMARY KEY,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, credits INTEGER, status TEXT);
      INSERT INTO users VALUES ('owner', 11);
      INSERT INTO ledger VALUES ('entry', 'owner', 'usage', NULL, 'model', 2, 9, 1, 'keep-me');
      INSERT INTO session_meters VALUES ('meter', 3, 4);
      INSERT INTO subagent_runs VALUES ('run', 5, 'complete');
    `)

    assert.throws(
      () => runSchemaMigrations(db),
      (error) => error?.code === 'DB_MIGRATION_AMBIGUOUS_RETIRED_LEDGER',
    )
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '94')
    assert.equal(db.prepare('SELECT plugin_payload FROM ledger').get().plugin_payload, 'keep-me')
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(session_meters)').all().some((row) => row.name === 'cost_credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(subagent_runs)').all().some((row) => row.name === 'credits'), true)
  } finally {
    db.close()
  }
})

test('v95 refuses external ledger dependencies before cascading or breaking plugin schema', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '94');
      CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        package_id TEXT,
        model_name TEXT,
        credits INTEGER NOT NULL,
        balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_ledger_user ON ledger(user_id, created_at);
      CREATE TABLE session_meters (
        session_id TEXT PRIMARY KEY,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, credits INTEGER, status TEXT);
      CREATE TABLE plugin_ledger_refs (
        id TEXT PRIMARY KEY,
        ledger_id TEXT REFERENCES ledger(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE plugin_events (ledger_id TEXT NOT NULL);
      CREATE VIEW plugin_ledger_view AS SELECT id, balance FROM ledger;
      CREATE TRIGGER plugin_ledger_trigger AFTER INSERT ON plugin_events BEGIN
        UPDATE ledger SET balance = balance WHERE id = NEW.ledger_id;
      END;
      INSERT INTO users VALUES ('owner', 11);
      INSERT INTO ledger VALUES ('entry', 'owner', 'usage', NULL, 'model', 2, 9, 1);
      INSERT INTO session_meters VALUES ('meter', 3, 4);
      INSERT INTO subagent_runs VALUES ('run', 5, 'complete');
      INSERT INTO plugin_ledger_refs VALUES ('plugin-row', 'entry', 'keep-me');
    `)

    assert.throws(
      () => runSchemaMigrations(db),
      (error) => {
        if (error?.code !== 'DB_MIGRATION_EXTERNAL_LEDGER_DEPENDENCY') return false
        const identities = new Set(error.dependencies?.map((item) => `${item.type}:${item.name}`))
        return identities.has('foreign_key:plugin_ledger_refs')
          && identities.has('view:plugin_ledger_view')
          && identities.has('trigger:plugin_ledger_trigger')
      },
    )
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '94')
    assert.equal(db.prepare('SELECT payload FROM plugin_ledger_refs').get().payload, 'keep-me')
    assert.equal(db.prepare('SELECT balance FROM plugin_ledger_view').get().balance, 9)
    assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'plugin_ledger_trigger'").get()), true)
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'credits'), true)
  } finally {
    db.close()
  }
})

test('v95 schema changes and version advancement roll back together when the version write fails', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '94');
      CREATE TRIGGER block_v95_schema_version BEFORE UPDATE OF value ON meta
      WHEN OLD.key = 'schema_version' AND NEW.value = '95'
      BEGIN
        SELECT RAISE(ABORT, 'blocked schema version');
      END;
      CREATE TABLE users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ledger (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        package_id TEXT,
        model_name TEXT,
        credits INTEGER NOT NULL,
        balance INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_ledger_user ON ledger(user_id, created_at);
      CREATE TABLE session_meters (
        session_id TEXT PRIMARY KEY,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY, credits INTEGER, status TEXT);
      INSERT INTO users VALUES ('owner', 11);
      INSERT INTO ledger VALUES ('entry', 'owner', 'usage', NULL, 'model', 2, 9, 1);
      INSERT INTO session_meters VALUES ('meter', 3, 4);
      INSERT INTO subagent_runs VALUES ('run', 5, 'complete');
    `)

    assert.throws(() => runSchemaMigrations(db), /blocked schema version/u)
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '94')
    assert.equal(db.prepare('SELECT balance FROM ledger').get().balance, 9)
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(session_meters)').all().some((row) => row.name === 'cost_credits'), true)
    assert.equal(db.prepare('PRAGMA table_info(subagent_runs)').all().some((row) => row.name === 'credits'), true)
  } finally {
    db.close()
  }
})

test('v94 creates an idempotent durable outbox without a session foreign key', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('owner-v94');
    `)
    migrateToV94(db)
    migrateToV94(db)
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(session_content_outbox)').all()
    assert.deepEqual(foreignKeys.map((row) => row.table), ['users'])
    assert.throws(() => db.prepare(`
      INSERT INTO session_content_outbox (
        event_id, user_id, session_id, event_type, payload_json, event_fingerprint,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'unsupported', '{}', ?, 1, 1, 1)
    `).run('event-v94', 'owner-v94', 'deleted-session', 'a'.repeat(64)))
  } finally {
    db.close()
  }
})

test('v93 backfills durable turn execution fencing tokens idempotently', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO users (id) VALUES ('owner-v93');
      INSERT INTO sessions (token, user_id) VALUES ('session-v93', 'owner-v93');
    `)
    migrateToV43(db)
    migrateToV44(db)
    db.prepare(`
      INSERT INTO turn_execution_leases (
        user_id, session_id, turn_id, owner_id, acquired_at, expires_at,
        cancel_requested_at, accepting_steering
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
    `).run('owner-v93', 'session-v93', 'turn-v93', 'worker-v93', 100, 200)

    migrateToV93(db)
    migrateToV93(db)

    assert.deepEqual(
      db.prepare(`
        SELECT fencing_token
        FROM turn_execution_leases
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get('owner-v93', 'session-v93', 'turn-v93'),
      { fencing_token: 1 },
    )
    assert.deepEqual(
      db.prepare(`
        SELECT fencing_token
        FROM turn_execution_fences
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get('owner-v93', 'session-v93', 'turn-v93'),
      { fencing_token: 1 },
    )

    db.prepare(`
      DELETE FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ?
    `).run('owner-v93', 'session-v93', 'turn-v93')
    assert.deepEqual(
      db.prepare(`
        SELECT fencing_token
        FROM turn_execution_fences
        WHERE user_id = ? AND session_id = ? AND turn_id = ?
      `).get('owner-v93', 'session-v93', 'turn-v93'),
      { fencing_token: 1 },
    )
  } finally {
    db.close()
  }
})

test('v92 extends the shared side-effect ledger for request-scoped Hooks without rewriting identities', () => {
  const db = new Database(':memory:')
  try {
    migrateToV79(db)
    db.prepare(`INSERT INTO side_effect_executions (
      owner_id, scope_kind, scope_key, session_id, turn_id, job_id, step_id,
      tool_call_id, idempotency_key, tool_name, args_digest, status,
      created_at, updated_at, prepared_at
    ) VALUES (?, 'job', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'prepared', 1, 1, 1)`)
      .run('owner-v92', '["job","job-v92","step-v92"]', 'job-v92', 'step-v92',
        'call-v92', 'idem-v92', 'write_file', 'a'.repeat(64))

    migrateToV92(db)
    migrateToV92(db)

    const columns = new Set(db.prepare('PRAGMA table_info(side_effect_executions)').all().map((row) => row.name))
    assert.equal(columns.has('request_id'), true)
    assert.equal(columns.has('effect_kind'), true)
    assert.deepEqual(
      db.prepare('SELECT tool_call_id, idempotency_key, effect_kind, request_id FROM side_effect_executions').get(),
      { tool_call_id: 'call-v92', idempotency_key: 'idem-v92', effect_kind: 'tool', request_id: null },
    )
    db.prepare(`INSERT INTO side_effect_executions (
      owner_id, scope_kind, scope_key, request_id, effect_kind, tool_call_id,
      idempotency_key, tool_name, args_digest, status, created_at, updated_at, prepared_at
    ) VALUES (?, 'request', ?, ?, 'hook', ?, ?, ?, ?, 'prepared', 2, 2, 2)`)
      .run('owner-v92', '["request","request-v92"]', 'request-v92', 'hook-call-v92',
        'hook-idem-v92', 'hook:pre_tool_use:http', 'b'.repeat(64))
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM side_effect_executions WHERE effect_kind = 'hook'").get().count,
      1,
    )
  } finally {
    db.close()
  }
})

test('v88 persists fenced, idempotent evolution operations with user cleanup', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('user-1');")
    migrateToV88(db)
    migrateToV88(db)
    const requestFingerprint = 'a'.repeat(64)
    db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'prepared', '{}', ?, ?)
    `).run('operation-1', 'user-1', 'replay', 'retry-key', requestFingerprint, '{}', 1, 1)
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'prepared', '{}', ?, ?)
    `).run('operation-2', 'user-1', 'replay', 'retry-key', requestFingerprint, '{}', 2, 2),
    /UNIQUE constraint failed/)
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', 'model_call', '{}', ?, ?)
    `).run('operation-unfenced', 'user-1', 'candidate', 'unfenced', requestFingerprint, '{}', 2, 2),
    /CHECK constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_operations').get().count, 0)
  } finally {
    db.close()
  }
})

test('v89 adds durable leases and treats legacy running operations as expired', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('user-1');")
    migrateToV88(db)
    const requestFingerprint = 'b'.repeat(64)
    db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, worker_token, created_at, updated_at
      ) VALUES (?, ?, 'candidate', ?, ?, '{}', 'running', 'model_call', '{}', ?, 10, 9999999999999)
    `).run('legacy-running', 'user-1', 'legacy-running-key', requestFingerprint, 'legacy-token')

    migrateToV89(db)
    migrateToV89(db)
    const row = db.prepare(`
      SELECT lease_owner_id, lease_expires_at
      FROM evolution_operations WHERE id = 'legacy-running'
    `).get()
    assert.equal(row.lease_owner_id, 'legacy:legacy-token')
    assert.equal(row.lease_expires_at, 0)
    assert.throws(() => db.prepare(`
      UPDATE evolution_operations
      SET state = 'pending', worker_token = NULL
      WHERE id = 'legacy-running'
    `).run(), /invalid evolution operation lease state/)
  } finally {
    db.close()
  }
})

test('v90 backfills one durable recovery challenge and enforces its state invariant', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('user-1');")
    migrateToV88(db)
    migrateToV89(db)
    const requestFingerprint = 'c'.repeat(64)
    const insert = db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, created_at, updated_at
      ) VALUES (?, 'user-1', 'candidate', ?, ?, '{}', ?, ?, '{}', 10, 20)
    `)
    insert.run(
      'legacy-blocked',
      'legacy-blocked-key',
      requestFingerprint,
      'blocked',
      'model_outcome_unknown',
    )
    insert.run('legacy-pending', 'legacy-pending-key', requestFingerprint, 'pending', 'prepared')

    migrateToV90(db)
    const first = db.prepare(`
      SELECT recovery_challenge, recovery_revision
      FROM evolution_operations WHERE id = 'legacy-blocked'
    `).get()
    assert.match(first.recovery_challenge, /^[0-9a-f-]{36}$/u)
    assert.equal(first.recovery_revision, 1)

    migrateToV90(db)
    const repeated = db.prepare(`
      SELECT recovery_challenge, recovery_revision
      FROM evolution_operations WHERE id = 'legacy-blocked'
    `).get()
    assert.deepEqual(repeated, first)
    assert.deepEqual(
      db.prepare(`
        SELECT recovery_challenge, recovery_revision
        FROM evolution_operations WHERE id = 'legacy-pending'
      `).get(),
      { recovery_challenge: null, recovery_revision: 0 },
    )
    assert.throws(() => db.prepare(`
      UPDATE evolution_operations SET recovery_challenge = ? WHERE id = 'legacy-pending'
    `).run(randomUUID()), /invalid evolution operation recovery state/)
    assert.throws(() => db.prepare(`
      UPDATE evolution_operations SET recovery_challenge = NULL WHERE id = 'legacy-blocked'
    `).run(), /invalid evolution operation recovery state/)
  } finally {
    db.close()
  }
})

test('v84 persists deterministic config reviews and one immutable apply/reversal chain', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
    `)
    migrateToV84(db)
    migrateToV84(db)
    for (const table of [
      'evolution_config_replays',
      'evolution_config_evaluations',
      'evolution_config_approval_decisions',
      'evolution_config_change_events',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
    }
    const digest = (character) => character.repeat(64)
    db.prepare(`
      INSERT INTO evolution_config_replays (
        id, user_id, candidate_id, baseline_document_json, proposed_document_json,
        baseline_document_sha256, proposed_document_sha256,
        baseline_effective_sha256, proposed_effective_sha256,
        isolation_mode, report_json, run_fingerprint, created_at
      ) VALUES ('replay-1', 'user-1', 'candidate-1', '{}', '{}', ?, ?, ?, ?,
        'config_parse_no_side_effects', '{}', ?, 1)
    `).run(digest('a'), digest('b'), digest('c'), digest('d'), digest('e'))
    db.prepare(`
      INSERT INTO evolution_config_evaluations (
        id, user_id, replay_id, candidate_id, policy_version, verdict, summary,
        issues_json, metrics_json, evaluation_fingerprint, created_at
      ) VALUES ('evaluation-1', 'user-1', 'replay-1', 'candidate-1', 'v1', 'pass',
        'accepted', '[]', '{}', ?, 2)
    `).run(digest('f'))
    db.prepare(`
      INSERT INTO evolution_config_approval_decisions (
        id, user_id, evaluation_id, replay_id, candidate_id, decision, reason,
        candidate_sha256, replay_fingerprint, evaluation_fingerprint,
        baseline_document_sha256, proposed_document_sha256, review_snapshot_json,
        approver_mode, decision_fingerprint, created_at
      ) VALUES ('approval-1', 'user-1', 'evaluation-1', 'replay-1', 'candidate-1',
        'approved', 'reviewed', ?, ?, ?, ?, ?, '{}', 'local_owner_loopback', ?, 3)
    `).run(digest('g'), digest('e'), digest('f'), digest('a'), digest('b'), digest('h'))
    const insertEvent = db.prepare(`
      INSERT INTO evolution_config_change_events (
        id, user_id, approval_id, candidate_id, root_apply_id, operation,
        before_document_json, after_document_json,
        before_document_sha256, after_document_sha256, expected_current_sha256,
        reason, confirmation_sha256, event_fingerprint, created_at
      ) VALUES (?, 'user-1', 'approval-1', 'candidate-1', ?, ?, '{}', '{}', ?, ?, ?,
        'reviewed', ?, ?, ?)
    `)
    insertEvent.run('apply-1', null, 'apply', digest('a'), digest('b'), digest('a'), digest('i'), digest('j'), 4)
    assert.throws(
      () => insertEvent.run('apply-2', null, 'apply', digest('a'), digest('b'), digest('a'), digest('i'), digest('k'), 5),
      /UNIQUE constraint failed/,
    )
    insertEvent.run('rollback-1', 'apply-1', 'rollback', digest('b'), digest('a'), digest('b'), digest('l'), digest('m'), 6)
    assert.throws(
      () => insertEvent.run('revoke-1', 'apply-1', 'revoke', digest('b'), digest('a'), digest('b'), digest('n'), digest('o'), 7),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () => insertEvent.run('bad-1', null, 'publish', digest('a'), digest('b'), digest('a'), digest('p'), digest('q'), 8),
      /CHECK constraint failed/,
    )
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_config_replays').get().count, 0)
  } finally {
    db.close()
  }
})

test('v83 opts production monitoring out by default and persists promotion grading provenance', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_releases (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_assignments (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_outcomes (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_promotion_assignments (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_promotion_outcomes (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_promotions (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_rollbacks (id TEXT PRIMARY KEY);
    `)
    migrateToV82(db)
    migrateToV83(db)
    migrateToV83(db)

    const policyColumn = db.prepare(`
      SELECT * FROM pragma_table_info('evolution_canary_grader_policies')
      WHERE name = 'production_monitoring_enabled'
    `).get()
    assert.equal(policyColumn.notnull, 1)
    assert.equal(String(policyColumn.dflt_value), '0')
    for (const table of [
      'evolution_promotion_outcome_snapshots',
      'evolution_promotion_online_grades',
      'evolution_promotion_online_guard_evaluations',
      'evolution_promotion_rollbacks',
    ]) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        table,
      )
    }
  } finally {
    db.close()
  }
})

test('v82 persists immutable online grader policy, per-outcome evidence, and guard provenance', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_releases (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_assignments (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_outcomes (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_rollback_evaluations (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_rollback_policies (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_promotions (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_canary_rollbacks (
        id TEXT PRIMARY KEY,
        evaluation_id TEXT REFERENCES evolution_canary_rollback_evaluations(id)
      );
    `)
    migrateToV82(db)
    migrateToV82(db)
    for (const table of [
      'evolution_canary_grader_policies',
      'evolution_canary_outcome_snapshots',
      'evolution_canary_online_grades',
      'evolution_canary_online_guard_evaluations',
    ]) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.[1],
        1,
        table,
      )
    }
    const rollbackColumns = new Set(
      db.prepare('PRAGMA table_info(evolution_canary_rollbacks)').all().map((column) => column.name),
    )
    assert.equal(rollbackColumns.has('online_guard_evaluation_id'), true)
    const promotionColumns = new Set(
      db.prepare('PRAGMA table_info(evolution_promotions)').all().map((column) => column.name),
    )
    assert.equal(promotionColumns.has('online_grader_policy_fingerprint'), true)
    assert.equal(promotionColumns.has('online_guard_evaluation_fingerprint'), true)
  } finally {
    db.close()
  }
})

test('v81 persists immutable production promotions, active pointers, assignments, and outcomes', () => {
  const db = new Database(':memory:')
  try {
    migrateToV81(db)
    migrateToV81(db)
    for (const table of [
      'evolution_promotions',
      'evolution_promotion_events',
      'evolution_active_promotions',
      'evolution_promotion_assignments',
      'evolution_promotion_outcomes',
    ]) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        table,
      )
    }
    const promotionColumns = new Set(
      db.prepare('PRAGMA table_info(evolution_promotions)').all().map((column) => column.name),
    )
    for (const column of [
      'candidate_content',
      'rollback_policy_fingerprint',
      'promotion_fingerprint',
    ]) assert.equal(promotionColumns.has(column), true, column)
    const assignmentColumns = new Set(
      db.prepare('PRAGMA table_info(evolution_promotion_assignments)').all()
        .map((column) => column.name),
    )
    assert.equal(assignmentColumns.has('prompt_content'), true)
    assert.equal(assignmentColumns.has('promotion_fingerprint'), true)
  } finally {
    db.close()
  }
})

test('v80 separates recovery intent and operator audit from replay outcomes', () => {
  const db = new Database(':memory:')
  try {
    migrateToV79(db)
    migrateToV80(db)
    migrateToV80(db)
    const columns = new Set(db.prepare('PRAGMA table_info(side_effect_executions)').all()
      .map((column) => column.name))
    assert.equal(columns.has('intent_json'), true)
    assert.equal(columns.has('audit_json'), true)
  } finally {
    db.close()
  }
})

test('v96 adds nullable recovery plans without rewriting existing side-effect rows', () => {
  const db = new Database(':memory:')
  try {
    migrateToV79(db)
    migrateToV92(db)
    const insert = db.prepare(`INSERT INTO side_effect_executions (
      owner_id, scope_kind, scope_key, job_id, step_id, tool_call_id,
      idempotency_key, tool_name, args_digest, status, outcome_json,
      created_at, updated_at, prepared_at, executing_at, finished_at
    ) VALUES (?, 'job', ?, ?, ?, ?, ?, 'write_file', ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertRows = db.transaction(() => {
      for (let index = 0; index < 239; index += 1) {
        const timestamp = index + 1
        const terminal = index % 2 === 0
        insert.run(
          `owner-${index % 3}`,
          `job:${index}`,
          `job-${index}`,
          `step-${index}`,
          `call-${index}`,
          `key-${index}`,
          String(index).padStart(64, '0'),
          terminal ? 'committed' : 'executing',
          terminal ? JSON.stringify({ ok: true, index }) : null,
          timestamp,
          timestamp,
          timestamp,
          terminal ? timestamp : timestamp,
          terminal ? timestamp : null,
        )
      }
    })
    insertRows()
    const before = db.prepare(`SELECT owner_id, scope_key, tool_call_id, status, outcome_json
      FROM side_effect_executions ORDER BY scope_key`).all()

    migrateToV96(db)
    migrateToV96(db)

    const columns = db.prepare('PRAGMA table_info(side_effect_executions)').all()
      .filter((column) => column.name === 'recovery_json')
    assert.equal(columns.length, 1)
    assert.equal(columns[0].notnull, 0)
    assert.deepEqual(
      db.prepare(`SELECT owner_id, scope_key, tool_call_id, status, outcome_json
        FROM side_effect_executions ORDER BY scope_key`).all(),
      before,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM side_effect_executions WHERE recovery_json IS NULL').get().count,
      239,
    )
  } finally {
    db.close()
  }
})

test('v97 adds nullable file metadata without rewriting legacy compaction archives', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE compaction_archive (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        replaced_message_count INTEGER NOT NULL,
        archived_messages_json TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO compaction_archive VALUES (
        'legacy-archive', 'owner-a', 'session-a', 1,
        '[{"role":"user","content":"legacy body"}]', 'summary', 7
      );
    `)

    migrateToV97(db)
    migrateToV97(db)

    const columns = new Set(db.prepare('PRAGMA table_info(compaction_archive)').all()
      .map((column) => column.name))
    for (const column of ['storage_path', 'size_bytes', 'sha256']) {
      assert.equal(columns.has(column), true, column)
    }
    assert.deepEqual(db.prepare(`
      SELECT archived_messages_json, storage_path, size_bytes, sha256
      FROM compaction_archive WHERE id = 'legacy-archive'
    `).get(), {
      archived_messages_json: '[{"role":"user","content":"legacy body"}]',
      storage_path: null,
      size_bytes: null,
      sha256: null,
    })
    const insertFileBacked = db.prepare(`
      INSERT INTO compaction_archive (
        id, user_id, session_id, replaced_message_count,
        archived_messages_json, summary_text, created_at, storage_path
      ) VALUES (?, ?, ?, 0, '[]', '', 8, 'v1/shared.json')
    `)
    insertFileBacked.run('first-file', 'owner-b', 'session-b')
    assert.throws(
      () => insertFileBacked.run('second-file', 'owner-c', 'session-c'),
      /UNIQUE constraint failed/u,
    )
  } finally {
    db.close()
  }
})

test('v98 creates idempotent user-owned managed attachment upload leases', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('upload-owner');
    `)

    migrateToV98(db)
    migrateToV98(db)

    assert.deepEqual(
      db.prepare('PRAGMA table_info(managed_attachment_upload_leases)').all()
        .map((column) => column.name),
      [
        'upload_id',
        'user_id',
        'lease_owner',
        'lease_pid',
        'lease_expires_at',
        'created_at',
        'updated_at',
      ],
    )
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(managed_attachment_upload_leases)').all()
        .map((foreignKey) => ({ table: foreignKey.table, from: foreignKey.from, onDelete: foreignKey.on_delete })),
      [{ table: 'users', from: 'user_id', onDelete: 'CASCADE' }],
    )
    assert.ok(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_managed_attachment_upload_leases_user'
    `).get())

    db.prepare(`
      INSERT INTO managed_attachment_upload_leases
        (upload_id, user_id, lease_owner, lease_pid, lease_expires_at, created_at, updated_at)
      VALUES ('upload-v98', 'upload-owner', 'worker-v98', 123, 300, 100, 100)
    `).run()
    assert.throws(() => db.prepare(`
      INSERT INTO managed_attachment_upload_leases
        (upload_id, user_id, lease_owner, lease_pid, lease_expires_at, created_at, updated_at)
      VALUES ('bad-pid-v98', 'upload-owner', 'worker-v98', 0, 300, 100, 100)
    `).run(), /CHECK constraint failed/u)
    db.prepare("DELETE FROM users WHERE id = 'upload-owner'").run()
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM managed_attachment_upload_leases').get().count,
      0,
    )
  } finally {
    db.close()
  }
})

test('v99 extends legacy user-data clear journals with constrained compaction governance metadata', () => {
  const db = new Database(':memory:')
  try {
    migrateToV77(db)
    db.prepare(`INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-clear', 'legacy-owner', 'legacy-lease', 123, 1_000, 'staging', 10, 10)

    migrateToV99(db)
    migrateToV99(db)

    assert.deepEqual(
      db.prepare('PRAGMA table_info(user_data_clear_operations)').all()
        .map((column) => column.name),
      [
        'operation_id',
        'owner_id',
        'lease_owner',
        'lease_pid',
        'lease_expires_at',
        'status',
        'created_at',
        'updated_at',
        'operation_kind',
        'session_id',
        'compaction_port_id',
        'compaction_governance_version',
        'compaction_digest',
        'compaction_stage_token',
      ],
    )
    assert.deepEqual(db.prepare(`
      SELECT operation_kind, session_id, compaction_port_id,
        compaction_governance_version, compaction_digest, compaction_stage_token
      FROM user_data_clear_operations WHERE operation_id = 'legacy-clear'
    `).get(), {
      operation_kind: 'user_clear',
      session_id: null,
      compaction_port_id: null,
      compaction_governance_version: null,
      compaction_digest: null,
      compaction_stage_token: null,
    })
    assert.ok(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_user_data_clear_operations_status'
    `).get())

    const insert = db.prepare(`INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at, operation_kind, session_id,
      compaction_port_id, compaction_governance_version,
      compaction_digest, compaction_stage_token
    ) VALUES (
      @operationId, @ownerId, 'lease-v99', 456, 2_000,
      'staging', 20, 20, @operationKind, @sessionId,
      @portId, @governanceVersion, @digest, @stageToken
    )`)
    let sequence = 0
    const values = (overrides = {}) => {
      sequence += 1
      return {
        operationId: `operation-v99-${sequence}`,
        ownerId: `owner-v99-${sequence}`,
        operationKind: 'user_clear',
        sessionId: null,
        portId: null,
        governanceVersion: null,
        digest: null,
        stageToken: null,
        ...overrides,
      }
    }
    const digest = 'a'.repeat(64)
    insert.run(values({
      operationKind: 'session_delete',
      sessionId: 'session-v99',
      portId: 'builtin.sqlite-file',
      governanceVersion: 1,
      digest,
      stageToken: 'stage-v99',
    }))

    for (const invalid of [
      { operationKind: 'unknown' },
      { operationKind: 'user_clear', sessionId: 'session-v99' },
      { operationKind: 'session_delete', sessionId: null },
      { operationKind: 'session_delete', sessionId: ' session-v99 ' },
      { governanceVersion: 0 },
      { governanceVersion: 1.5 },
      { digest: 'a'.repeat(63) },
      { digest: 'A'.repeat(64) },
      { digest: `${'a'.repeat(63)}g` },
      { portId: ' ' },
      { stageToken: ' stage-v99 ' },
    ]) {
      assert.throws(() => insert.run(values(invalid)), /CHECK constraint failed/u)
    }
  } finally {
    db.close()
  }
})

test('v100 persists exact runtime plugin permission grants with strict ownership cleanup', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    migrateToV60(db)
    migrateToV100(db)
    migrateToV100(db)
    db.prepare(`
      INSERT INTO runtime_plugin_states (plugin_id, enabled, updated_at)
      VALUES ('permission-test', 0, 1)
    `).run()

    const approvalDigest = `sha256-${'a'.repeat(64)}`
    const sourceDigest = `sha256-${'b'.repeat(64)}`
    db.prepare(`
      INSERT INTO runtime_plugin_permission_grants (
        plugin_id, approval_digest, source_digest, permissions_json, granted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('permission-test', approvalDigest, sourceDigest, '["runtime:tool"]', 10, 10)
    assert.deepEqual(db.prepare(`
      SELECT plugin_id, approval_digest, source_digest, permissions_json, granted_at, updated_at
      FROM runtime_plugin_permission_grants
    `).get(), {
      plugin_id: 'permission-test',
      approval_digest: approvalDigest,
      source_digest: sourceDigest,
      permissions_json: '["runtime:tool"]',
      granted_at: 10,
      updated_at: 10,
    })
    assert.ok(db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_runtime_plugin_permission_grants_updated'
    `).get())
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(runtime_plugin_permission_grants)').all()
      .map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete })), [{
      table: 'runtime_plugin_states',
      from: 'plugin_id',
      to: 'plugin_id',
      onDelete: 'CASCADE',
    }])

    for (const invalid of [
      { column: 'approval_digest', value: `sha256-${'a'.repeat(63)}` },
      { column: 'approval_digest', value: `sha256-${'A'.repeat(64)}` },
      { column: 'source_digest', value: `sha256-${'g'.repeat(64)}` },
      { column: 'granted_at', value: -1 },
      { column: 'updated_at', value: 9 },
    ]) {
      assert.throws(
        () => db.prepare(`UPDATE runtime_plugin_permission_grants SET ${invalid.column} = ?`).run(invalid.value),
        /CHECK constraint failed/u,
      )
    }

    db.prepare("DELETE FROM runtime_plugin_states WHERE plugin_id = 'permission-test'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_plugin_permission_grants').get().count, 0)
  } finally {
    db.close()
  }
})

test('v101 binds runtime plugin grants to an owner and drops ambiguous v100 consent', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    migrateToV60(db)
    migrateToV100(db)
    db.prepare(`
      INSERT INTO runtime_plugin_states (plugin_id, enabled, updated_at)
      VALUES ('permission-owner-test', 0, 1)
    `).run()
    db.prepare(`
      INSERT INTO runtime_plugin_permission_grants (
        plugin_id, approval_digest, source_digest, permissions_json, granted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'permission-owner-test',
      `sha256-${'a'.repeat(64)}`,
      `sha256-${'b'.repeat(64)}`,
      '["runtime:tool"]',
      10,
      10,
    )

    migrateToV101(db)

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_plugin_permission_grants').get().count, 0)
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_plugin_permission_grants_v100'").get(),
      undefined,
    )
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_list(runtime_plugin_permission_grants)').all()
        .map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete }))
        .sort((left, right) => left.from.localeCompare(right.from)),
      [
        { table: 'users', from: 'owner_id', to: 'id', onDelete: 'CASCADE' },
        { table: 'runtime_plugin_states', from: 'plugin_id', to: 'plugin_id', onDelete: 'CASCADE' },
      ],
    )
    for (const indexName of [
      'idx_runtime_plugin_permission_grants_owner',
      'idx_runtime_plugin_permission_grants_updated',
    ]) {
      assert.ok(db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?
      `).get(indexName), indexName)
    }

    db.prepare(`
      INSERT INTO users (id, email, created_at, updated_at)
      VALUES ('owner-v101', 'owner-v101@example.test', 1, 1)
    `).run()
    const insertGrant = db.prepare(`
      INSERT INTO runtime_plugin_permission_grants (
        plugin_id, owner_id, approval_digest, source_digest,
        permissions_json, granted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    assert.throws(
      () => insertGrant.run(
        'permission-owner-test',
        'missing-owner',
        `sha256-${'c'.repeat(64)}`,
        `sha256-${'d'.repeat(64)}`,
        '["runtime:tool"]',
        20,
        20,
      ),
      /FOREIGN KEY constraint failed/u,
    )

    insertGrant.run(
      'permission-owner-test',
      'owner-v101',
      `sha256-${'c'.repeat(64)}`,
      `sha256-${'d'.repeat(64)}`,
      '["runtime:tool","sandbox:fs"]',
      20,
      20,
    )
    migrateToV101(db)
    assert.deepEqual(db.prepare(`
      SELECT plugin_id, owner_id, permissions_json, granted_at, updated_at
      FROM runtime_plugin_permission_grants
    `).get(), {
      plugin_id: 'permission-owner-test',
      owner_id: 'owner-v101',
      permissions_json: '["runtime:tool","sandbox:fs"]',
      granted_at: 20,
      updated_at: 20,
    })

    for (const permissionsJson of [
      'not-json',
      '{}',
      '[]',
      JSON.stringify(Array.from({ length: 65 }, (_, index) => `permission:${index}`)),
      '[1]',
      '["Runtime:tool"]',
      '[" leading-space"]',
      `["${'a'.repeat(129)}"]`,
    ]) {
      assert.throws(
        () => db.prepare(`
          UPDATE runtime_plugin_permission_grants SET permissions_json = ?
          WHERE plugin_id = 'permission-owner-test'
        `).run(permissionsJson),
        /(CHECK constraint failed|invalid runtime plugin permission identifier|malformed JSON)/u,
        permissionsJson,
      )
    }

    db.prepare("DELETE FROM users WHERE id = 'owner-v101'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runtime_plugin_permission_grants').get().count, 0)
  } finally {
    db.close()
  }
})

test('v79 persists scoped side-effect execution identities and guarded states', () => {
  const db = new Database(':memory:')
  try {
    migrateToV79(db)
    migrateToV79(db)
    const columns = new Set(db.prepare('PRAGMA table_info(side_effect_executions)').all()
      .map((column) => column.name))
    for (const column of [
      'owner_id', 'scope_kind', 'scope_key', 'session_id', 'turn_id', 'job_id', 'step_id',
      'tool_call_id', 'idempotency_key', 'tool_name', 'args_digest', 'status', 'outcome_json',
    ]) assert.equal(columns.has(column), true, column)

    db.prepare(`INSERT INTO side_effect_executions (
      owner_id, scope_kind, scope_key, job_id, step_id, tool_call_id,
      idempotency_key, tool_name, args_digest, status,
      created_at, updated_at, prepared_at
    ) VALUES (?, 'job', ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, 1, 1)`)
      .run('owner-a', 'job:one', 'job-a', 'step-a', 'call-a', 'key-a', 'bash_exec', 'digest-a')
    assert.throws(
      () => db.prepare("UPDATE side_effect_executions SET status = 'complete' WHERE tool_call_id = 'call-a'").run(),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v74-v75 persist immutable runtime plugin releases and revisioned authoritative pointers', () => {
  const db = new Database(':memory:')
  try {
    migrateToV60(db)
    migrateToV74(db)
    migrateToV74(db)
    migrateToV75(db)
    migrateToV75(db)

    const stateColumns = new Set(db.prepare('PRAGMA table_info(runtime_plugin_states)').all().map((row) => row.name))
    for (const column of [
      'active_release_id',
      'previous_release_id',
      'release_revision',
      'last_rollback_status',
      'last_rollback_from_release_id',
      'last_rollback_to_release_id',
      'last_rollback_reason',
      'last_rollback_at',
    ]) assert.equal(stateColumns.has(column), true, column)

    db.prepare(`INSERT INTO runtime_plugin_releases (
      release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
      validation_status, health_status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'passed', 'passed', ?)`)
      .run('rel-test', 'test-transformer', `sha256-${'a'.repeat(64)}`, 'source', '{"id":"test-transformer"}', 10)

    assert.throws(
      () => db.prepare('UPDATE runtime_plugin_releases SET source_text = ? WHERE release_id = ?')
        .run('mutated', 'rel-test'),
      /immutable/,
    )
    assert.throws(
      () => db.prepare('DELETE FROM runtime_plugin_releases WHERE release_id = ?').run('rel-test'),
      /immutable/,
    )
    assert.throws(
      () => db.prepare(`INSERT INTO runtime_plugin_releases (
        release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
        validation_status, health_status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'passed', 'passed', ?)`)
        .run('rel-test', 'test-transformer', `sha256-${'a'.repeat(64)}`, 'source', '{"id":"test-transformer"}', 12),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () => db.prepare(`INSERT INTO runtime_plugin_releases (
        release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
        validation_status, health_status, created_at
      ) VALUES ('rel-invalid', 'test-transformer', ?, 'source', '{}', 'passed', 'unknown', 11)`)
        .run(`sha256-${'b'.repeat(64)}`),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v76 backfills complete release identities without trusting damaged legacy capabilities', () => {
  const db = new Database(':memory:')
  try {
    migrateToV60(db)
    migrateToV74(db)
    migrateToV75(db)
    const source = "function transform(input) { return input }"
    const sourceDigest = `sha256-${createHash('sha256').update(source).digest('hex')}`
    const snapshot = {
      id: 'test-transformer',
      name: 'Test Transformer',
      version: '1.0.0',
      type: 'transformer',
      description: '',
      requires: [],
      contributes: [],
      capabilities: [],
    }
    const insert = db.prepare(`INSERT INTO runtime_plugin_releases (
      release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
      validation_status, health_status, created_at
    ) VALUES (?, 'test-transformer', ?, ?, ?, 'passed', 'passed', ?)`)
    insert.run('rel-valid-legacy', sourceDigest, source, JSON.stringify(snapshot), 10)
    insert.run(
      'rel-damaged-capabilities',
      sourceDigest,
      source,
      JSON.stringify({ ...snapshot, capabilities: ['fetch'] }),
      11,
    )

    migrateToV76(db)
    migrateToV76(db)

    const columns = new Set(db.prepare('PRAGMA table_info(runtime_plugin_releases)').all()
      .map((column) => column.name))
    assert.equal(columns.has('release_content_digest'), true)
    assert.equal(columns.has('digest_version'), true)
    assert.match(
      db.prepare('SELECT release_content_digest FROM runtime_plugin_releases WHERE release_id = ?')
        .get('rel-valid-legacy').release_content_digest,
      /^sha256-[a-f0-9]{64}$/,
    )
    assert.deepEqual(
      db.prepare(`SELECT release_content_digest, digest_version
        FROM runtime_plugin_releases WHERE release_id = ?`).get('rel-damaged-capabilities'),
      { release_content_digest: null, digest_version: 0 },
    )
    assert.throws(
      () => db.prepare('UPDATE runtime_plugin_releases SET source_text = ? WHERE release_id = ?')
        .run('mutated', 'rel-valid-legacy'),
      /immutable/,
    )
  } finally {
    db.close()
  }
})

test('v77 persists one leased recoverable user-data clear operation per owner', () => {
  const db = new Database(':memory:')
  try {
    migrateToV77(db)
    migrateToV77(db)
    const columns = new Set(db.prepare('PRAGMA table_info(user_data_clear_operations)').all()
      .map((column) => column.name))
    for (const column of [
      'operation_id',
      'owner_id',
      'lease_owner',
      'lease_pid',
      'lease_expires_at',
      'status',
      'created_at',
      'updated_at',
    ]) assert.equal(columns.has(column), true, column)

    db.prepare(`INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('operation-a', 'owner-a', 'lease-a', 123, 1_000, 'staging', 10, 10)
    assert.throws(
      () => db.prepare(`INSERT INTO user_data_clear_operations (
        operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('operation-b', 'owner-a', 'lease-b', 456, 2_000, 'staging', 20, 20),
      /UNIQUE constraint failed/,
    )
    assert.throws(
      () => db.prepare(`INSERT INTO user_data_clear_operations (
        operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('operation-c', 'owner-c', 'lease-c', 789, 3_000, 'unknown', 30, 30),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v78 permits only guarded deletion of unreferenced runtime plugin releases', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  try {
    migrateToV60(db)
    migrateToV74(db)
    migrateToV75(db)
    migrateToV76(db)
    migrateToV78(db)
    migrateToV78(db)

    const source = 'function transform(input) { return input }'
    const digest = `sha256-${createHash('sha256').update(source).digest('hex')}`
    const snapshot = JSON.stringify({
      id: 'retention-transformer',
      name: 'Retention Transformer',
      version: '1.0.0',
      type: 'transformer',
      description: '',
      requires: [],
      contributes: [],
      capabilities: [],
    })
    const insertRelease = db.prepare(`
      INSERT INTO runtime_plugin_releases (
        release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
        validation_status, health_status, created_at
      ) VALUES (?, 'retention-transformer', ?, ?, ?, 'passed', 'passed', ?)
    `)
    db.exec('DROP TRIGGER trg_runtime_plugin_releases_immutable')
    insertRelease.run('rel-retained', digest, source, snapshot, 10)
    insertRelease.run('rel-collectible', digest, source, snapshot, 20)
    migrateToV76(db)
    migrateToV78(db)

    db.prepare(`
      INSERT INTO runtime_plugin_states (
        plugin_id, enabled, updated_at, active_release_id, release_revision
      ) VALUES ('retention-transformer', 1, 10, 'rel-retained', 1)
    `).run()
    assert.throws(
      () => db.prepare('DELETE FROM runtime_plugin_releases WHERE release_id = ?')
        .run('rel-collectible'),
      /immutable/,
    )

    db.prepare(`
      INSERT INTO runtime_plugin_release_gc_runs (
        run_id, status, policy_json, started_at
      ) VALUES ('gc-migration-test', 'running', '{}', 30)
    `).run()
    const guard = db.prepare(`
      INSERT INTO runtime_plugin_release_gc_delete_guards (release_id, run_id, created_at)
      VALUES (?, 'gc-migration-test', 30)
    `)
    guard.run('rel-retained')
    assert.throws(
      () => db.prepare('DELETE FROM runtime_plugin_releases WHERE release_id = ?')
        .run('rel-retained'),
      /authoritative/,
    )
    guard.run('rel-collectible')
    assert.equal(
      db.prepare('DELETE FROM runtime_plugin_releases WHERE release_id = ?')
        .run('rel-collectible').changes,
      1,
    )
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM runtime_plugin_release_gc_delete_guards').get().count,
      1,
    )
  } finally {
    db.close()
  }
})

test('v73 persists evolution Provider config revisions without inventing legacy snapshots', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
      INSERT INTO evolution_candidates (id) VALUES ('candidate-legacy');
      INSERT INTO evolution_replay_runs (id) VALUES ('replay-legacy');
      INSERT INTO evolution_evaluations (id) VALUES ('evaluation-legacy');
    `)
    migrateToV73(db)
    migrateToV73(db)
    assert.deepEqual(db.prepare(`SELECT
      (SELECT generator_config_revision FROM evolution_candidates WHERE id = 'candidate-legacy') AS candidate_revision,
      (SELECT model_config_revision FROM evolution_replay_runs WHERE id = 'replay-legacy') AS replay_revision,
      (SELECT evaluator_config_revision FROM evolution_evaluations WHERE id = 'evaluation-legacy') AS evaluator_revision`).get(), {
      candidate_revision: null,
      replay_revision: null,
      evaluator_revision: null,
    })
  } finally {
    db.close()
  }
})

test('v72 persists immutable subagent model binding snapshots', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE subagent_runs (id TEXT PRIMARY KEY);
      INSERT INTO subagent_runs (id) VALUES ('legacy-run');
    `)
    migrateToV72(db)
    migrateToV72(db)

    db.prepare(`UPDATE subagent_runs
      SET model_name = ?, model_provider_id = ?, model_config_revision = ?
      WHERE id = ?`).run('pinned-model', 'provider-1', 4, 'legacy-run')
    assert.deepEqual(
      db.prepare(`SELECT model_name, model_provider_id, model_config_revision
        FROM subagent_runs WHERE id = ?`).get('legacy-run'),
      {
        model_name: 'pinned-model',
        model_provider_id: 'provider-1',
        model_config_revision: 4,
      },
    )
  } finally {
    db.close()
  }
})

test('v71 preserves composite evolution model identities while leaving legacy Provider IDs unknown', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY, generator_model TEXT);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY, model_name TEXT NOT NULL);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY, evaluator_model TEXT NOT NULL);
      INSERT INTO evolution_candidates (id, generator_model) VALUES ('candidate-legacy', 'shared-model');
      INSERT INTO evolution_replay_runs (id, model_name) VALUES ('replay-legacy', 'shared-model');
      INSERT INTO evolution_evaluations (id, evaluator_model) VALUES ('evaluation-legacy', 'shared-model');
    `)
    migrateToV71(db)
    migrateToV71(db)

    assert.deepEqual(
      db.prepare(`SELECT generator_provider_id FROM evolution_candidates
        WHERE id = 'candidate-legacy'`).get(),
      { generator_provider_id: null },
    )
    assert.deepEqual(
      db.prepare(`SELECT model_provider_id FROM evolution_replay_runs
        WHERE id = 'replay-legacy'`).get(),
      { model_provider_id: null },
    )
    assert.deepEqual(
      db.prepare(`SELECT evaluator_provider_id FROM evolution_evaluations
        WHERE id = 'evaluation-legacy'`).get(),
      { evaluator_provider_id: null },
    )

    db.prepare('UPDATE evolution_candidates SET generator_provider_id = ? WHERE id = ?')
      .run('provider-a', 'candidate-legacy')
    db.prepare('UPDATE evolution_replay_runs SET model_provider_id = ? WHERE id = ?')
      .run('provider-b', 'replay-legacy')
    db.prepare('UPDATE evolution_evaluations SET evaluator_provider_id = ? WHERE id = ?')
      .run('provider-c', 'evaluation-legacy')
    assert.deepEqual(
      db.prepare(`SELECT
        (SELECT generator_provider_id FROM evolution_candidates WHERE id = 'candidate-legacy') AS candidate_provider,
        (SELECT model_provider_id FROM evolution_replay_runs WHERE id = 'replay-legacy') AS replay_provider,
        (SELECT evaluator_provider_id FROM evolution_evaluations WHERE id = 'evaluation-legacy') AS evaluator_provider`).get(),
      {
        candidate_provider: 'provider-a',
        replay_provider: 'provider-b',
        evaluator_provider: 'provider-c',
      },
    )
  } finally {
    db.close()
  }
})

test('v70 persists provider readiness revisions and job model bindings', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE model_providers (id TEXT PRIMARY KEY);
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
      INSERT INTO model_providers (id) VALUES ('provider-1');
      INSERT INTO jobs (id) VALUES ('job-1');
    `)
    migrateToV70(db)
    migrateToV70(db)

    const providerColumns = db.prepare('PRAGMA table_info(model_providers)').all()
      .map((column) => column.name)
    const jobColumns = db.prepare('PRAGMA table_info(jobs)').all()
      .map((column) => column.name)
    assert.ok(providerColumns.includes('config_revision'))
    assert.ok(providerColumns.includes('readiness_json'))
    assert.ok(jobColumns.includes('model_provider_id'))
    assert.ok(jobColumns.includes('model_config_revision'))
    assert.deepEqual(
      db.prepare('SELECT config_revision, readiness_json FROM model_providers WHERE id = ?').get('provider-1'),
      { config_revision: 1, readiness_json: null },
    )

    db.prepare(`UPDATE jobs
      SET model_provider_id = ?, model_config_revision = ?
      WHERE id = ?`).run('provider-1', 1, 'job-1')
    assert.deepEqual(
      db.prepare('SELECT model_provider_id, model_config_revision FROM jobs WHERE id = ?').get('job-1'),
      { model_provider_id: 'provider-1', model_config_revision: 1 },
    )
    db.prepare('DELETE FROM model_providers WHERE id = ?').run('provider-1')
    assert.deepEqual(
      db.prepare('SELECT model_provider_id, model_config_revision FROM jobs WHERE id = ?').get('job-1'),
      { model_provider_id: null, model_config_revision: 1 },
    )
  } finally {
    db.close()
  }
})

test('v69 persists bounded turn recovery retries and dead letters', () => {
  const db = new Database(':memory:')
  try {
    migrateToV69(db)
    migrateToV69(db)
    db.prepare(`
      INSERT INTO turn_recovery_states (
        user_id, session_id, turn_id, candidate_version, status,
        attempt_count, retryable, first_failed_at, last_failed_at,
        next_retry_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user-1', 'session-1', 'turn-1', '1:turn.started:1', 'retrying',
      1, 1, 10, 10, 510, 'TEMPORARY', 'temporary failure',
    )
    const row = db.prepare('SELECT * FROM turn_recovery_states WHERE turn_id = ?').get('turn-1')
    assert.equal(row.status, 'retrying')
    assert.equal(row.next_retry_at, 510)
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_turn_recovery_states_due'").get(),
    )
    assert.throws(
      () => db.prepare('UPDATE turn_recovery_states SET status = ? WHERE turn_id = ?').run('unknown', 'turn-1'),
      /CHECK constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('v68 persists immutable rollback policy, evaluations, and one rollback', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_approval_decisions (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
      INSERT INTO evolution_replay_runs (id) VALUES ('replay-1');
      INSERT INTO evolution_evaluations (id) VALUES ('evaluation-1');
      INSERT INTO evolution_approval_decisions (id) VALUES ('approval-1');
    `)
    migrateToV67(db)
    migrateToV68(db)
    migrateToV68(db)
    db.prepare(`
      INSERT INTO evolution_canary_releases (
        id, user_id, approval_id, evaluation_id, replay_id, candidate_id,
        target, traffic_percent, creation_reason, session_ids_json, baseline_sha256,
        candidate_sha256, release_fingerprint, created_at
      ) VALUES ('canary-1', 'user-1', 'approval-1', 'evaluation-1', 'replay-1',
        'candidate-1', 'prompt:workspace-instructions', 5, 'bounded', '["session-1"]', ?, ?, ?, 1)
    `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_rollback_policies (
        id, user_id, release_id, policy_version, window_size,
        minimum_candidate_outcomes, minimum_baseline_outcomes,
        maximum_candidate_failure_rate, maximum_candidate_cancellation_rate,
        maximum_latency_ratio, maximum_cost_ratio, reason, baseline_sha256,
        release_fingerprint, policy_fingerprint, created_at
      ) VALUES ('policy-1', 'user-1', 'canary-1', 'canary-rollback-v1', 20,
        3, 3, 0.34, 0.34, 1.5, 1.25, 'guardrails', ?, ?, ?, 2)
    `).run('a'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_events (id, user_id, release_id, event_type, reason, created_at)
      VALUES ('event-1', 'user-1', 'canary-1', 'started', 'start', 3)
    `).run()
    db.prepare(`
      INSERT INTO evolution_canary_assignments (
        id, user_id, release_id, session_id, turn_id, variant, decision_reason, bucket,
        baseline_sha256, observed_baseline_sha256, candidate_sha256, assigned_at
      ) VALUES ('assignment-1', 'user-1', 'canary-1', 'session-1', 'turn-1',
        'candidate', 'traffic_candidate', 1, ?, ?, ?, 4)
    `).run('a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_outcomes (
        id, user_id, release_id, assignment_id, terminal_state,
        duration_ms, usage_json, error_code, created_at
      ) VALUES ('outcome-1', 'user-1', 'canary-1', 'assignment-1',
        'failed', 100, '{"costUsd":0.01}', 'FAILED', 5)
    `).run()
    db.prepare(`
      INSERT INTO evolution_canary_outcome_context (
        outcome_id, assignment_id, effective_variant, decision_reason, recorded_at
      ) VALUES ('outcome-1', 'assignment-1', 'candidate', 'traffic_candidate', 5)
    `).run()
    db.prepare(`
      INSERT INTO evolution_canary_rollback_evaluations (
        id, user_id, release_id, policy_id, outcome_id, decision,
        metrics_json, breaches_json, evaluation_fingerprint, created_at
      ) VALUES ('guard-1', 'user-1', 'canary-1', 'policy-1', 'outcome-1',
        'rollback', '{}', '["maximum_candidate_failure_rate"]', ?, 6)
    `).run('e'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_rollbacks (
        id, user_id, release_id, policy_id, evaluation_id,
        rollback_baseline_sha256, release_fingerprint, baseline_status,
        observed_baseline_sha256, trigger_fingerprint, reason, created_at
      ) VALUES ('rollback-1', 'user-1', 'canary-1', 'policy-1', 'guard-1',
        ?, ?, 'verified', ?, ?, 'automatic rollback', 6)
    `).run('a'.repeat(64), 'c'.repeat(64), 'a'.repeat(64), 'e'.repeat(64))
    assert.deepEqual(
      db.prepare('SELECT decision FROM evolution_canary_rollback_evaluations').get(),
      { decision: 'rollback' },
    )
    assert.throws(() => db.prepare(`
      UPDATE evolution_canary_rollback_policies SET maximum_cost_ratio = 0.5 WHERE id = 'policy-1'
    `).run(), /CHECK constraint failed/)
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_canary_rollbacks (
        id, user_id, release_id, policy_id, evaluation_id,
        rollback_baseline_sha256, release_fingerprint, baseline_status,
        observed_baseline_sha256, trigger_fingerprint, reason, created_at
      ) SELECT 'rollback-2', user_id, release_id, policy_id, evaluation_id,
        rollback_baseline_sha256, release_fingerprint, baseline_status,
        observed_baseline_sha256, trigger_fingerprint, reason, 7
      FROM evolution_canary_rollbacks
    `).run(), /UNIQUE constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_canary_rollbacks').get().count, 0)
  } finally {
    db.close()
  }
})

test('v67 persists scoped canary lifecycle, assignments, and terminal outcomes', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_candidates (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_replay_runs (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_evaluations (id TEXT PRIMARY KEY);
      CREATE TABLE evolution_approval_decisions (id TEXT PRIMARY KEY);
      INSERT INTO users (id) VALUES ('user-1');
      INSERT INTO evolution_candidates (id) VALUES ('candidate-1');
      INSERT INTO evolution_replay_runs (id) VALUES ('replay-1');
      INSERT INTO evolution_evaluations (id) VALUES ('evaluation-1');
      INSERT INTO evolution_approval_decisions (id) VALUES ('approval-1');
    `)
    migrateToV67(db)
    migrateToV67(db)
    db.prepare(`
      INSERT INTO evolution_canary_releases (
        id, user_id, approval_id, evaluation_id, replay_id, candidate_id,
        target, traffic_percent, creation_reason, session_ids_json, baseline_sha256,
        candidate_sha256, release_fingerprint, created_at
      ) VALUES ('canary-1', 'user-1', 'approval-1', 'evaluation-1', 'replay-1',
        'candidate-1', 'prompt:workspace-instructions', 5, 'bounded canary', '["session-1"]', ?, ?, ?, 1)
    `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_events (id, user_id, release_id, event_type, reason, created_at)
      VALUES ('event-1', 'user-1', 'canary-1', 'started', 'manual start', 1)
    `).run()
    db.prepare(`
      INSERT INTO evolution_canary_assignments (
        id, user_id, release_id, session_id, turn_id, variant, decision_reason, bucket,
        baseline_sha256, observed_baseline_sha256, candidate_sha256, assigned_at
      ) VALUES ('assignment-1', 'user-1', 'canary-1', 'session-1', 'turn-1',
        'candidate', 'traffic_candidate', 4, ?, ?, ?, 2)
    `).run('a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64))
    db.prepare(`
      INSERT INTO evolution_canary_outcomes (
        id, user_id, release_id, assignment_id, terminal_state,
        duration_ms, usage_json, error_code, created_at
      ) VALUES ('outcome-1', 'user-1', 'canary-1', 'assignment-1',
        'completed', 1200, '{"costUsd":0.01}', NULL, 3)
    `).run()
    assert.deepEqual(
      db.prepare('SELECT traffic_percent, target FROM evolution_canary_releases').get(),
      { traffic_percent: 5, target: 'prompt:workspace-instructions' },
    )
    assert.throws(() => db.prepare(`
      UPDATE evolution_canary_releases SET traffic_percent = 11 WHERE id = 'canary-1'
    `).run(), /CHECK constraint failed/)
    assert.throws(() => db.prepare(`
      UPDATE evolution_canary_assignments SET variant = 'global' WHERE id = 'assignment-1'
    `).run(), /CHECK constraint failed/)
    assert.throws(() => db.prepare(`
      INSERT INTO evolution_canary_outcomes (
        id, user_id, release_id, assignment_id, terminal_state,
        duration_ms, usage_json, error_code, created_at
      ) VALUES ('outcome-2', 'user-1', 'canary-1', 'assignment-1',
        'failed', 1, NULL, 'FAILED', 4)
    `).run(), /UNIQUE constraint failed/)
    db.prepare("DELETE FROM users WHERE id = 'user-1'").run()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_canary_releases').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_canary_outcomes').get().count, 0)
  } finally {
    db.close()
  }
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

test('v91 adds nullable policy provenance without rewriting legacy approvals', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE pending_approvals (id TEXT PRIMARY KEY);
      INSERT INTO pending_approvals (id) VALUES ('legacy-approval');
    `)
    migrateToV91(db)
    migrateToV91(db)

    const columns = db.prepare('PRAGMA table_info(pending_approvals)').all()
    assert.equal(columns.filter((item) => item.name === 'policy_provenance_json').length, 1)
    assert.equal(
      db.prepare('SELECT policy_provenance_json FROM pending_approvals WHERE id = ?')
        .get('legacy-approval').policy_provenance_json,
      null,
    )
    db.prepare('UPDATE pending_approvals SET policy_provenance_json = ? WHERE id = ?')
      .run('{"id":"builtin.harness-policy","generation":1}', 'legacy-approval')
    assert.match(
      db.prepare('SELECT policy_provenance_json FROM pending_approvals WHERE id = ?')
        .get('legacy-approval').policy_provenance_json,
      /builtin\.harness-policy/u,
    )
  } finally {
    db.close()
  }
})

test('schema migration runner rejects invalid and future versions before migration writes', () => {
  const cases = [
    { value: -1, code: 'DB_SCHEMA_VERSION_INVALID' },
    { value: 1.5, code: 'DB_SCHEMA_VERSION_INVALID' },
    { value: 'not-a-version', code: 'DB_SCHEMA_VERSION_INVALID' },
    { value: '', code: 'DB_SCHEMA_VERSION_INVALID' },
    { value: 'Infinity', code: 'DB_SCHEMA_VERSION_INVALID' },
    { value: LATEST_SCHEMA_VERSION + 1, code: 'DB_SCHEMA_VERSION_UNSUPPORTED' },
  ]

  for (const entry of cases) {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE migration_sentinel (value TEXT NOT NULL);
        INSERT INTO migration_sentinel (value) VALUES ('unchanged');
      `)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(entry.value))
      assert.throws(
        () => runSchemaMigrations(db),
        (error) => error?.code === entry.code && error?.retryable === false,
      )
      assert.equal(
        db.prepare("SELECT value FROM migration_sentinel").get().value,
        'unchanged',
      )
      assert.equal(
        db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
        String(entry.value),
      )
    } finally {
      db.close()
    }
  }
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
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_turn_events_fixture_replay
        ON turn_events(user_id, session_id, turn_id, sequence);
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
      'managed_attachment_upload_leases',
      'turn_execution_leases',
      'turn_execution_fences',
      'turn_checkpoints',
      'turn_recovery_states',
      'job_turn_checkpoints',
      'job_model_request_recovery_resolutions',
      'permission_mode_events',
      'runtime_plugin_states',
      'runtime_plugin_releases',
      'runtime_plugin_permission_grants',
      'evolution_promotions',
      'evolution_promotion_events',
      'evolution_active_promotions',
      'evolution_promotion_assignments',
      'evolution_promotion_outcomes',
      'evolution_promotion_outcome_snapshots',
      'evolution_promotion_online_grades',
      'evolution_promotion_online_guard_evaluations',
      'evolution_promotion_rollbacks',
      'evolution_operations',
    ]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table)
    }
  } finally {
    db.close()
  }
})
