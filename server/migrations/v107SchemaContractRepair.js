import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'
import { hasColumn, hasTable } from './index.js'
import { migrateToV104 } from './v104RuntimePluginMutationRecoveryReceipts.js'
import { migrateToV105 } from './v105RuntimePluginMutationBarrierHardening.js'
import { migrateToV106 } from './v106EvolutionAutoLoop.js'

const VERSION = 107

function repairError(missing, details = {}) {
  const error = databaseSchemaIncompleteError({
    expectedVersion: VERSION,
    stage: 'migration-v107',
    missing,
  })
  Object.assign(error.details, details)
  return error
}

function validSessionScope(expression) {
  return `json_valid(${expression})
    AND json_type(${expression}) = 'array'
    AND json_array_length(${expression}) BETWEEN 1 AND 10`
}

function repairBarrierGenerationClaim(db) {
  if (hasTable(db, 'runtime_plugin_mutation_barriers')) {
    if (!hasTable(db, 'runtime_plugin_mutation_barrier_generations')) {
      const barrier = db.prepare(`
        SELECT plugin_id FROM runtime_plugin_mutation_barriers LIMIT 1
      `).get()
      if (barrier) {
        throw repairError(
          ['table:runtime_plugin_mutation_barrier_generations'],
          { pluginId: barrier.plugin_id },
        )
      }
    } else {
      const mismatch = db.prepare(`
        SELECT barrier.plugin_id, barrier.generation, generation.last_generation
        FROM runtime_plugin_mutation_barriers AS barrier
        LEFT JOIN runtime_plugin_mutation_barrier_generations AS generation
          ON generation.plugin_id = barrier.plugin_id
        WHERE generation.plugin_id IS NULL
          OR generation.last_generation <> barrier.generation
        LIMIT 1
      `).get()
      if (mismatch) {
        throw repairError(
          ['data:runtime_plugin_mutation_barrier_generations'],
          {
            pluginId: mismatch.plugin_id,
            barrierGeneration: mismatch.generation,
            lastGeneration: mismatch.last_generation,
          },
        )
      }
    }
  }
  if (hasTable(db, 'runtime_plugin_mutation_barrier_generations')
    && !hasColumn(db, 'runtime_plugin_mutation_barrier_generations', 'generation_claimed')) {
    // The pre-release v103 draft persisted only the last generation. Every
    // historical generation is already claimed: an active barrier proves the
    // claim, while a completed barrier must advance before another claim.
    db.exec(`
      ALTER TABLE runtime_plugin_mutation_barrier_generations
        ADD COLUMN generation_claimed INTEGER NOT NULL DEFAULT 1
          CHECK (generation_claimed IN (0, 1));
    `)
  }

  // Recreate the complete authoritative trigger set after the draft column is
  // repaired. v105 validates Release identities before dropping any trigger.
  migrateToV105(db)
}

function backfillSessionScopeExpression() {
  const canaryScope = `(
    SELECT release.session_ids_json
    FROM evolution_canary_releases AS release
    WHERE release.id = old.canary_id
      AND release.user_id = old.user_id
      AND ${validSessionScope('release.session_ids_json')}
  )`
  const configScope = `(
    SELECT config.session_ids_json
    FROM evolution_auto_configs AS config
    WHERE config.user_id = old.user_id
      AND config.config_revision = old.config_revision
      AND ${validSessionScope('config.session_ids_json')}
  )`
  return `COALESCE(${canaryScope}, ${configScope})`
}

function assertEvolutionRunRepairable(db, { hasSessionScope }) {
  const requiredSourceColumns = [
    'id',
    'user_id',
    'config_revision',
    'evidence_fingerprint',
    'dataset_fingerprint',
    'source_record_ids_json',
    'source_evidence_ids_json',
    'signal_count',
    'signal_cutoff_at',
    'state',
    'stage',
    'candidate_id',
    'replay_suite_id',
    'replay_id',
    'evaluation_id',
    'approval_id',
    'canary_id',
    'promotion_id',
    'verdict',
    'error_code',
    'error_message',
    'created_at',
    'updated_at',
    'finished_at',
  ]
  if (hasSessionScope) requiredSourceColumns.push('session_ids_json')
  const missing = requiredSourceColumns
    .filter((column) => !hasColumn(db, 'evolution_auto_runs', column))
    .map((column) => `column:evolution_auto_runs.${column}`)
  if (missing.length > 0) throw repairError(missing)

  const scope = hasSessionScope ? 'old.session_ids_json' : backfillSessionScopeExpression()
  const unresolved = db.prepare(`
      SELECT old.id
      FROM evolution_auto_runs AS old
      WHERE COALESCE((${validSessionScope(scope)}), 0) <> 1
      LIMIT 1
    `).get()
  if (unresolved) {
    throw repairError(
      ['column:evolution_auto_runs.session_ids_json'],
      { unresolvedRunId: unresolved.id },
    )
  }
}

