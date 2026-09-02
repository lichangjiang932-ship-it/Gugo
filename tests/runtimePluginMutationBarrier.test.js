import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import Database from '../server/adapters/sqliteDriver.js'

import {
  createSchemaMigrationPlan,
  LATEST_SCHEMA_VERSION,
  runSchemaMigrations,
} from '../server/migrations/index.js'
import { migrateToV103 } from '../server/migrations/v103RuntimePluginMutationBarrier.js'
import { migrateToV104 } from '../server/migrations/v104RuntimePluginMutationRecoveryReceipts.js'
import {
  acquireRuntimePluginMutationBarrier,
  assertRuntimePluginMutationAvailable,
  completeRuntimePluginMutationBarrierRecovery,
  getRuntimePluginMutationBarrier,
  heartbeatRuntimePluginMutationBarrier,
  markRuntimePluginMutationBarrierRecoveryRequired,
  listRuntimePluginMutationBarriers,
  releaseRuntimePluginMutationBarrier,
} from '../server/services/runtimePluginMutationBarrierStore.js'

function createBarrierPrerequisites(db) {
  db.exec(`
    CREATE TABLE runtime_plugin_states (
      plugin_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      active_release_id TEXT,
      previous_release_id TEXT,
      last_rollback_from_release_id TEXT,
      last_rollback_to_release_id TEXT
    );
    CREATE TABLE runtime_plugin_releases (
      release_id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL
    );
    CREATE TABLE runtime_plugin_release_pins (
      plugin_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      PRIMARY KEY (plugin_id, release_id, reference_kind, reference_id)
    );
    CREATE TABLE runtime_plugin_permission_grants (plugin_id TEXT PRIMARY KEY);
    CREATE TABLE turn_checkpoints (turn_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE job_turn_checkpoints (step_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE turn_events (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
    CREATE TABLE event_write_failures (
      id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL DEFAULT '{}',
      checkpoint_state_json TEXT
    );
  `)
}

function migrateSchemaThrough(db, targetVersion) {
  let currentVersion = 0
  for (const migration of createSchemaMigrationPlan()) {
    if (migration.version > targetVersion) break
    const applyMigration = () => {
      migration.up(db)
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(migration.version))
    }
    if (migration.atomicWithVersion) db.transaction(applyMigration).immediate()
    else applyMigration()
    currentVersion = migration.version
  }
  return currentVersion
}

