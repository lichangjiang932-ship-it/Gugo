import { randomUUID } from 'node:crypto'

import { hasColumn } from './index.js'

/** Add single-use recovery challenges for unknown model outcomes. */
export function migrateToV90(db) {
  if (!hasColumn(db, 'evolution_operations', 'recovery_challenge')) {
    db.exec('ALTER TABLE evolution_operations ADD COLUMN recovery_challenge TEXT')
  }
  if (!hasColumn(db, 'evolution_operations', 'recovery_revision')) {
    db.exec(`
      ALTER TABLE evolution_operations
      ADD COLUMN recovery_revision INTEGER NOT NULL DEFAULT 0
    `)
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE evolution_operations
      SET recovery_challenge = NULL
      WHERE NOT (state = 'blocked' AND stage = 'model_outcome_unknown')
        AND recovery_challenge IS NOT NULL
    `).run()

    const rows = db.prepare(`
      SELECT id, recovery_revision
      FROM evolution_operations
      WHERE state = 'blocked' AND stage = 'model_outcome_unknown'
        AND (
          recovery_challenge IS NULL
          OR length(recovery_challenge) <> 36
          OR recovery_revision < 1
        )
    `).all()
    const backfill = db.prepare(`
      UPDATE evolution_operations
      SET recovery_challenge = ?, recovery_revision = ?
      WHERE id = ? AND state = 'blocked' AND stage = 'model_outcome_unknown'
    `)
    for (const row of rows) {
      const previousRevision = Number.isSafeInteger(row.recovery_revision) && row.recovery_revision >= 0
        ? row.recovery_revision
        : 0
      backfill.run(randomUUID(), previousRevision + 1, row.id)
    }
  }).immediate()

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_evolution_operations_recovery_insert
    BEFORE INSERT ON evolution_operations
    WHEN (
      NEW.recovery_revision IS NULL
      OR typeof(NEW.recovery_revision) <> 'integer'
      OR NEW.recovery_revision < 0
    ) OR (
      NEW.state = 'blocked' AND NEW.stage = 'model_outcome_unknown'
      AND (NEW.recovery_challenge IS NULL OR length(NEW.recovery_challenge) <> 36 OR NEW.recovery_revision < 1)
    ) OR (
      NOT (NEW.state = 'blocked' AND NEW.stage = 'model_outcome_unknown')
      AND NEW.recovery_challenge IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid evolution operation recovery state');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_evolution_operations_recovery_update
    BEFORE UPDATE ON evolution_operations
    WHEN (
      NEW.recovery_revision IS NULL
      OR typeof(NEW.recovery_revision) <> 'integer'
      OR NEW.recovery_revision < 0
    ) OR (
      NEW.state = 'blocked' AND NEW.stage = 'model_outcome_unknown'
      AND (NEW.recovery_challenge IS NULL OR length(NEW.recovery_challenge) <> 36 OR NEW.recovery_revision < 1)
    ) OR (
      NOT (NEW.state = 'blocked' AND NEW.stage = 'model_outcome_unknown')
      AND NEW.recovery_challenge IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid evolution operation recovery state');
    END;
  `)
}
