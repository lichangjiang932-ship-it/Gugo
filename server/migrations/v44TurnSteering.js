function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

export function migrateToV44(db) {
  if (!hasColumn(db, 'turn_execution_leases', 'accepting_steering')) {
    db.exec(`
      ALTER TABLE turn_execution_leases
      ADD COLUMN accepting_steering INTEGER NOT NULL DEFAULT 1
        CHECK (accepting_steering IN (0, 1));
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_steering_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      client_request_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'leased', 'consumed')),
      lease_id TEXT,
      lease_owner_id TEXT,
      leased_at INTEGER,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, session_id, turn_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_steering_pending
      ON turn_steering_messages(user_id, session_id, turn_id, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_turn_steering_user_created
      ON turn_steering_messages(user_id, created_at DESC);
  `)
}
