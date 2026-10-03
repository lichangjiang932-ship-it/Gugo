/**
 * Embedding-space identity for the memory vector index.
 *
 * `model` + `dimensions` is not enough to decide whether two vectors are
 * comparable: two different models with the same output width live in
 * unrelated coordinate systems, and the same model served by a different
 * endpoint can be a different deployment. Comparing them produces meaningless
 * similarity and wrong ranking, silently.
 *
 * `embedding_space` records the identity of the space a vector was produced in.
 * Rows written before this column existed are explicitly marked as unknown, so
 * they are re-indexed instead of being trusted.
 */
function tableHasColumn(db, table, column) {
  return db.prepare('SELECT name FROM pragma_table_info(?)').all(table)
    .some((row) => row.name === column)
}

export function migrateToV119(db) {
  if (!tableHasColumn(db, 'memory_embeddings', 'embedding_space')) {
    // CHECK constraints cannot be added by ALTER, so the column stays nullable;
    // the service treats a missing/unknown space as "not comparable".
    db.exec('ALTER TABLE memory_embeddings ADD COLUMN embedding_space TEXT')
  }
  db.exec(`
    UPDATE memory_embeddings
    SET embedding_space = 'unknown'
    WHERE embedding_space IS NULL OR embedding_space = '';
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_space
      ON memory_embeddings(user_id, embedding_space);
  `)
}
