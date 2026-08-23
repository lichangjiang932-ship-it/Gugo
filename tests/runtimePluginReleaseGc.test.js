import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-release-gc-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { migrateToV78 } = await import('../server/migrations/v78RuntimePluginReleaseRetention.js')
const {
  createTurnExecutionEnvironmentSnapshot,
  normalizeTurnExecutionEnvironmentSnapshot,
} = await import('../server/services/turnExecutionEnvironment.js')
const { appendJobSteps, createJob } = await import('../server/services/jobStore.js')
const { saveJobTurnCheckpoint, deleteJobTurnCheckpoint } = await import('../server/services/jobTurnCheckpointStore.js')
const {
  RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS,
  getRuntimePluginReleaseGcAudit,
  resolveRuntimePluginReleaseRetentionPolicy,
  runRuntimePluginReleaseGc,
  validateRuntimePluginReleaseScanStats,
} = await import('../server/services/runtimePluginReleaseGc.js')
const {
  listRuntimePluginReleasePins,
  pinRuntimePluginRelease,
} = await import('../server/services/runtimePluginReleaseReferenceStore.js')
const {
  countRuntimePluginReleases,
  createRuntimePluginRelease,
  getRuntimePluginRelease,
} = await import('../server/services/runtimePluginStateStore.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { deleteTurnCheckpoint, saveTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')

const PLUGIN_ID = 'retention-transformer'
const SOURCE = 'function transform(input) { return input }'
const SOURCE_DIGEST = `sha256-${createHash('sha256').update(SOURCE).digest('hex')}`
const GC_OWNER = 'gc-test-owner'
const ENABLED_POLICY = Object.freeze({
  enabled: true,
  keepLatest: 1,
  minAgeMs: 0,
  maxDeletesPerRun: 100,
  maxReleasesScanned: 100,
  maxAuditRuns: 10,
})

function previewGc({ policy = ENABLED_POLICY, now }) {
  return runRuntimePluginReleaseGc({
    policy,
    dryRun: true,
    ownerId: GC_OWNER,
    now,
  })
}

function previewAndRun({ policy = ENABLED_POLICY, now, actualNow = now }) {
  const preview = previewGc({ policy, now })
  assert.equal(preview.status, 'completed', preview.failure || JSON.stringify(preview.result))
  return runRuntimePluginReleaseGc({
    dryRun: false,
    ownerId: GC_OWNER,
    previewRunId: preview.runId,
    now: actualNow,
  })
}

function pluginSnapshot() {
  return {
    id: PLUGIN_ID,
    name: 'Retention Transformer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    description: '',
    requires: [],
    contributes: [],
    capabilities: [],
  }
}

function release(releaseId, createdAt) {
  return createRuntimePluginRelease({
    pluginId: PLUGIN_ID,
    releaseId,
    sourceDigest: SOURCE_DIGEST,
    source: SOURCE,
    pluginSnapshotJson: JSON.stringify(pluginSnapshot()),
    validationStatus: 'passed',
    healthStatus: 'passed',
    now: createdAt,
  })
}

function executionEnvironment(pinnedRelease) {
  return createTurnExecutionEnvironmentSnapshot({
    toolImplementations: {
      version: 1,
      builtinRevision: `sha256-${'a'.repeat(64)}`,
      connectorRevision: null,
      mcpTools: [],
    },
    runtimePlugins: [{
      id: PLUGIN_ID,
      version: '1.0.0',
      state: 'active',
      requires: [],
      contributes: [],
    }],
    runtimePluginStates: [{
      pluginId: PLUGIN_ID,
      enabled: true,
      activeReleaseId: pinnedRelease.releaseId,
      activeReleaseDigestVersion: pinnedRelease.digestVersion,
      activeReleaseContentDigest: pinnedRelease.releaseContentDigest,
    }],
  })
}

