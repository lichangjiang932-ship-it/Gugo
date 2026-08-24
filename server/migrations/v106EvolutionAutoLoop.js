import { hasColumn, hasTable } from './index.js'

/**
 * Persist the opt-in automatic evolution controller and its append-only run
 * ledger. Automatic runs are intentionally limited by the service layer to
 * workspace prompt candidates; plugin, config, and permission changes never
 * enter this pipeline.
 */
export function migrateToV106(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_auto_configs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      target TEXT NOT NULL CHECK (target = 'prompt:workspace-instructions'),
      objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 2000),
      generator_provider_id TEXT NOT NULL CHECK (length(generator_provider_id) BETWEEN 1 AND 512),
      generator_model TEXT NOT NULL CHECK (length(generator_model) BETWEEN 1 AND 512),
      replay_provider_id TEXT NOT NULL CHECK (length(replay_provider_id) BETWEEN 1 AND 512),
      replay_model TEXT NOT NULL CHECK (length(replay_model) BETWEEN 1 AND 512),
      evaluator_provider_id TEXT NOT NULL CHECK (length(evaluator_provider_id) BETWEEN 1 AND 512),
      evaluator_model TEXT NOT NULL CHECK (length(evaluator_model) BETWEEN 1 AND 512),
      session_ids_json TEXT NOT NULL CHECK (
        json_valid(session_ids_json)
        AND json_type(session_ids_json) = 'array'
        AND json_array_length(session_ids_json) BETWEEN 1 AND 10
      ),
      minimum_signal_count INTEGER NOT NULL CHECK (minimum_signal_count BETWEEN 1 AND 50),
      maximum_source_records INTEGER NOT NULL CHECK (maximum_source_records BETWEEN 1 AND 10),
      cooldown_ms INTEGER NOT NULL CHECK (cooldown_ms BETWEEN 60000 AND 2592000000),
      traffic_percent INTEGER NOT NULL CHECK (traffic_percent BETWEEN 1 AND 10),
      canary_max_outcomes INTEGER NOT NULL CHECK (canary_max_outcomes BETWEEN 6 AND 200),
      canary_max_age_ms INTEGER NOT NULL CHECK (canary_max_age_ms BETWEEN 300000 AND 2592000000),
      rollback_policy_json TEXT NOT NULL CHECK (
        json_valid(rollback_policy_json) AND json_type(rollback_policy_json) = 'object'
      ),
      config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    );

    CREATE TABLE IF NOT EXISTS evolution_auto_runs (
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
    CREATE INDEX IF NOT EXISTS idx_evolution_auto_runs_user_created
      ON evolution_auto_runs(user_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_evolution_auto_runs_state_updated
      ON evolution_auto_runs(state, updated_at ASC, id ASC);
  `)

  if (hasTable(db, 'evolution_approval_decisions')
    && !hasColumn(db, 'evolution_approval_decisions', 'decision_origin')) {
    db.exec(`
      ALTER TABLE evolution_approval_decisions
        ADD COLUMN decision_origin TEXT NOT NULL DEFAULT 'human_review'
          CHECK (decision_origin IN ('human_review', 'automatic_policy'))
    `)
  }
  if (hasTable(db, 'evolution_approval_decisions')
    && !hasColumn(db, 'evolution_approval_decisions', 'automation_run_id')) {
    db.exec(`
      ALTER TABLE evolution_approval_decisions
        ADD COLUMN automation_run_id TEXT
    `)
  }
  if (hasTable(db, 'evolution_approval_decisions')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_approval_automation_run
        ON evolution_approval_decisions(automation_run_id)
        WHERE automation_run_id IS NOT NULL;
    `)
  }

  if (hasTable(db, 'evolution_promotions')
    && !hasColumn(db, 'evolution_promotions', 'decision_origin')) {
    db.exec(`
      ALTER TABLE evolution_promotions
        ADD COLUMN decision_origin TEXT NOT NULL DEFAULT 'human_review'
          CHECK (decision_origin IN ('human_review', 'automatic_policy'))
    `)
  }
  if (hasTable(db, 'evolution_promotions')
    && !hasColumn(db, 'evolution_promotions', 'automation_run_id')) {
    db.exec(`
      ALTER TABLE evolution_promotions
        ADD COLUMN automation_run_id TEXT
    `)
  }
  if (hasTable(db, 'evolution_promotions')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evolution_promotion_automation_run
        ON evolution_promotions(automation_run_id)
        WHERE automation_run_id IS NOT NULL;
    `)
  }
}
