/**
 * Durable coordination record for local user-data clearing.
 *
 * File moves happen while a row is in `staging`. The user-owned database
 * deletion and transition to `database_committed` happen in one SQLite
 * transaction, which lets a later invocation deterministically restore staged
 * files or finish deleting them after a crash.
 */
export function migrateToV77(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_data_clear_operations (
      operation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE,
      lease_owner TEXT NOT NULL,
      lease_pid INTEGER NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('staging', 'database_committed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_data_clear_operations_status
      ON user_data_clear_operations(status, lease_expires_at, updated_at);
  `)
}
