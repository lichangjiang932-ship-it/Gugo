import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-session-deletion-governance-'))
process.env.APP_DATA_DIR = path.join(root, 'data')
process.env.APP_DB_PATH = path.join(root, 'data', 'app.db')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { acquireCompactionArchiveGovernanceLease } = await import(
  '../server/services/compactionArchiveGovernanceRuntime.js'
)
const {
  createCompactionArchiveRecord,
  resolveCompactionArchiveStorage,
} = await import('../server/services/compactionArchiveStore.js')
const {
  recoverPendingSessionDeletion,
  runGovernedSessionDeletion,
} = await import('../server/services/sessionDeletionGovernanceRuntime.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

const db = getDb()
const controller = activateTestCompactionArchivePort({ env: process.env })

function fixture(label) {
  const userId = `session-delete-governance-${label}`
  const sessionId = `${userId}-session`
  createUser({ id: userId, email: `${userId}@example.com` })
  upsertSession({ id: sessionId, userId, title: label })
  const archive = createCompactionArchiveRecord({
    id: `${userId}-archive`,
    userId,
    sessionId,
    archivedMessages: [{ role: 'user', content: `private-${label}` }],
    summaryText: `summary-${label}`,
    db,
    env: process.env,
  })
  const row = db.prepare('SELECT * FROM compaction_archive WHERE id = ?').get(archive.id)
  const archivePath = resolveCompactionArchiveStorage({
    userId,
    id: archive.id,
    storagePath: row.storage_path,
    env: process.env,
  }).fullPath
  const validate = () => db.prepare(`
    SELECT token FROM sessions WHERE user_id = ? AND token = ?
  `).get(userId, sessionId) || null
  const commitDatabaseDeletion = () => {
    db.prepare('DELETE FROM compaction_archive WHERE user_id = ? AND session_id = ?')
      .run(userId, sessionId)
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token = ?').run(userId, sessionId)
    return { deleted: true }
  }
  return { userId, sessionId, archive, archivePath, validate, commitDatabaseDeletion }
}

function acquireWrappedLease(overrides = {}) {
  const lease = acquireCompactionArchiveGovernanceLease()
  const source = lease.port
  const port = Object.freeze({
    id: source.id,
    apiVersion: source.apiVersion,
    governanceApiVersion: source.governanceApiVersion,
    previewDeletion: overrides.previewDeletion || ((input) => source.previewDeletion(input)),
    stageDeletion: overrides.stageDeletion || ((input) => source.stageDeletion(input)),
    assertDeletionStable: overrides.assertDeletionStable
      || ((input) => source.assertDeletionStable(input)),
    commitDeletion: overrides.commitDeletion || ((input) => source.commitDeletion(input)),
    recoverDeletion: overrides.recoverDeletion || ((input) => source.recoverDeletion(input)),
  })
  return Object.freeze({
    port,
    release: overrides.release
      ? () => overrides.release(lease.release)
      : lease.release,
  })
}

function leaveCommittedDeletionPending(current, message) {
  const acquireGovernanceLease = () => acquireWrappedLease({
    commitDeletion() {
      throw new Error(message)
    },
  })
  assert.throws(
    () => runGovernedSessionDeletion({
      db,
      userId: current.userId,
      sessionId: current.sessionId,
      validate: current.validate,
      commitDatabaseDeletion: current.commitDatabaseDeletion,
    }, { acquireGovernanceLease }),
    (error) => error?.message === message
      && error?.databaseCommitted === true
      && error?.cleanupPending === true,
  )
  return db.prepare(`
    SELECT * FROM user_data_clear_operations WHERE owner_id = ?
  `).get(current.userId)
}

test.after(() => {
  controller.release()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('a failed database transaction restores staged session archives and releases its journal', () => {
  const current = fixture('rollback')
  assert.throws(
    () => runGovernedSessionDeletion({
      db,
      userId: current.userId,
      sessionId: current.sessionId,
      validate: current.validate,
      commitDatabaseDeletion() {
        throw new Error('injected database failure')
      },
    }),
    /injected database failure/,
  )
  assert.equal(fs.existsSync(current.archivePath), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive WHERE id = ?')
    .get(current.archive.id).count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?')
    .get(current.userId).count, 0)
})

test('a committed session deletion recovers an interrupted archive commit on the next lease', () => {
  const current = fixture('commit-recovery')
  let injected = false
  const acquireFailingCommitLease = () => {
    const lease = acquireCompactionArchiveGovernanceLease()
    const source = lease.port
    const port = Object.freeze({
      id: source.id,
      apiVersion: source.apiVersion,
      governanceApiVersion: source.governanceApiVersion,
      previewDeletion(input) {
        return source.previewDeletion(input)
      },
      stageDeletion(input) {
        return source.stageDeletion(input)
      },
      assertDeletionStable(input) {
        return source.assertDeletionStable(input)
      },
      commitDeletion() {
        injected = true
        throw new Error('injected compaction commit failure')
      },
      recoverDeletion(input) {
        return source.recoverDeletion(input)
      },
    })
    return Object.freeze({ port, release: lease.release })
  }

  assert.throws(
    () => runGovernedSessionDeletion({
      db,
      userId: current.userId,
      sessionId: current.sessionId,
      validate: current.validate,
      commitDatabaseDeletion: current.commitDatabaseDeletion,
    }, { acquireGovernanceLease: acquireFailingCommitLease }),
    (error) => error?.message === 'injected compaction commit failure'
      && error?.databaseCommitted === true
      && error?.cleanupPending === true,
  )
  assert.equal(injected, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive WHERE id = ?')
    .get(current.archive.id).count, 0)
  assert.equal(db.prepare(`
    SELECT status FROM user_data_clear_operations WHERE owner_id = ?
  `).get(current.userId).status, 'database_committed')

  const operationId = db.prepare(`
    SELECT operation_id FROM user_data_clear_operations WHERE owner_id = ?
  `).get(current.userId).operation_id
  assert.deepEqual(recoverPendingSessionDeletion({ db }), {
    operationId,
    userId: current.userId,
    sessionId: current.sessionId,
    databaseCommitted: true,
  })
  assert.equal(fs.existsSync(current.archivePath), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?')
    .get(current.userId).count, 0)
})

test('pending recovery fails closed when its durable digest no longer matches the staged receipt', () => {
  const current = fixture('receipt-drift')
  const operation = leaveCommittedDeletionPending(current, 'leave receipt drift pending')
  const driftedDigest = operation.compaction_digest === 'f'.repeat(64)
    ? 'e'.repeat(64)
    : 'f'.repeat(64)
  db.prepare(`
    UPDATE user_data_clear_operations SET compaction_digest = ? WHERE operation_id = ?
  `).run(driftedDigest, operation.operation_id)

  assert.throws(
    () => recoverPendingSessionDeletion({ db }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_STALE',
  )
  assert.equal(fs.existsSync(current.archivePath), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations').get().count, 1)

  db.prepare(`
    UPDATE user_data_clear_operations SET compaction_digest = ? WHERE operation_id = ?
  `).run(operation.compaction_digest, operation.operation_id)
  assert.equal(recoverPendingSessionDeletion({ db }).databaseCommitted, true)
})

test('runtime rejects an incoherent recovered flag without releasing its durable journal', () => {
  const current = fixture('incoherent-recovery')
  leaveCommittedDeletionPending(current, 'leave incoherent recovery pending')
  const acquireGovernanceLease = () => acquireWrappedLease({
    recoverDeletion(input) {
      return {
        userId: input.userId,
        operationId: input.operationId,
        recovered: false,
        state: 'committed',
        digest: input.expectedDigest,
        stageToken: input.expectedStageToken,
      }
    },
  })

  assert.throws(
    () => recoverPendingSessionDeletion({ db }, { acquireGovernanceLease }),
    (error) => error?.code === 'SESSION_DELETE_RECOVERY_CONFLICT'
      && error?.cleanupPending === true,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations').get().count, 1)
  assert.equal(recoverPendingSessionDeletion({ db }).databaseCommitted, true)
})

test('an expired foreign lease can be reclaimed even when its pid was reused', () => {
  const current = fixture('expired-pid-reuse')
  const operation = leaveCommittedDeletionPending(current, 'leave expired lease pending')
  db.prepare(`
    UPDATE user_data_clear_operations
    SET lease_owner = ?, lease_pid = ?, lease_expires_at = ?
    WHERE operation_id = ?
  `).run('foreign-process', process.pid, Date.now() + 60_000, operation.operation_id)
  assert.throws(
    () => recoverPendingSessionDeletion({ db }),
    (error) => error?.code === 'SESSION_DELETE_IN_PROGRESS',
  )

  db.prepare(`
    UPDATE user_data_clear_operations SET lease_expires_at = ? WHERE operation_id = ?
  `).run(Date.now() - 1, operation.operation_id)
  assert.equal(recoverPendingSessionDeletion({ db }).databaseCommitted, true)
})

test('a release failure after durable completion does not turn deletion into an API failure', () => {
  const current = fixture('release-after-commit')
  let releaseCalls = 0
  const acquireGovernanceLease = () => acquireWrappedLease({
    release(release) {
      releaseCalls += 1
      release()
      throw new Error('injected release failure after commit')
    },
  })

  assert.deepEqual(runGovernedSessionDeletion({
    db,
    userId: current.userId,
    sessionId: current.sessionId,
    validate: current.validate,
    commitDatabaseDeletion: current.commitDatabaseDeletion,
  }, { acquireGovernanceLease }), { deleted: true })
  assert.equal(releaseCalls, 1)
  assert.equal(fs.existsSync(current.archivePath), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_data_clear_operations').get().count, 0)
})
