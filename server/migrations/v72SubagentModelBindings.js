import { hasColumn } from './index.js'

/** Keep every durable subagent run pinned to the model configuration that created it. */
export function migrateToV72(db) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'",
  ).get()
  if (!tableExists) return
  if (!hasColumn(db, 'subagent_runs', 'model_name')) {
    db.exec('ALTER TABLE subagent_runs ADD COLUMN model_name TEXT')
  }
  if (!hasColumn(db, 'subagent_runs', 'model_provider_id')) {
    db.exec('ALTER TABLE subagent_runs ADD COLUMN model_provider_id TEXT')
  }
  if (!hasColumn(db, 'subagent_runs', 'model_config_revision')) {
    db.exec('ALTER TABLE subagent_runs ADD COLUMN model_config_revision INTEGER')
  }
}
