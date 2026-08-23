import { hasColumn } from './index.js'

/** Persist provider probe results and bind jobs to the configuration they validated. */
export function migrateToV70(db) {
  if (!hasColumn(db, 'model_providers', 'config_revision')) {
    db.exec('ALTER TABLE model_providers ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1')
  }
  if (!hasColumn(db, 'model_providers', 'readiness_json')) {
    db.exec('ALTER TABLE model_providers ADD COLUMN readiness_json TEXT')
  }
  if (!hasColumn(db, 'jobs', 'model_provider_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN model_provider_id TEXT REFERENCES model_providers(id) ON DELETE SET NULL')
  }
  if (!hasColumn(db, 'jobs', 'model_config_revision')) {
    db.exec('ALTER TABLE jobs ADD COLUMN model_config_revision INTEGER')
  }
}