function createBarrierDatabasePair() {
  const directory = mkdtempSync(join(tmpdir(), 'gugo-runtime-plugin-barrier-'))
  const filename = join(directory, 'barrier.sqlite')
  const owner = new Database(filename)
  owner.pragma('journal_mode = WAL')
  createBarrierPrerequisites(owner)
  migrateToV103(owner)
  migrateToV104(owner)
  const peer = new Database(filename)
  peer.pragma('busy_timeout = 1000')
  return {
    owner,
    peer,
    close() {
      peer.close()
      owner.close()
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

test('migration refuses pre-existing missing or cross-plugin Release pointers', () => {
  const db = new Database(':memory:')
  try {
    createBarrierPrerequisites(db)
    db.prepare(`
      INSERT INTO runtime_plugin_releases (release_id, plugin_id) VALUES (?, ?)
    `).run('sample-release', 'sample-plugin')
    db.prepare(`
      INSERT INTO runtime_plugin_states (plugin_id, active_release_id) VALUES (?, ?)
    `).run('other-plugin', 'sample-release')

    assert.throws(
      () => migrateToV103(db),
      (error) => error?.message === 'runtime plugin state release identity mismatch',
    )
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_plugin_mutation_barriers'
    `).get().count, 0)
  } finally {
    db.close()
  }
})

function errorCode(code) {
  return (error) => error?.code === code
}

function recoveryEvidence(barrier, overrides = {}) {
  return {
    outcome: 'uninstalled',
    recoveryAuthorization: barrier.recoveryRequired
      ? 'explicit_recovery_required'
      : 'owner_process_not_alive',
    barrierPhase: barrier.phase,
    barrierOwnerPid: barrier.ownerPid,
    barrierHeartbeatAt: barrier.heartbeatAt,
    barrierStoreRevision: barrier.storeRevision,
    barrierRecoveryRequired: barrier.recoveryRequired,
    observedStoreRevision: `sha256-${'2'.repeat(64)}`,
    registryRevision: 2,
    packageDigest: null,
    diskInstalled: false,
    registryPresent: false,
    runtimeInventoryPresent: false,
    runtimeStatePresent: false,
    permissionGrantPresent: false,
    runtimeEnabled: false,
    runtimeActive: false,
    runtimeState: 'inactive',
    releaseCount: 0,
    pinCount: 0,
    checkpointCount: 0,
    referenceCount: 0,
    referenceDigest: `sha256-${'3'.repeat(64)}`,
    ...overrides,
  }
}

test('a durable barrier blocks a second connection and does not expire from heartbeat age', () => {
  const pair = createBarrierDatabasePair()
  try {
    const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      ownerPid: 101,
      now: 100,
    })
    assert.equal(lease.generation, 1)
    assert.equal(Object.isFrozen(lease), true)

    assert.throws(
      () => acquireRuntimePluginMutationBarrier('sample-plugin', {
        db: pair.peer,
        token: 'barrier-token-0002',
        ownerPid: 202,
        now: 9_999_999,
      }),
      errorCode('PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE'),
    )
    assert.throws(
      () => assertRuntimePluginMutationAvailable('sample-plugin', { db: pair.peer }),
      errorCode('PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE'),
    )
    assert.throws(
      () => pair.peer.prepare(
        "INSERT INTO runtime_plugin_states (plugin_id) VALUES ('sample-plugin')",
      ).run(),
      /runtime plugin mutation blocked by package lifecycle barrier/u,
    )
    assert.deepEqual(getRuntimePluginMutationBarrier('sample-plugin', { db: pair.peer }), {
      pluginId: 'sample-plugin',
      generation: 1,
      operation: 'uninstall',
      phase: 'guarding',
      ownerPid: 101,
      storeRevision: null,
      createdAt: 100,
      heartbeatAt: 100,
      recoveryRequired: false,
    })
  } finally {
    pair.close()
  }
})

test('barrier release is fenced by token and monotonically increasing generation', () => {
  const pair = createBarrierDatabasePair()
  try {
    const first = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    assert.throws(
      () => releaseRuntimePluginMutationBarrier({
        pluginId: 'sample-plugin',
        token: 'barrier-token-wrong',
        generation: first.generation,
        db: pair.peer,
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_OWNERSHIP_LOST'),
    )
    assert.equal(releaseRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: first.token,
      generation: first.generation,
      db: pair.peer,
    }), true)

    const second = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.peer,
      token: 'barrier-token-0002',
      now: 200,
    })
    assert.equal(second.generation, first.generation + 1)
    assert.throws(
      () => releaseRuntimePluginMutationBarrier({
        pluginId: 'sample-plugin',
        token: first.token,
        generation: first.generation,
        db: pair.owner,
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_OWNERSHIP_LOST'),
    )
    assert.equal(
      getRuntimePluginMutationBarrier('sample-plugin', { db: pair.owner }).generation,
      second.generation,
    )
    assert.equal(releaseRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: second.token,
      generation: second.generation,
      db: pair.owner,
    }), true)
    assert.equal(assertRuntimePluginMutationAvailable('sample-plugin', { db: pair.peer }), true)
  } finally {
    pair.close()
  }
})

test('a recovery-required barrier cannot be heartbeated or normally released', () => {
  const pair = createBarrierDatabasePair()
  try {
    const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    const recovery = markRuntimePluginMutationBarrierRecoveryRequired({
      pluginId: 'sample-plugin',
      token: lease.token,
      generation: lease.generation,
      now: 200,
      db: pair.owner,
    })
    assert.equal(recovery.phase, 'recovery_required')
    assert.equal(recovery.recoveryRequired, true)
    assert.throws(
      () => heartbeatRuntimePluginMutationBarrier({
        pluginId: 'sample-plugin',
        token: lease.token,
        generation: lease.generation,
        now: 300,
        db: pair.peer,
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_RECOVERY_REQUIRED'),
    )
    assert.throws(
      () => releaseRuntimePluginMutationBarrier({
        pluginId: 'sample-plugin',
        token: lease.token,
        generation: lease.generation,
        db: pair.peer,
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_RECOVERY_REQUIRED'),
    )
    assert.equal(
      getRuntimePluginMutationBarrier('sample-plugin', { db: pair.peer }).recoveryRequired,
      true,
    )
  } finally {
    pair.close()
  }
})

test('verified recovery atomically appends an immutable receipt and releases only the exact generation', () => {
  const pair = createBarrierDatabasePair()
  try {
    const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      storeRevision: `sha256-${'1'.repeat(64)}`,
      now: 100,
    })
    assert.throws(
      () => completeRuntimePluginMutationBarrierRecovery({
        pluginId: 'sample-plugin',
        generation: lease.generation,
        receiptId: 'recovery-receipt-0001',
        now: 200,
        db: pair.peer,
        evidence: {
          outcome: 'uninstalled',
          recoveryAuthorization: 'explicit_recovery_required',
          barrierPhase: 'recovery_required',
          barrierOwnerPid: lease.ownerPid,
          barrierHeartbeatAt: 150,
          barrierStoreRevision: lease.storeRevision,
          barrierRecoveryRequired: true,
          observedStoreRevision: `sha256-${'2'.repeat(64)}`,
          registryRevision: 2,
          packageDigest: null,
          diskInstalled: false,
          registryPresent: false,
          runtimeInventoryPresent: false,
          runtimeStatePresent: false,
          permissionGrantPresent: false,
          runtimeEnabled: false,
          runtimeActive: false,
          runtimeState: 'inactive',
          releaseCount: 0,
          pinCount: 0,
          checkpointCount: 0,
          referenceCount: 0,
          referenceDigest: `sha256-${'3'.repeat(64)}`,
        },
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_OWNERSHIP_LOST'),
    )
    markRuntimePluginMutationBarrierRecoveryRequired({
      pluginId: 'sample-plugin',
      token: lease.token,
      generation: lease.generation,
      now: 150,
      db: pair.owner,
    })
    const evidence = {
      outcome: 'uninstalled',
      recoveryAuthorization: 'explicit_recovery_required',
      barrierPhase: 'recovery_required',
      barrierOwnerPid: lease.ownerPid,
      barrierHeartbeatAt: 150,
      barrierStoreRevision: lease.storeRevision,
      barrierRecoveryRequired: true,
      observedStoreRevision: `sha256-${'2'.repeat(64)}`,
      registryRevision: 2,
      packageDigest: null,
      diskInstalled: false,
      registryPresent: false,
      runtimeInventoryPresent: false,
      runtimeStatePresent: false,
      permissionGrantPresent: false,
      runtimeEnabled: false,
      runtimeActive: false,
      runtimeState: 'inactive',
      releaseCount: 0,
      pinCount: 0,
      checkpointCount: 0,
      referenceCount: 0,
      referenceDigest: `sha256-${'3'.repeat(64)}`,
    }
    const receipt = completeRuntimePluginMutationBarrierRecovery({
      pluginId: 'sample-plugin',
      generation: lease.generation,
      evidence,
      receiptId: 'recovery-receipt-0001',
      now: 200,
      db: pair.peer,
    })
    assert.equal(receipt.pluginId, 'sample-plugin')
    assert.equal(receipt.generation, lease.generation)
    assert.equal(receipt.tokenFingerprint.startsWith('sha256-'), true)
    assert.equal(JSON.stringify(receipt).includes(lease.token), false)
    assert.equal(getRuntimePluginMutationBarrier('sample-plugin', { db: pair.owner }), null)
    assert.deepEqual(listRuntimePluginMutationBarriers({ db: pair.owner }), [])
    const persisted = pair.owner.prepare(`
      SELECT plugin_id, generation, evidence_json
      FROM runtime_plugin_mutation_recovery_receipts
      WHERE receipt_id = ?
    `).get('recovery-receipt-0001')
    assert.equal(persisted.plugin_id, 'sample-plugin')
    assert.equal(persisted.generation, lease.generation)
    assert.deepEqual(JSON.parse(persisted.evidence_json), { schemaVersion: 1, ...evidence })
    assert.throws(
      () => pair.owner.prepare(`
        DELETE FROM runtime_plugin_mutation_recovery_receipts WHERE receipt_id = ?
      `).run('recovery-receipt-0001'),
      /recovery receipts are append-only/u,
    )
  } finally {
    pair.close()
  }
})

for (const phase of ['guarding', 'mutating', 'refreshing']) {
  test(`an orphaned ${phase} barrier can be recovered only from its exact snapshot`, () => {
    const pair = createBarrierDatabasePair()
    try {
      const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
        db: pair.owner,
        token: `barrier-token-${phase}`,
        ownerPid: 999_999,
        storeRevision: `sha256-${'1'.repeat(64)}`,
        now: 100,
      })
      if (phase === 'refreshing') {
        heartbeatRuntimePluginMutationBarrier({
          pluginId: 'sample-plugin',
          token: lease.token,
          generation: lease.generation,
          phase: 'mutating',
          now: 125,
          db: pair.owner,
        })
      }
      if (phase !== 'guarding') {
        heartbeatRuntimePluginMutationBarrier({
          pluginId: 'sample-plugin',
          token: lease.token,
          generation: lease.generation,
          phase,
          now: 150,
          db: pair.owner,
        })
      }
      const barrier = getRuntimePluginMutationBarrier('sample-plugin', { db: pair.peer })
      const receipt = completeRuntimePluginMutationBarrierRecovery({
        pluginId: 'sample-plugin',
        generation: barrier.generation,
        evidence: recoveryEvidence(barrier),
        receiptId: `orphan-receipt-${phase}`,
        now: 200,
        db: pair.peer,
      })
      assert.equal(receipt.evidence.recoveryAuthorization, 'owner_process_not_alive')
      assert.equal(receipt.evidence.barrierPhase, phase)
      assert.equal(getRuntimePluginMutationBarrier('sample-plugin', { db: pair.owner }), null)
    } finally {
      pair.close()
    }
  })
}

test('recovery snapshot drift rolls back both receipt and barrier deletion', () => {
  const pair = createBarrierDatabasePair()
  try {
    const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-drift',
      ownerPid: 999_999,
      now: 100,
    })
    const barrier = getRuntimePluginMutationBarrier('sample-plugin', { db: pair.owner })
    pair.owner.exec(`
      CREATE TRIGGER test_recovery_snapshot_drift
      AFTER INSERT ON runtime_plugin_mutation_recovery_receipts
      BEGIN
        UPDATE runtime_plugin_mutation_barriers
        SET heartbeat_at = heartbeat_at + 1
        WHERE plugin_id = NEW.plugin_id AND generation = NEW.generation;
      END;
    `)
    assert.throws(
      () => completeRuntimePluginMutationBarrierRecovery({
        pluginId: 'sample-plugin',
        generation: lease.generation,
        evidence: recoveryEvidence(barrier),
        receiptId: 'recovery-receipt-drift',
        now: 200,
        db: pair.owner,
      }),
      errorCode('PLUGIN_LIFECYCLE_BARRIER_OWNERSHIP_LOST'),
    )
    assert.equal(pair.owner.prepare(`
      SELECT COUNT(*) AS count FROM runtime_plugin_mutation_recovery_receipts
    `).get().count, 0)
    assert.deepEqual(
      getRuntimePluginMutationBarrier('sample-plugin', { db: pair.owner }),
      barrier,
    )
  } finally {
    pair.close()
  }
})

test('event write failure payloads cannot add a barred runtime plugin reference', () => {
  const pair = createBarrierDatabasePair()
  try {
    acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    const payload = JSON.stringify({
      nested: {
        executionEnvironment: {
          runtimePlugins: [{ id: 'sample-plugin', releaseId: 'release-1' }],
          unpinnedPluginIds: [],
        },
      },
    })
    assert.throws(
      () => pair.peer.prepare(`
        INSERT INTO event_write_failures (id, payload_json)
        VALUES (?, ?)
      `).run(1, payload),
      (error) => {
        assert.equal(
          error?.message,
          'runtime plugin mutation blocked by package lifecycle barrier',
        )
        return true
      },
    )
    assert.equal(
      pair.peer.prepare('SELECT COUNT(*) AS count FROM event_write_failures').get().count,
      0,
    )
  } finally {
    pair.close()
  }
})

test('non-canonical JSON plugin ids cannot bypass a canonical barrier', () => {
  const pair = createBarrierDatabasePair()
  try {
    acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    const references = [
      { runtimePlugins: [{ id: 'SAMPLE-PLUGIN' }], unpinnedPluginIds: [] },
      { runtimePlugins: [{ id: '  sample-plugin  ' }], unpinnedPluginIds: [] },
      { runtimePlugins: [{ id: '\tsample-plugin\r\n' }], unpinnedPluginIds: [] },
      { runtimePlugins: [], unpinnedPluginIds: ['SAMPLE-PLUGIN'] },
    ]
    for (const [index, executionEnvironment] of references.entries()) {
      assert.throws(
        () => pair.peer.prepare(`
          INSERT INTO turn_checkpoints (turn_id, state_json) VALUES (?, ?)
        `).run(`turn-${index}`, JSON.stringify({ executionEnvironment })),
        /runtime plugin mutation blocked by package lifecycle barrier/u,
      )
    }
  } finally {
    pair.close()
  }
})

test('schema 103 upgrade recreates stale identity and JSON barrier triggers', () => {
  const db = new Database(':memory:')
  try {
    assert.equal(migrateSchemaThrough(db, 103), 103)
    db.exec(`
      DROP TRIGGER trg_runtime_plugin_states_release_identity_update;
      DROP TRIGGER trg_turn_checkpoints_state_json_plugin_mutation_barrier_insert;
    `)
    assert.equal(runSchemaMigrations(db), LATEST_SCHEMA_VERSION)
    assert.equal(
      Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value),
      LATEST_SCHEMA_VERSION,
    )
    const evolutionRunTable = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'evolution_auto_runs'
    `).get()
    assert.match(evolutionRunTable?.sql || '', /session_ids_json/u)
    assert.match(evolutionRunTable?.sql || '', /'promoted'/u)
    db.prepare(`INSERT INTO runtime_plugin_releases (
      release_id, plugin_id, source_digest, source_text, plugin_snapshot_json,
      validation_status, health_status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'passed', 'passed', ?)`)
      .run(
        'sample-release',
        'sample-plugin',
        `sha256-${'a'.repeat(64)}`,
        'source',
        '{"id":"sample-plugin"}',
        1,
      )
    db.prepare(`
      INSERT INTO runtime_plugin_states (plugin_id, updated_at) VALUES (?, ?)
    `).run('other-plugin', 1)
    acquireRuntimePluginMutationBarrier('sample-plugin', {
      db,
      token: 'barrier-token-0001',
      now: 100,
    })

    assert.throws(
      () => db.prepare(`
        UPDATE runtime_plugin_states SET active_release_id = ? WHERE plugin_id = ?
      `).run('sample-release', 'other-plugin'),
      /runtime plugin state release identity mismatch/u,
    )
    assert.throws(
      () => db.prepare(`
        INSERT INTO turn_checkpoints (turn_id, state_json) VALUES (?, ?)
      `).run('turn-stale-v103', JSON.stringify({
        executionEnvironment: {
          runtimePlugins: [{ id: 'SAMPLE-PLUGIN' }],
          unpinnedPluginIds: [],
        },
      })),
      /runtime plugin mutation blocked by package lifecycle barrier/u,
    )
  } finally {
    db.close()
  }
})

test('malformed reference JSON fails closed with a stable barrier error', () => {
  const pair = createBarrierDatabasePair()
  try {
    acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    for (const write of [
      () => pair.peer.prepare(`
        INSERT INTO turn_checkpoints (turn_id, state_json) VALUES (?, ?)
      `).run('turn-1', '{'),
      () => pair.peer.prepare(`
        INSERT INTO event_write_failures (id, payload_json) VALUES (?, ?)
      `).run(1, '[invalid'),
    ]) {
      assert.throws(write, (error) => {
        assert.equal(
          error?.message,
          'runtime plugin mutation blocked by invalid JSON reference during package lifecycle barrier',
        )
        assert.notEqual(error?.message, 'malformed JSON')
        return true
      })
    }
  } finally {
    pair.close()
  }
})

test('barrier phases advance monotonically and cannot move backward', () => {
  const pair = createBarrierDatabasePair()
  try {
    const lease = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    const mutating = heartbeatRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: lease.token,
      generation: lease.generation,
      phase: 'mutating',
      now: 200,
      db: pair.owner,
    })
    assert.equal(mutating.phase, 'mutating')
    assert.throws(
      () => heartbeatRuntimePluginMutationBarrier({
        pluginId: 'sample-plugin',
        token: lease.token,
        generation: lease.generation,
        phase: 'guarding',
        now: 300,
        db: pair.peer,
      }),
      (error) => {
        assert.equal(error?.message, 'runtime plugin mutation barrier phase transition invalid')
        return true
      },
    )
    const refreshing = heartbeatRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: lease.token,
      generation: lease.generation,
      phase: 'refreshing',
      now: 300,
      db: pair.peer,
    })
    assert.equal(refreshing.phase, 'refreshing')
  } finally {
    pair.close()
  }
})

