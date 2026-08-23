const BARRIER_MESSAGE = 'runtime plugin mutation blocked by package lifecycle barrier'
const INVALID_JSON_MESSAGE = 'runtime plugin mutation blocked by invalid JSON reference during package lifecycle barrier'
const GENERATION_MESSAGE = 'runtime plugin mutation barrier generation invariant violated'
const PHASE_MESSAGE = 'runtime plugin mutation barrier phase transition invalid'
const RELEASE_IDENTITY_MESSAGE = 'runtime plugin state release identity mismatch'

function normalizedJsonPluginId(expression) {
  const whitespace = "' ' || char(9) || char(10) || char(11) || char(12) || char(13)"
  return `lower(trim(CAST(${expression} AS TEXT), ${whitespace}))`
}

function executionEnvironmentBarrierCondition(jsonExpression) {
  return `EXISTS (
    SELECT 1
    FROM json_tree(${jsonExpression}) AS environment
    WHERE environment.key = 'executionEnvironment'
      AND environment.type = 'object'
      AND (
        EXISTS (
          SELECT 1
          FROM json_each(environment.value, '$.runtimePlugins') AS plugin
          JOIN runtime_plugin_mutation_barriers AS barrier
            ON barrier.plugin_id = CASE
              WHEN plugin.type = 'object'
                THEN ${normalizedJsonPluginId("json_extract(plugin.value, '$.id')")}
              ELSE NULL
            END
        )
        OR EXISTS (
          SELECT 1
          FROM json_each(environment.value, '$.unpinnedPluginIds') AS unpinned
          JOIN runtime_plugin_mutation_barriers AS barrier
            ON barrier.plugin_id = ${normalizedJsonPluginId('unpinned.value')}
          WHERE unpinned.type = 'text'
        )
      )
  )`
}

function createIdentityTriggers(db, table) {
  const triggerBase = `trg_${table}_plugin_mutation_barrier`
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_insert
      BEFORE INSERT ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM runtime_plugin_mutation_barriers
        WHERE plugin_id = NEW.plugin_id
      )
      BEGIN
        SELECT RAISE(ABORT, '${BARRIER_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_update
      BEFORE UPDATE ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM runtime_plugin_mutation_barriers
        WHERE plugin_id = OLD.plugin_id OR plugin_id = NEW.plugin_id
      )
      BEGIN
        SELECT RAISE(ABORT, '${BARRIER_MESSAGE}');
      END;
  `)
}

function createJsonReferenceTriggers(db, table, jsonColumn) {
  const triggerBase = `trg_${table}_${jsonColumn}_plugin_mutation_barrier`
  const condition = `CASE
    WHEN json_valid(NEW.${jsonColumn}) = 1
      THEN ${executionEnvironmentBarrierCondition(`NEW.${jsonColumn}`)}
    ELSE 0
  END`
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_insert_invalid_json
      BEFORE INSERT ON ${table}
      WHEN EXISTS (SELECT 1 FROM runtime_plugin_mutation_barriers LIMIT 1)
        AND NEW.${jsonColumn} IS NOT NULL
        AND json_valid(NEW.${jsonColumn}) = 0
      BEGIN
        SELECT RAISE(ABORT, '${INVALID_JSON_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_insert
      BEFORE INSERT ON ${table}
      WHEN EXISTS (SELECT 1 FROM runtime_plugin_mutation_barriers LIMIT 1)
        AND NEW.${jsonColumn} IS NOT NULL
        AND ${condition}
      BEGIN
        SELECT RAISE(ABORT, '${BARRIER_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_update_invalid_json
      BEFORE UPDATE OF ${jsonColumn} ON ${table}
      WHEN EXISTS (SELECT 1 FROM runtime_plugin_mutation_barriers LIMIT 1)
        AND NEW.${jsonColumn} IS NOT NULL
        AND json_valid(NEW.${jsonColumn}) = 0
      BEGIN
        SELECT RAISE(ABORT, '${INVALID_JSON_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS ${triggerBase}_update
      BEFORE UPDATE OF ${jsonColumn} ON ${table}
      WHEN EXISTS (SELECT 1 FROM runtime_plugin_mutation_barriers LIMIT 1)
        AND NEW.${jsonColumn} IS NOT NULL
        AND ${condition}
      BEGIN
        SELECT RAISE(ABORT, '${BARRIER_MESSAGE}');
      END;
  `)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

function runtimePluginStateReleaseColumns(db) {
  return [
    'active_release_id',
    'previous_release_id',
    'last_rollback_from_release_id',
    'last_rollback_to_release_id',
  ].filter((column) => hasColumn(db, 'runtime_plugin_states', column))
}

