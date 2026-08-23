import { hasColumn } from './index.js'

/** Preserve the Provider half of every evolution model identity. */
export function migrateToV71(db) {
  if (!hasColumn(db, 'evolution_candidates', 'generator_provider_id')) {
    db.exec('ALTER TABLE evolution_candidates ADD COLUMN generator_provider_id TEXT')
  }
  if (!hasColumn(db, 'evolution_replay_runs', 'model_provider_id')) {
    db.exec('ALTER TABLE evolution_replay_runs ADD COLUMN model_provider_id TEXT')
  }
  if (!hasColumn(db, 'evolution_evaluations', 'evaluator_provider_id')) {
    db.exec('ALTER TABLE evolution_evaluations ADD COLUMN evaluator_provider_id TEXT')
  }
}
