/**
 * Local vector index for long-term memory semantic recall.
 *
 * One row per memory. `content_fingerprint` lets retrieval detect a stale
 * vector after the memory body is edited, without comparing full text. The
 * table is additive and empty by default: with embeddings disabled nothing
 * writes or reads it, so lexical recall keeps working unchanged.
 */
export function migrateToV117(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
      dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 8192),
      vector BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
      content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_user
      ON memory_embeddings(user_id, updated_at);
  `)
}