function assertRuntimePluginStateReleaseIdentities(db, releaseColumns) {
  for (const column of releaseColumns) {
    const invalid = db.prepare(`
      SELECT state.plugin_id, state.${column} AS release_id
      FROM runtime_plugin_states AS state
      LEFT JOIN runtime_plugin_releases AS release
        ON release.release_id = state.${column}
        AND release.plugin_id = state.plugin_id
      WHERE state.${column} IS NOT NULL
        AND release.release_id IS NULL
      LIMIT 1
    `).get()
    if (invalid) throw new Error(RELEASE_IDENTITY_MESSAGE)
  }
}

function createRuntimePluginStateReleaseIdentityTriggers(db, releaseColumns) {
  if (releaseColumns.length === 0) return

  const mismatchCondition = releaseColumns.map((column) => `(
    NEW.${column} IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM runtime_plugin_releases AS release
      WHERE release.release_id = NEW.${column}
        AND release.plugin_id = NEW.plugin_id
    )
  )`).join('\n        OR ')
  const updateColumns = releaseColumns.join(', ')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_states_release_identity_insert
      BEFORE INSERT ON runtime_plugin_states
      WHEN ${mismatchCondition}
      BEGIN
        SELECT RAISE(ABORT, '${RELEASE_IDENTITY_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_states_release_identity_update
      BEFORE UPDATE OF plugin_id, ${updateColumns} ON runtime_plugin_states
      WHEN ${mismatchCondition}
      BEGIN
        SELECT RAISE(ABORT, '${RELEASE_IDENTITY_MESSAGE}');
      END;
  `)
}

/**
 * Persist a fail-closed, cross-process package lifecycle barrier.
 *
 * A barrier row never expires automatically. Heartbeats are recovery evidence,
 * not permission to bypass an owner that may merely be paused. All writes that
 * can create a runtime-plugin dependency are guarded in SQLite so a second
 * process cannot race the uninstall safety check.
 */
export function migrateToV103(db) {
  const releaseColumns = runtimePluginStateReleaseColumns(db)
  // The triggers below protect only future writes. Refuse to bless an older
  // database that already contains a missing or cross-plugin Release pointer.
  assertRuntimePluginStateReleaseIdentities(db, releaseColumns)

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_plugin_mutation_barrier_generations (
      plugin_id TEXT PRIMARY KEY
        CHECK (
          length(plugin_id) BETWEEN 1 AND 80
          AND substr(plugin_id, 1, 1) GLOB '[a-z0-9]'
          AND plugin_id NOT GLOB '*[^a-z0-9-]*'
        ),
      last_generation INTEGER NOT NULL
        CHECK (last_generation BETWEEN 1 AND 9007199254740991),
      generation_claimed INTEGER NOT NULL DEFAULT 0
        CHECK (generation_claimed IN (0, 1)),
      UNIQUE (plugin_id, last_generation)
    );

    CREATE TABLE IF NOT EXISTS runtime_plugin_mutation_barriers (
      plugin_id TEXT PRIMARY KEY
        REFERENCES runtime_plugin_mutation_barrier_generations(plugin_id)
          ON DELETE RESTRICT,
      token TEXT NOT NULL UNIQUE CHECK (length(token) BETWEEN 16 AND 128),
      generation INTEGER NOT NULL
        CHECK (generation BETWEEN 1 AND 9007199254740991),
      operation TEXT NOT NULL CHECK (operation = 'uninstall'),
      phase TEXT NOT NULL CHECK (phase IN (
        'guarding', 'mutating', 'refreshing', 'recovery_required'
      )),
      owner_pid INTEGER NOT NULL CHECK (owner_pid >= 0),
      store_revision TEXT CHECK (
        store_revision IS NULL
        OR (
          length(store_revision) = 71
          AND store_revision LIKE 'sha256-%'
          AND substr(store_revision, 8) NOT GLOB '*[^0-9a-f]*'
        )
      ),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= created_at),
      recovery_required INTEGER NOT NULL DEFAULT 0
        CHECK (recovery_required IN (0, 1)),
      CHECK (
        (recovery_required = 0 AND phase IN ('guarding', 'mutating', 'refreshing'))
        OR (recovery_required = 1 AND phase = 'recovery_required')
      )
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_plugin_mutation_barriers_heartbeat
      ON runtime_plugin_mutation_barriers(heartbeat_at ASC, plugin_id ASC);

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_insert
      BEFORE INSERT ON runtime_plugin_mutation_barrier_generations
      WHEN NOT (
        NEW.generation_claimed = 0
        AND (
          (
            NEW.last_generation = 1
            AND NOT EXISTS (
              SELECT 1 FROM runtime_plugin_mutation_barrier_generations AS current
              WHERE current.plugin_id = NEW.plugin_id
            )
          )
          OR EXISTS (
            SELECT 1 FROM runtime_plugin_mutation_barrier_generations AS current
            WHERE current.plugin_id = NEW.plugin_id
              AND current.generation_claimed = 1
              AND NEW.last_generation = current.last_generation + 1
              AND NOT EXISTS (
                SELECT 1 FROM runtime_plugin_mutation_barriers AS barrier
                WHERE barrier.plugin_id = NEW.plugin_id
              )
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, '${GENERATION_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_update
      BEFORE UPDATE ON runtime_plugin_mutation_barrier_generations
      WHEN NOT (
        NEW.plugin_id = OLD.plugin_id
        AND (
          (
            OLD.generation_claimed = 1
            AND NEW.generation_claimed = 0
            AND NEW.last_generation = OLD.last_generation + 1
            AND NOT EXISTS (
              SELECT 1 FROM runtime_plugin_mutation_barriers AS barrier
              WHERE barrier.plugin_id = OLD.plugin_id
            )
          )
          OR (
            OLD.generation_claimed = 0
            AND NEW.generation_claimed = 1
            AND NEW.last_generation = OLD.last_generation
            AND EXISTS (
              SELECT 1 FROM runtime_plugin_mutation_barriers AS barrier
              WHERE barrier.plugin_id = OLD.plugin_id
                AND barrier.generation = OLD.last_generation
            )
          )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, '${GENERATION_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_delete
      BEFORE DELETE ON runtime_plugin_mutation_barrier_generations
      BEGIN
        SELECT RAISE(ABORT, '${GENERATION_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_match_insert
      BEFORE INSERT ON runtime_plugin_mutation_barriers
      WHEN NOT EXISTS (
        SELECT 1
        FROM runtime_plugin_mutation_barrier_generations AS generation
        WHERE generation.plugin_id = NEW.plugin_id
          AND generation.last_generation = NEW.generation
          AND generation.generation_claimed = 0
      )
      BEGIN
        SELECT RAISE(ABORT, '${GENERATION_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_claim_insert
      AFTER INSERT ON runtime_plugin_mutation_barriers
      BEGIN
        UPDATE runtime_plugin_mutation_barrier_generations
        SET generation_claimed = 1
        WHERE plugin_id = NEW.plugin_id
          AND last_generation = NEW.generation
          AND generation_claimed = 0;
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_generation_identity_update
      BEFORE UPDATE OF plugin_id, generation ON runtime_plugin_mutation_barriers
      WHEN NEW.plugin_id <> OLD.plugin_id OR NEW.generation <> OLD.generation
      BEGIN
        SELECT RAISE(ABORT, '${GENERATION_MESSAGE}');
      END;

    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_mutation_barrier_phase_update
      BEFORE UPDATE OF phase, recovery_required ON runtime_plugin_mutation_barriers
      WHEN NOT (
        (
          NEW.phase = OLD.phase
          AND NEW.recovery_required = OLD.recovery_required
        )
        OR (
          OLD.phase = 'guarding'
          AND OLD.recovery_required = 0
          AND NEW.phase = 'mutating'
          AND NEW.recovery_required = 0
        )
        OR (
          OLD.phase = 'mutating'
          AND OLD.recovery_required = 0
          AND NEW.phase = 'refreshing'
          AND NEW.recovery_required = 0
        )
        OR (
          OLD.recovery_required = 0
          AND NEW.phase = 'recovery_required'
          AND NEW.recovery_required = 1
        )
      )
      BEGIN
        SELECT RAISE(ABORT, '${PHASE_MESSAGE}');
      END;
  `)

  for (const table of [
    'runtime_plugin_states',
    'runtime_plugin_releases',
    'runtime_plugin_release_pins',
    'runtime_plugin_permission_grants',
  ]) {
    createIdentityTriggers(db, table)
  }

  createRuntimePluginStateReleaseIdentityTriggers(db, releaseColumns)

  createJsonReferenceTriggers(db, 'turn_checkpoints', 'state_json')
  createJsonReferenceTriggers(db, 'job_turn_checkpoints', 'state_json')
  createJsonReferenceTriggers(db, 'turn_events', 'payload_json')
  createJsonReferenceTriggers(db, 'event_write_failures', 'checkpoint_state_json')
  if (hasColumn(db, 'event_write_failures', 'payload_json')) {
    createJsonReferenceTriggers(db, 'event_write_failures', 'payload_json')
  }
}
