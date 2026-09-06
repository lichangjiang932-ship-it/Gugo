import { databaseSchemaIncompleteError } from '../dbSchemaContract.js'
import {
  collectSessionTranscriptRecoverySchemaProblems,
} from '../sessionTranscriptRecoverySchemaContract.js'

/** Keep explicit transcript mutations authoritative without deleting audit events. */
export function migrateToV116(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_transcript_recovery_fences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      suppressed_through_sequence INTEGER NOT NULL CHECK (
        typeof(suppressed_through_sequence) = 'integer' AND suppressed_through_sequence >= -1
      ),
      PRIMARY KEY (user_id, session_id, turn_id)
    );
  `)
  const missing = collectSessionTranscriptRecoverySchemaProblems(db)
  if (missing.length) {
    throw databaseSchemaIncompleteError({
      expectedVersion: 116,
      stage: 'migration-v116',
      missing,
    })
  }
}
