import { hasColumn } from './index.js'

/** Keep new Job-event presentation data language-neutral while retaining legacy rows. */
export function migrateToV111(db) {
  if (!hasColumn(db, 'job_events', 'code')) {
    db.exec('ALTER TABLE job_events ADD COLUMN code TEXT')
  }
  if (!hasColumn(db, 'job_events', 'params_json')) {
    db.exec('ALTER TABLE job_events ADD COLUMN params_json TEXT')
  }
}
