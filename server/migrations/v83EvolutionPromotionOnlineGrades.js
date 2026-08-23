import { hasColumn } from './index.js'

/**
 * Extend the immutable canary grader policy with an explicit production
 * monitoring opt-in and retain append-only grading evidence for promoted
 * outcomes. Existing policies remain disabled after upgrade.
 */
export function migrateToV83(db) {
  if (!hasColumn(db, 'evolution_canary_grader_policies', 'production_monitoring_enabled')) {
    db.exec(`
      ALTER TABLE evolution_canary_grader_policies
        ADD COLUMN production_monitoring_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (production_monitoring_enabled IN (0, 1))
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_promotion_outcome_snapshots (
      outcome_id TEXT PRIMARY KEY REFERENCES evolution_promotion_outcomes(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE
        REFERENCES evolution_promotion_assignments(id) ON DELETE CASCADE,
      evaluated_provider_id TEXT NOT NULL CHECK (length(evaluated_provider_id) BETWEEN 1 AND 512),
      evaluated_model TEXT NOT NULL CHECK (length(evaluated_model) BETWEEN 1 AND 512),
      evaluated_model_revision TEXT NOT NULL
        CHECK (length(evaluated_model_revision) BETWEEN 1 AND 512),
      evaluated_config_revision INTEGER CHECK (
        evaluated_config_revision IS NULL OR evaluated_config_revision >= 1
      ),
      input_content TEXT NOT NULL,
      output_content TEXT NOT NULL,
      input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
      output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
      snapshot_fingerprint TEXT NOT NULL UNIQUE CHECK (length(snapshot_fingerprint) = 64),
      recorded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evolution_promotion_online_grades (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      outcome_id TEXT NOT NULL UNIQUE REFERENCES evolution_promotion_outcomes(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_grader_policies(id) ON DELETE CASCADE,
      execution_status TEXT NOT NULL CHECK (execution_status IN ('completed', 'failed')),
      quality_score REAL CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 4)),
      safety_verdict TEXT CHECK (
        safety_verdict IS NULL OR safety_verdict IN ('pass', 'fail', 'unknown')
      ),
      summary TEXT,
      evidence_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      error_code TEXT,
      grader_provider_id TEXT NOT NULL,
      grader_model TEXT NOT NULL,
      grader_model_revision TEXT NOT NULL,
      grader_config_revision INTEGER,
      evaluated_provider_id TEXT,
      evaluated_model TEXT,
      evaluated_model_revision TEXT,
      snapshot_fingerprint TEXT,
      policy_fingerprint TEXT NOT NULL CHECK (length(policy_fingerprint) = 64),
      grade_fingerprint TEXT NOT NULL UNIQUE CHECK (length(grade_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotion_online_grades_promotion_created
      ON evolution_promotion_online_grades(promotion_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_promotion_online_guard_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_grader_policies(id) ON DELETE CASCADE,
      trigger_grade_id TEXT NOT NULL UNIQUE
        REFERENCES evolution_promotion_online_grades(id) ON DELETE CASCADE,
      baseline_guard_evaluation_id TEXT NOT NULL
        REFERENCES evolution_canary_online_guard_evaluations(id) ON DELETE CASCADE,
      sample_fingerprint TEXT NOT NULL CHECK (length(sample_fingerprint) = 64),
      baseline_grade_ids_json TEXT NOT NULL,
      promotion_grade_ids_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('insufficient_evidence', 'continue', 'rollback')),
      metrics_json TEXT NOT NULL,
      breaches_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      evaluation_fingerprint TEXT NOT NULL UNIQUE CHECK (length(evaluation_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_promotion_online_guard_created
      ON evolution_promotion_online_guard_evaluations(promotion_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_promotion_rollbacks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      promotion_id TEXT NOT NULL UNIQUE REFERENCES evolution_promotions(id) ON DELETE CASCADE,
      guard_evaluation_id TEXT NOT NULL UNIQUE
        REFERENCES evolution_promotion_online_guard_evaluations(id) ON DELETE CASCADE,
      trigger_fingerprint TEXT NOT NULL CHECK (length(trigger_fingerprint) = 64),
      breaches_json TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      created_at INTEGER NOT NULL
    );
  `)
}
