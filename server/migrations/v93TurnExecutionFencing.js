function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/**
 * Keep the allocation counter outside the live lease row. A released or
 * pruned lease must never let the same Turn reuse an older fencing token.
 */
export function migrateToV93(db) {
  if (!hasColumn(db, 'turn_execution_leases', 'fencing_token')) {
    db.exec(`
      ALTER TABLE turn_execution_leases
      ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 1
        CHECK (fencing_token > 0);
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_execution_fences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id, turn_id)
    );

    INSERT INTO turn_execution_fences
      (user_id, session_id, turn_id, fencing_token, updated_at)
    SELECT
      user_id,
      session_id,
      turn_id,
      MAX(fencing_token, 1),
      MAX(acquired_at, expires_at)
    FROM turn_execution_leases
    WHERE 1
    ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
      fencing_token = MAX(
        turn_execution_fences.fencing_token,
        excluded.fencing_token
      ),
      updated_at = MAX(turn_execution_fences.updated_at, excluded.updated_at);
  `)
}
