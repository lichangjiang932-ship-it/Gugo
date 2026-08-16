/**
 * Keep the mutable tool-loop checkpoint out of the append-only turn event log.
 * One row per turn makes checkpoint storage proportional to the latest state
 * instead of retaining a growing copy after every tool boundary.
 */
export function migrateToV51(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_updated
      ON turn_checkpoints(user_id, updated_at DESC);
  `)
}