test('generation ledger cannot be deleted, rolled back, reused, or detached from a live barrier', () => {
  const pair = createBarrierDatabasePair()
  const generationError = (error) => {
    assert.equal(error?.message, 'runtime plugin mutation barrier generation invariant violated')
    return true
  }
  try {
    const first = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })
    assert.throws(
      () => pair.peer.prepare(`
        UPDATE runtime_plugin_mutation_barriers SET generation = ?
        WHERE plugin_id = ?
      `).run(first.generation + 1, 'sample-plugin'),
      generationError,
    )
    assert.throws(
      () => pair.peer.prepare(`
        DELETE FROM runtime_plugin_mutation_barrier_generations
        WHERE plugin_id = ?
      `).run('sample-plugin'),
      generationError,
    )
    assert.equal(releaseRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: first.token,
      generation: first.generation,
      db: pair.owner,
    }), true)

    const second = acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.peer,
      token: 'barrier-token-0002',
      now: 200,
    })
    assert.equal(second.generation, first.generation + 1)
    assert.throws(
      () => pair.owner.prepare(`
        UPDATE runtime_plugin_mutation_barrier_generations
        SET last_generation = ?
        WHERE plugin_id = ?
      `).run(first.generation, 'sample-plugin'),
      generationError,
    )
    assert.equal(releaseRuntimePluginMutationBarrier({
      pluginId: 'sample-plugin',
      token: second.token,
      generation: second.generation,
      db: pair.peer,
    }), true)
    assert.throws(
      () => pair.owner.prepare(`
        INSERT INTO runtime_plugin_mutation_barriers (
          plugin_id, token, generation, operation, phase, owner_pid,
          store_revision, created_at, heartbeat_at, recovery_required
        ) VALUES (?, ?, ?, 'uninstall', 'guarding', 999, NULL, 300, 300, 0)
      `).run('sample-plugin', 'barrier-token-reused', second.generation),
      generationError,
    )
    const ledger = pair.owner.prepare(`
      SELECT last_generation, generation_claimed
      FROM runtime_plugin_mutation_barrier_generations
      WHERE plugin_id = ?
    `).get('sample-plugin')
    assert.deepEqual(ledger, {
      last_generation: second.generation,
      generation_claimed: 1,
    })
  } finally {
    pair.close()
  }
})

test('runtime plugin state release pointers cannot cross plugin identities', () => {
  const pair = createBarrierDatabasePair()
  try {
    pair.owner.prepare(`
      INSERT INTO runtime_plugin_releases (release_id, plugin_id) VALUES (?, ?)
    `).run('sample-release', 'sample-plugin')
    pair.owner.prepare(`
      INSERT INTO runtime_plugin_states (plugin_id) VALUES (?)
    `).run('other-plugin')
    acquireRuntimePluginMutationBarrier('sample-plugin', {
      db: pair.owner,
      token: 'barrier-token-0001',
      now: 100,
    })

    assert.throws(
      () => pair.peer.prepare(`
        UPDATE runtime_plugin_states SET active_release_id = ? WHERE plugin_id = ?
      `).run('sample-release', 'other-plugin'),
      (error) => {
        assert.equal(error?.message, 'runtime plugin state release identity mismatch')
        return true
      },
    )
    assert.equal(
      pair.peer.prepare(`
        SELECT active_release_id FROM runtime_plugin_states WHERE plugin_id = ?
      `).get('other-plugin').active_release_id,
      null,
    )
  } finally {
    pair.close()
  }
})
