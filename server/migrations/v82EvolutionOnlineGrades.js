import { hasColumn } from './index.js'

/**
 * Freeze the independent online grader and retain append-only quality/safety
 * evidence for every canary outcome. The original v68 operational guard stays
 * intact; an online guard is an additional fail-closed promotion condition.
 */
export function migrateToV82(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evolution_canary_grader_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL CHECK (policy_version = 'canary-online-grader-v1'),
      rubric_version TEXT NOT NULL CHECK (length(rubric_version) BETWEEN 1 AND 200),
      grader_provider_id TEXT NOT NULL CHECK (length(grader_provider_id) BETWEEN 1 AND 512),
      grader_model TEXT NOT NULL CHECK (length(grader_model) BETWEEN 1 AND 512),
      grader_model_revision TEXT NOT NULL CHECK (length(grader_model_revision) BETWEEN 1 AND 512),
      grader_config_revision INTEGER CHECK (
        grader_config_revision IS NULL OR grader_config_revision >= 1
      ),
      minimum_quality_score REAL NOT NULL CHECK (
        minimum_quality_score >= 0 AND minimum_quality_score <= 4
      ),
      maximum_quality_regression REAL NOT NULL CHECK (
        maximum_quality_regression >= 0 AND maximum_quality_regression <= 4
      ),
      maximum_safety_failure_rate REAL NOT NULL CHECK (
        maximum_safety_failure_rate >= 0 AND maximum_safety_failure_rate <= 1
      ),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
      policy_fingerprint TEXT NOT NULL UNIQUE CHECK (length(policy_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_grader_policies_user_created
      ON evolution_canary_grader_policies(user_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_outcome_snapshots (
      outcome_id TEXT PRIMARY KEY REFERENCES evolution_canary_outcomes(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_assignments(id) ON DELETE CASCADE,
      evaluated_provider_id TEXT NOT NULL CHECK (length(evaluated_provider_id) BETWEEN 1 AND 512),
      evaluated_model TEXT NOT NULL CHECK (length(evaluated_model) BETWEEN 1 AND 512),
      evaluated_model_revision TEXT NOT NULL CHECK (length(evaluated_model_revision) BETWEEN 1 AND 512),
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

    CREATE TABLE IF NOT EXISTS evolution_canary_online_grades (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      outcome_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_outcomes(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_grader_policies(id) ON DELETE CASCADE,
      effective_variant TEXT NOT NULL CHECK (effective_variant IN ('baseline', 'candidate')),
      execution_status TEXT NOT NULL CHECK (execution_status IN ('completed', 'failed')),
      quality_score REAL CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 4)),
      safety_verdict TEXT CHECK (safety_verdict IS NULL OR safety_verdict IN ('pass', 'fail', 'unknown')),
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
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_online_grades_release_variant
      ON evolution_canary_online_grades(release_id, effective_variant, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS evolution_canary_online_guard_evaluations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES evolution_canary_releases(id) ON DELETE CASCADE,
      policy_id TEXT NOT NULL REFERENCES evolution_canary_grader_policies(id) ON DELETE CASCADE,
      trigger_grade_id TEXT NOT NULL UNIQUE REFERENCES evolution_canary_online_grades(id) ON DELETE CASCADE,
      sample_fingerprint TEXT NOT NULL CHECK (length(sample_fingerprint) = 64),
      grade_ids_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('insufficient_evidence', 'continue', 'rollback')),
      metrics_json TEXT NOT NULL,
      breaches_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      evaluation_fingerprint TEXT NOT NULL UNIQUE CHECK (length(evaluation_fingerprint) = 64),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_canary_online_guard_release_created
      ON evolution_canary_online_guard_evaluations(release_id, created_at DESC, id DESC);
  `)

  if (!hasColumn(db, 'evolution_canary_rollbacks', 'online_guard_evaluation_id')) {
    db.exec(`
      ALTER TABLE evolution_canary_rollbacks
        ADD COLUMN online_guard_evaluation_id TEXT
          REFERENCES evolution_canary_online_guard_evaluations(id) ON DELETE SET NULL
    `)
  }
  if (!hasColumn(db, 'evolution_promotions', 'online_grader_policy_fingerprint')) {
    db.exec(`
      ALTER TABLE evolution_promotions
        ADD COLUMN online_grader_policy_fingerprint TEXT
          CHECK (
            online_grader_policy_fingerprint IS NULL
            OR length(online_grader_policy_fingerprint) = 64
          )
    `)
  }
  if (!hasColumn(db, 'evolution_promotions', 'online_guard_evaluation_fingerprint')) {
    db.exec(`
      ALTER TABLE evolution_promotions
        ADD COLUMN online_guard_evaluation_fingerprint TEXT
          CHECK (
            online_guard_evaluation_fingerprint IS NULL
            OR length(online_guard_evaluation_fingerprint) = 64
          )
    `)
  }
}
