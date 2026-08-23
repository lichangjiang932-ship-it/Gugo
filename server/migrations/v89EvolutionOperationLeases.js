import { hasColumn } from './index.js'

/** Add durable leases without trusting legacy running rows as live workers. */
export function migrateToV89(db) {
  if (!hasColumn(db, 'evolution_operations', 'lease_owner_id')) {
    db.exec('ALTER TABLE evolution_operations ADD COLUMN lease_owner_id TEXT')
  }
  if (!hasColumn(db, 'evolution_operations', 'lease_expires_at')) {
    db.exec('ALTER TABLE evolution_operations ADD COLUMN lease_expires_at INTEGER')
  }

  // A process that applied v88 may have died with a running row. Preserve its
  // worker fence, but make the lease immediately expired so recovery must move
  // through the explicit unknown-outcome review path.
  db.exec(`
    UPDATE evolution_operations
    SET lease_owner_id = CASE
          WHEN state = 'running' THEN COALESCE(lease_owner_id, 'legacy:' || worker_token)
          ELSE NULL
        END,
        lease_expires_at = CASE
          WHEN state = 'running' THEN COALESCE(lease_expires_at, 0)
          ELSE NULL
        END
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_evolution_operations_lease
      ON evolution_operations(state, lease_expires_at, id);

    CREATE TRIGGER IF NOT EXISTS trg_evolution_operations_lease_insert
    BEFORE INSERT ON evolution_operations
    WHEN (
      NEW.state = 'running'
      AND (NEW.worker_token IS NULL OR NEW.lease_owner_id IS NULL OR NEW.lease_expires_at IS NULL)
    ) OR (
      NEW.state <> 'running'
      AND (NEW.worker_token IS NOT NULL OR NEW.lease_owner_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid evolution operation lease state');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_evolution_operations_lease_update
    BEFORE UPDATE ON evolution_operations
    WHEN (
      NEW.state = 'running'
      AND (NEW.worker_token IS NULL OR NEW.lease_owner_id IS NULL OR NEW.lease_expires_at IS NULL)
    ) OR (
      NEW.state <> 'running'
      AND (NEW.worker_token IS NOT NULL OR NEW.lease_owner_id IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid evolution operation lease state');
    END;
  `)
}
