import { hasColumn } from './index.js'

/** Pin every evolution artifact to the Provider configuration that produced it. */
export function migrateToV73(db) {
  if (!hasColumn(db, 'evolution_candidates', 'generator_config_revision')) {
    db.exec('ALTER TABLE evolution_candidates ADD COLUMN generator_config_revision INTEGER')
  }
  if (!hasColumn(db, 'evolution_replay_runs', 'model_config_revision')) {
    db.exec('ALTER TABLE evolution_replay_runs ADD COLUMN model_config_revision INTEGER')
  }
  if (!hasColumn(db, 'evolution_evaluations', 'evaluator_config_revision')) {
    db.exec('ALTER TABLE evolution_evaluations ADD COLUMN evaluator_config_revision INTEGER')
  }
}
