import { hasColumn } from './index.js'

/** Persist opt-in task retry policy and distinguish retry wakes from user sleeps. */
export function migrateToV110(db) {
  if (!hasColumn(db, 'jobs', 'auto_retry_enabled')) {
    db.exec('ALTER TABLE jobs ADD COLUMN auto_retry_enabled INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'jobs', 'auto_retry_max_attempts')) {
    db.exec('ALTER TABLE jobs ADD COLUMN auto_retry_max_attempts INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'jobs', 'auto_retry_attempts')) {
    db.exec('ALTER TABLE jobs ADD COLUMN auto_retry_attempts INTEGER NOT NULL DEFAULT 0')
  }
  if (!hasColumn(db, 'jobs', 'auto_retry_base_delay_ms')) {
    db.exec('ALTER TABLE jobs ADD COLUMN auto_retry_base_delay_ms INTEGER NOT NULL DEFAULT 1000')
  }
  if (!hasColumn(db, 'job_wakeups', 'wake_kind')) {
    db.exec("ALTER TABLE job_wakeups ADD COLUMN wake_kind TEXT NOT NULL DEFAULT 'resume'")
  }
}