function installUpdateProtection(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_plugin_releases_immutable
      BEFORE UPDATE ON runtime_plugin_releases
      BEGIN
        SELECT RAISE(ABORT, 'runtime plugin releases are immutable');
      END;
  `)
}

function resetDatabase() {
  const db = getDb()
  db.exec(`
    DROP TRIGGER IF EXISTS reject_second_gc_delete;
    DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable_delete;
    DELETE FROM runtime_plugin_release_gc_delete_guards;
    DELETE FROM runtime_plugin_release_pins;
    DELETE FROM runtime_plugin_release_gc_runs;
    DELETE FROM runtime_plugin_states;
    DELETE FROM turn_execution_leases;
    DELETE FROM job_execution_leases;
    DELETE FROM turn_checkpoints;
    DELETE FROM job_turn_checkpoints;
    DELETE FROM turn_events;
    DELETE FROM event_write_failures;
    DELETE FROM job_steps;
    DELETE FROM jobs;
    DELETE FROM sessions;
    DELETE FROM users;
    DELETE FROM runtime_plugin_releases;
  `)
  migrateToV78(db)
}

test.beforeEach(resetDatabase)

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('retention policy is default-off and rejects out-of-bounds configuration', () => {
  assert.deepEqual(resolveRuntimePluginReleaseRetentionPolicy({ env: {} }), {
    enabled: false,
    keepLatest: 10,
    minAgeMs: 604_800_000,
    maxDeletesPerRun: 25,
    maxReleasesScanned: 10_000,
    maxAuditRuns: 100,
  })
  assert.throws(
    () => resolveRuntimePluginReleaseRetentionPolicy({
      env: { RUNTIME_PLUGIN_RELEASE_GC_ENABLED: '1', RUNTIME_PLUGIN_RELEASE_GC_MAX_DELETE: '101' },
    }),
    /between 1 and 100/,
  )
})

test('default-off GC records an explicit audit and deletes nothing', () => {
  release('rel-disabled-1', 10)
  release('rel-disabled-2', 20)
  const audit = runRuntimePluginReleaseGc({ env: {}, now: 100 })
  assert.equal(audit.status, 'skipped')
  assert.equal(audit.result.reason, 'disabled')
  assert.equal(audit.result.deletedCount, 0)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
  assert.deepEqual(getRuntimePluginReleaseGcAudit(audit.runId), audit)
})

test('GC keeps the newest bounded set and deletes only the oldest eligible Releases', () => {
  for (let index = 1; index <= 4; index += 1) release(`rel-collect-${index}`, index * 10)
  const audit = previewAndRun({
    policy: { ...ENABLED_POLICY, maxDeletesPerRun: 2 },
    now: 1_000,
  })
  assert.equal(audit.status, 'completed')
  assert.deepEqual(audit.result.deleted.map((entry) => entry.releaseId), [
    'rel-collect-1', 'rel-collect-2',
  ])
  assert.equal(getRuntimePluginRelease(PLUGIN_ID, 'rel-collect-1'), null)
  assert.ok(getRuntimePluginRelease(PLUGIN_ID, 'rel-collect-4'))
  assert.equal(audit.result.retainedCounts.delete_limit, 1)
})

test('active, rollback history, and canary pins are never collected', () => {
  const releases = Array.from({ length: 5 }, (_, index) => release(`rel-protected-${index + 1}`, (index + 1) * 10))
  getDb().prepare(`
    INSERT INTO runtime_plugin_states (
      plugin_id, enabled, updated_at, active_release_id, previous_release_id,
      release_revision, last_rollback_status, last_rollback_from_release_id,
      last_rollback_to_release_id, last_rollback_reason, last_rollback_at
    ) VALUES (?, 1, 100, ?, ?, 1, 'succeeded', ?, ?, 'rollback', 100)
  `).run(
    PLUGIN_ID,
    releases[4].releaseId,
    releases[3].releaseId,
    releases[2].releaseId,
    releases[3].releaseId,
  )
  pinRuntimePluginRelease({
    pluginId: PLUGIN_ID,
    releaseId: releases[1].releaseId,
    referenceKind: 'canary',
    referenceId: 'canary-1',
    now: 100,
  })

  const audit = previewAndRun({ now: 1_000 })
  assert.equal(audit.status, 'completed')
  assert.deepEqual(audit.result.deleted, [{
    pluginId: PLUGIN_ID,
    releaseId: releases[0].releaseId,
  }])
  assert.equal(listRuntimePluginReleasePins({ referenceKind: 'canary' }).length, 1)
  for (const retained of releases.slice(1)) {
    assert.ok(getRuntimePluginRelease(PLUGIN_ID, retained.releaseId))
  }
})

test('Turn and Job checkpoints pin the exact Release identity until cleared', () => {
  const pinned = release('rel-checkpoint-old', 10)
  release('rel-checkpoint-new', 20)
  const environment = executionEnvironment(pinned)
  createUser({ id: 'gc-user', email: 'gc@example.com', now: 1 })
  upsertSession({ id: 'gc-session', userId: 'gc-user', createdAt: 1 })
  saveTurnCheckpoint({
    userId: 'gc-user',
    sessionId: 'gc-session',
    turnId: 'gc-turn',
    eventSequence: 1,
    state: { executionEnvironment: environment },
    now: 30,
  })
  createJob({
    id: 'gc-job', userId: 'gc-user', title: 'GC job', prompt: 'test', now: 1,
  })
  appendJobSteps('gc-job', [{ id: 'gc-step', title: 'step', kind: 'execute' }], 1)
  saveJobTurnCheckpoint({
    jobId: 'gc-job',
    stepId: 'gc-step',
    userId: 'gc-user',
    state: { executionEnvironment: environment },
    now: 30,
  })

  const storedTurnState = JSON.parse(getDb().prepare(`
    SELECT state_json FROM turn_checkpoints WHERE turn_id = 'gc-turn'
  `).get().state_json)
  assert.ok(storedTurnState.executionEnvironment)
  assert.ok(normalizeTurnExecutionEnvironmentSnapshot(storedTurnState.executionEnvironment))

  const retained = previewAndRun({ now: 1_000 })
  assert.equal(retained.status, 'completed', retained.failure || JSON.stringify(retained.result))
  assert.equal(retained.result.deletedCount, 0)
  assert.equal(retained.result.checkpointReleaseReferences, 2)
  assert.ok(getRuntimePluginRelease(PLUGIN_ID, pinned.releaseId))

  deleteTurnCheckpoint({ userId: 'gc-user', sessionId: 'gc-session', turnId: 'gc-turn' })
  deleteJobTurnCheckpoint({ jobId: 'gc-job', stepId: 'gc-step', userId: 'gc-user' })
  const collected = previewAndRun({ now: 1_001 })
  assert.equal(collected.status, 'completed')
  assert.deepEqual(collected.result.deleted.map((entry) => entry.releaseId), [pinned.releaseId])
})

test('failed checkpoint writes pin the exact Release identity until acknowledged', () => {
  const pinned = release('rel-failed-checkpoint-old', 10)
  release('rel-failed-checkpoint-new', 20)
  const environment = executionEnvironment(pinned)
  getDb().prepare(`
    INSERT INTO event_write_failures (
      user_id, session_id, turn_id, event_id, event_sequence, event_type,
      payload_json, checkpoint_state_json, error_message, attempts, failed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'failed-checkpoint-user',
    'failed-checkpoint-session',
    'failed-checkpoint-turn',
    'failed-checkpoint-event',
    1,
    'turn.checkpoint',
    '{}',
    JSON.stringify({ executionEnvironment: environment }),
    'write failed',
    3,
    30,
  )

  const retained = previewAndRun({ now: 1_000 })
  assert.equal(retained.status, 'completed', retained.failure || JSON.stringify(retained.result))
  assert.equal(retained.result.deletedCount, 0)
  assert.equal(retained.result.checkpointReleaseReferences, 1)
  assert.ok(getRuntimePluginRelease(PLUGIN_ID, pinned.releaseId))

  getDb().prepare('DELETE FROM event_write_failures WHERE event_id = ?')
    .run('failed-checkpoint-event')
  const collected = previewAndRun({ now: 1_001 })
  assert.equal(collected.status, 'completed')
  assert.deepEqual(collected.result.deleted.map((entry) => entry.releaseId), [pinned.releaseId])
})

