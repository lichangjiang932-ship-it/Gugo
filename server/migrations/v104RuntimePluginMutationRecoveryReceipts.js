const IMMUTABLE_MESSAGE = 'runtime plugin mutation recovery receipts are append-only'

/** Persist the evidence that authorized releasing a recovery-required barrier. */
export function migrateToV104(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_mutation_recovery_receipts (
      receipt_id TEXT PRIMARY KEY
        CHECK (length(receipt_id) BETWEEN 16 AND 128),
      plugin_id TEXT NOT NULL
        CHECK (
          length(plugin_id) BETWEEN 1 AND 80
          AND substr(plugin_id, 1, 1) GLOB '[a-z0-9]'
          AND plugin_id NOT GLOB '*[^a-z0-9-]*'
        ),
      generation INTEGER NOT NULL
        CHECK (generation BETWEEN 1 AND 9007199254740991),
      operation TEXT NOT NULL CHECK (operation = 'uninstall'),
      token_fingerprint TEXT NOT NULL
        CHECK (
          length(token_fingerprint) = 71
          AND token_fingerprint LIKE 'sha256-%'
          AND substr(token_fingerprint, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      barrier_store_revision TEXT CHECK (
        barrier_store_revision IS NULL
        OR (
          length(barrier_store_revision) = 71
          AND barrier_store_revision LIKE 'sha256-%'
          AND substr(barrier_store_revision, 8) NOT GLOB '*[^0-9a-f]*'
        )
      ),
      observed_store_revision TEXT NOT NULL
        CHECK (
          length(observed_store_revision) = 71
          AND observed_store_revision LIKE 'sha256-%'
          AND substr(observed_store_revision, 8) NOT GLOB '*[^0-9a-f]*'
        ),
      evidence_json TEXT NOT NULL
        CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
      verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
      UNIQUE (plugin_id, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_mutation_recovery_receipts_plugin_time
      ON runtime_plugin_mutation_recovery_receipts(plugin_id, verified_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_recovery_receipts_update
      BEFORE UPDATE ON runtime_plugin_mutation_recovery_receipts
      BEGIN
        SELECT RAISE(ABORT, '${IMMUTABLE_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_recovery_receipts_delete
      BEFORE DELETE ON runtime_plugin_mutation_recovery_receipts
      BEGIN
        SELECT RAISE(ABORT, '${IMMUTABLE_MESSAGE}');
      END;
  `)
}