function rebuildEvolutionAutoRuns(db) {
  const hasSessionScope = hasColumn(db, 'evolution_auto_runs', 'session_ids_json')
  assertEvolutionRunRepairable(db, { hasSessionScope })
  const scope = hasSessionScope ? 'old.session_ids_json' : backfillSessionScopeExpression()
  try {
    db.exec(`
    CREATE TABLE evolution_auto_runs__v107 (
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
      session_ids_json TEXT NOT NULL CHECK (
        json_valid(session_ids_json)
        AND json_type(session_ids_json) = 'array'
        AND json_array_length(session_ids_json) BETWEEN 1 AND 10
      ),
      signal_count INTEGER NOT NULL CHECK (signal_count >= 1),
      signal_cutoff_at INTEGER NOT NULL CHECK (signal_cutoff_at >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'rejected', 'canary_active',
        'validated', 'promoted', 'rolled_back', 'stopped', 'failed'
      )),
      stage TEXT NOT NULL CHECK (length(stage) BETWEEN 1 AND 120),
      candidate_id TEXT REFERENCES evolution_candidates(id) ON DELETE SET NULL,
      replay_suite_id TEXT REFERENCES evolution_replay_suites(id) ON DELETE SET NULL,
      replay_id TEXT REFERENCES evolution_replay_runs(id) ON DELETE SET NULL,
      evaluation_id TEXT REFERENCES evolution_evaluations(id) ON DELETE SET NULL,
      approval_id TEXT REFERENCES evolution_approval_decisions(id) ON DELETE SET NULL,
      canary_id TEXT REFERENCES evolution_canary_releases(id) ON DELETE SET NULL,
      promotion_id TEXT REFERENCES evolution_promotions(id) ON DELETE SET NULL,
      verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'inconclusive')),
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= created_at),
      UNIQUE (user_id, config_revision, evidence_fingerprint)
    );
    INSERT INTO evolution_auto_runs__v107 (
      id, user_id, config_revision, evidence_fingerprint, dataset_fingerprint,
      source_record_ids_json, source_evidence_ids_json, session_ids_json,
      signal_count, signal_cutoff_at, state, stage, candidate_id,
      replay_suite_id, replay_id, evaluation_id, approval_id, canary_id,
      promotion_id, verdict, error_code, error_message, created_at, updated_at,
      finished_at
    )
    SELECT
      old.id, old.user_id, old.config_revision, old.evidence_fingerprint,
      old.dataset_fingerprint, old.source_record_ids_json,
      old.source_evidence_ids_json, ${scope}, old.signal_count,
      old.signal_cutoff_at, old.state, old.stage, old.candidate_id,
      old.replay_suite_id, old.replay_id, old.evaluation_id, old.approval_id,
      old.canary_id, old.promotion_id, old.verdict, old.error_code,
      old.error_message, old.created_at, old.updated_at, old.finished_at
    FROM evolution_auto_runs AS old;
    DROP TABLE evolution_auto_runs;
    ALTER TABLE evolution_auto_runs__v107 RENAME TO evolution_auto_runs;
  `)
  } catch (error) {
    if (error?.code === 'DB_SCHEMA_INCOMPLETE') throw error
    throw repairError(
      ['table:evolution_auto_runs'],
      {
        sqliteCode: error?.code || null,
        sqliteMessage: error?.message || String(error),
      },
    )
  }
}

function normalizeEvolutionIndexes(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_evolution_auto_runs_user_created;
    DROP INDEX IF EXISTS idx_evolution_auto_runs_state_updated;
    CREATE INDEX idx_evolution_auto_runs_user_created
      ON evolution_auto_runs(user_id, created_at DESC, id DESC);
    CREATE INDEX idx_evolution_auto_runs_state_updated
      ON evolution_auto_runs(state, updated_at ASC, id ASC);
  `)
  if (hasTable(db, 'evolution_approval_decisions')
    && hasColumn(db, 'evolution_approval_decisions', 'automation_run_id')) {
    db.exec(`
      DROP INDEX IF EXISTS idx_evolution_approval_automation_run;
      CREATE UNIQUE INDEX idx_evolution_approval_automation_run
        ON evolution_approval_decisions(automation_run_id)
        WHERE automation_run_id IS NOT NULL;
    `)
  }
  if (hasTable(db, 'evolution_promotions')
    && hasColumn(db, 'evolution_promotions', 'automation_run_id')) {
    db.exec(`
      DROP INDEX IF EXISTS idx_evolution_promotion_automation_run;
      CREATE UNIQUE INDEX idx_evolution_promotion_automation_run
        ON evolution_promotions(automation_run_id)
        WHERE automation_run_id IS NOT NULL;
    `)
  }
}

function repairEvolutionDraft(db) {
  migrateToV106(db)
  if (!hasColumn(db, 'evolution_auto_runs', 'promotion_id')) {
    db.exec(`
      ALTER TABLE evolution_auto_runs
        ADD COLUMN promotion_id TEXT REFERENCES evolution_promotions(id) ON DELETE SET NULL;
    `)
  }
  // Rebuild even when every column exists. Pre-release v106 drafts used a
  // narrower state CHECK, so column presence alone cannot prove parity.
  rebuildEvolutionAutoRuns(db)
  normalizeEvolutionIndexes(db)
}

/** Repair schema written by pre-release v103/v106 drafts without rewriting history. */
export function migrateToV107(db) {
  migrateToV104(db)
  repairBarrierGenerationClaim(db)
  repairEvolutionDraft(db)

  const violation = db.prepare('PRAGMA foreign_key_check').get()
  if (violation) {
    throw repairError(
      [`foreign-key-data:${violation.table}`],
      { rowId: violation.rowid, parent: violation.parent },
    )
  }
}
