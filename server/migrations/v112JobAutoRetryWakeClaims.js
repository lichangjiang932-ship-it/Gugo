import { hasColumn } from './index.js'

/** Persist fenced in-flight auto-retry wake claims without expanding status values. */
export function migrateToV112(db) {
  if (!hasColumn(db, 'job_wakeups', 'claim_token')) {
    db.exec('ALTER TABLE job_wakeups ADD COLUMN claim_token TEXT')
  }
}