test('any active Turn or Job execution lease skips the whole GC run', () => {
  release('rel-lease-old', 10)
  release('rel-lease-new', 20)
  createUser({ id: 'lease-user', email: 'lease@example.com', now: 1 })
  createJob({ id: 'lease-job', userId: 'lease-user', title: 'lease', prompt: 'test', now: 1 })
  getDb().prepare(`
    INSERT INTO job_execution_leases (job_id, owner_id, acquired_at, expires_at)
    VALUES ('lease-job', 'owner', 10, 2_000)
  `).run()
  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'skipped')
  assert.equal(audit.result.reason, 'execution_in_progress')
  assert.equal(audit.result.deletedCount, 0)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('unverifiable checkpoint state fails closed without deleting any Release', () => {
  release('rel-unknown-checkpoint-old', 10)
  release('rel-unknown-checkpoint-new', 20)
  createUser({ id: 'unknown-user', email: 'unknown@example.com', now: 1 })
  upsertSession({ id: 'unknown-session', userId: 'unknown-user', createdAt: 1 })
  saveTurnCheckpoint({
    userId: 'unknown-user',
    sessionId: 'unknown-session',
    turnId: 'unknown-turn',
    eventSequence: 1,
    state: { legacy: true },
    now: 30,
  })
  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.equal(audit.result.reason, 'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('old Turn checkpoint updated to an unknown schema after Releases exist fails closed', () => {
  createUser({ id: 'updated-turn-user', email: 'updated-turn@example.com', now: 1 })
  upsertSession({ id: 'updated-turn-session', userId: 'updated-turn-user', createdAt: 1 })
  saveTurnCheckpoint({
    userId: 'updated-turn-user',
    sessionId: 'updated-turn-session',
    turnId: 'updated-turn',
    eventSequence: 1,
    state: { legacy: true },
    now: 1,
  })
  release('rel-updated-turn-old', 10)
  release('rel-updated-turn-new', 20)
  saveTurnCheckpoint({
    userId: 'updated-turn-user',
    sessionId: 'updated-turn-session',
    turnId: 'updated-turn',
    eventSequence: 2,
    state: { unknownSchema: { revision: 2 } },
    now: 30,
  })
  const checkpoint = getDb().prepare(`
    SELECT created_at, updated_at FROM turn_checkpoints WHERE turn_id = 'updated-turn'
  `).get()
  assert.deepEqual(checkpoint, { created_at: 1, updated_at: 30 })

  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.equal(audit.result.reason, 'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('old Job checkpoint updated to an unknown schema after Releases exist fails closed', () => {
  createUser({ id: 'updated-job-user', email: 'updated-job@example.com', now: 1 })
  createJob({
    id: 'updated-job',
    userId: 'updated-job-user',
    title: 'Updated checkpoint job',
    prompt: 'test',
    now: 1,
  })
  appendJobSteps('updated-job', [{ id: 'updated-job-step', title: 'step', kind: 'execute' }], 1)
  saveJobTurnCheckpoint({
    jobId: 'updated-job',
    stepId: 'updated-job-step',
    userId: 'updated-job-user',
    state: { legacy: true },
    now: 1,
  })
  release('rel-updated-job-old', 10)
  release('rel-updated-job-new', 20)
  saveJobTurnCheckpoint({
    jobId: 'updated-job',
    stepId: 'updated-job-step',
    userId: 'updated-job-user',
    state: { unknownSchema: { revision: 2 } },
    now: 30,
  })
  const checkpoint = getDb().prepare(`
    SELECT created_at, updated_at FROM job_turn_checkpoints WHERE step_id = 'updated-job-step'
  `).get()
  assert.deepEqual(checkpoint, { created_at: 1, updated_at: 30 })

  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.equal(audit.result.reason, 'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('content digest corruption fails closed and never becomes a GC shortcut', () => {
  release('rel-corrupt-old', 10)
  release('rel-corrupt-new', 20)
  const db = getDb()
  db.exec('DROP TRIGGER trg_runtime_plugin_releases_immutable')
  db.prepare(`
    UPDATE runtime_plugin_releases SET source_text = 'tampered'
    WHERE release_id = 'rel-corrupt-old'
  `).run()
  installUpdateProtection(db)
  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.match(audit.failure, /摘要不匹配|content digest/u)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('Release inventory safety limits fail closed before oversized content is retained', () => {
  release('rel-oversized-old', 10)
  release('rel-oversized-new', 20)
  const db = getDb()
  db.exec('DROP TRIGGER trg_runtime_plugin_releases_immutable')
  db.prepare(`
    UPDATE runtime_plugin_releases SET failure = ?
    WHERE release_id = 'rel-oversized-old'
  `).run('x'.repeat(801 * 1024))
  installUpdateProtection(db)

  const audit = previewGc({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.equal(audit.result.reason, 'PLUGIN_RELEASE_GC_RELEASE_LIMIT')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('Release inventory aggregate and scan statistics reject unsafe synthetic bounds', () => {
  assert.throws(
    () => validateRuntimePluginReleaseScanStats({
      rowCount: 1,
      totalBytes: (256 * 1024 * 1024) + 1,
      maxBytes: 1,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_RELEASE_LIMIT',
  )
  assert.throws(
    () => validateRuntimePluginReleaseScanStats({
      rowCount: 1,
      totalBytes: 1,
      maxBytes: (800 * 1024) + 1,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_RELEASE_LIMIT',
  )
  assert.throws(
    () => validateRuntimePluginReleaseScanStats({ rowCount: 1, totalBytes: -1, maxBytes: 1 }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_RELEASE_SCAN_INVALID',
  )
})

test('a later delete failure rolls back earlier deletes and all guards', () => {
  release('rel-atomic-1', 10)
  release('rel-atomic-2', 20)
  release('rel-atomic-3', 30)
  getDb().exec(`
    CREATE TRIGGER reject_second_gc_delete
      BEFORE DELETE ON runtime_plugin_releases
      WHEN OLD.release_id = 'rel-atomic-2'
      BEGIN
        SELECT RAISE(ABORT, 'injected delete failure');
      END;
  `)
  const audit = previewAndRun({ now: 1_000 })
  assert.equal(audit.status, 'failed')
  assert.match(audit.failure, /injected delete failure/)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM runtime_plugin_release_gc_delete_guards').get().count,
    0,
  )
})

test('preview is owner-bound, expires quickly, and is single-use after success', () => {
  release('rel-preview-owner-old', 10)
  release('rel-preview-owner-new', 20)
  const preview = previewGc({ now: 1_000 })
  assert.throws(
    () => runRuntimePluginReleaseGc({
      dryRun: false,
      ownerId: 'another-owner',
      previewRunId: preview.runId,
      now: 1_001,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_PREVIEW_OWNER_MISMATCH',
  )
  const completed = runRuntimePluginReleaseGc({
    dryRun: false,
    ownerId: GC_OWNER,
    previewRunId: preview.runId,
    now: 1_001,
  })
  assert.equal(completed.status, 'completed')
  assert.throws(
    () => runRuntimePluginReleaseGc({
      dryRun: false,
      ownerId: GC_OWNER,
      previewRunId: preview.runId,
      now: 1_002,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_PREVIEW_ALREADY_USED',
  )

  release('rel-preview-expiry-old', 30)
  const expiring = previewGc({ now: 2_000 })
  assert.throws(
    () => runRuntimePluginReleaseGc({
      dryRun: false,
      ownerId: GC_OWNER,
      previewRunId: expiring.runId,
      now: 2_000 + RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_GC_PREVIEW_EXPIRED',
  )
})

test('audit pruning preserves every unconsumed preview until its advertised expiry', () => {
  release('rel-preview-retention-old', 10)
  release('rel-preview-retention-new', 20)
  const first = previewGc({ now: 1_000 })

  for (let index = 1; index <= ENABLED_POLICY.maxAuditRuns; index += 1) {
    const preview = previewGc({ now: 1_000 + index })
    assert.equal(preview.status, 'completed')
  }

  assert.ok(getRuntimePluginReleaseGcAudit(first.runId))
  const completed = runRuntimePluginReleaseGc({
    dryRun: false,
    ownerId: GC_OWNER,
    previewRunId: first.runId,
    now: 1_100,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.deletedCount, 1)
})

test('candidate or protection changes invalidate a claimed preview without deleting', () => {
  release('rel-preview-change-old', 10)
  release('rel-preview-change-new', 20)
  const changedCandidates = previewGc({ now: 1_000 })
  release('rel-preview-change-older', 5)
  const staleCandidateAudit = runRuntimePluginReleaseGc({
    dryRun: false,
    ownerId: GC_OWNER,
    previewRunId: changedCandidates.runId,
    now: 1_001,
  })
  assert.equal(staleCandidateAudit.status, 'failed')
  assert.equal(staleCandidateAudit.result.reason, 'PLUGIN_RELEASE_GC_PREVIEW_STALE')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)

  const changedProtection = previewGc({ now: 2_000 })
  const reviewedReleaseId = changedProtection.result.candidates[0].releaseId
  pinRuntimePluginRelease({
    pluginId: PLUGIN_ID,
    releaseId: reviewedReleaseId,
    referenceKind: 'manual',
    referenceId: 'post-preview-pin',
    now: 2_001,
  })
  const staleProtectionAudit = runRuntimePluginReleaseGc({
    dryRun: false,
    ownerId: GC_OWNER,
    previewRunId: changedProtection.runId,
    now: 2_002,
  })
  assert.equal(staleProtectionAudit.status, 'failed')
  assert.equal(staleProtectionAudit.result.reason, 'PLUGIN_RELEASE_GC_PREVIEW_STALE')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
})
