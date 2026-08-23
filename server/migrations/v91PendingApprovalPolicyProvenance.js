import { hasColumn, hasTable } from './index.js'

/** Persist the exact runtime policy identity that classified an approval. */
export function migrateToV91(db) {
  if (!hasTable(db, 'pending_approvals')) return

  if (!hasColumn(db, 'pending_approvals', 'policy_provenance_json')) {
    db.exec(`
      ALTER TABLE pending_approvals
      ADD COLUMN policy_provenance_json TEXT
    `)
  }
}
