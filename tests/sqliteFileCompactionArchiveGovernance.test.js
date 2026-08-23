import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { createCompactionArchivePort } from '../server/core/compactionArchivePort.js'
import { migrateToV77 } from '../server/migrations/v77UserDataClearOperations.js'
import { migrateToV97 } from '../server/migrations/v97CompactionArchiveStorage.js'
import { migrateToV99 } from '../server/migrations/v99CompactionArchiveGovernanceJournal.js'
import {
  _testing,
  createCompactionArchiveRecord,
  resolveCompactionArchiveStorage,
  resolveCompactionArchiveUserStorage,
} from '../server/services/compactionArchiveStore.js'
import { createSqliteFileCompactionArchiveAdapter } from '../server/services/sqliteFileCompactionArchiveAdapter.js'

function fixture(t, { observeArchiveSelect = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-compaction-governance-'))
  const env = { APP_DATA_DIR: path.join(root, 'data') }
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE compaction_archive (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replaced_message_count INTEGER NOT NULL,
      archived_messages_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  migrateToV77(db)
  migrateToV97(db)
  migrateToV99(db)
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  let observing = false
  const adapterDb = observeArchiveSelect
    ? new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql) => {
            if (observing && /\bFROM\s+compaction_archive\b/iu.test(String(sql))) {
              observeArchiveSelect()
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    : db
  let createdSequence = 0
  let tokenSequence = 0
  const adapter = createSqliteFileCompactionArchiveAdapter({
    db: adapterDb,
    env,
    idFactory: () => `created-${createdSequence += 1}`,
    governanceTokenFactory: () => `token-${tokenSequence += 1}`,
    now: () => 1_000 + createdSequence,
  })
  const port = createCompactionArchivePort(adapter)
  return {
    adapter,
    db,
    env,
    port,
    root,
    startObserving() { observing = true },
  }
}

function createStored({ db, env, id, userId, sessionId, content }) {
  const archivedMessages = [{ role: 'user', content }]
  createCompactionArchiveRecord({
    db,
    env,
    id,
    userId,
    sessionId,
    archivedMessages,
    summaryText: `summary:${id}`,
    now: 10,
  })
  return archivedMessages
}

function createLegacy({ db, id, userId, sessionId, content }) {
  const archivedMessages = [{ role: 'user', content }]
  db.prepare(`
    INSERT INTO compaction_archive (
      id, user_id, session_id, replaced_message_count,
      archived_messages_json, summary_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    sessionId,
    archivedMessages.length,
    JSON.stringify(archivedMessages),
    `summary:${id}`,
    10,
  )
  return archivedMessages
}

function storedPath({ env, id, userId }) {
  return resolveCompactionArchiveStorage({
    env,
    id,
    userId,
    storagePath: _testing.expectedStoragePath(userId, id),
  }).fullPath
}

function writeOrphan({ env, userId, name = 'orphan.json', content = 'orphan' }) {
  const owner = resolveCompactionArchiveUserStorage({ userId, env })
  fs.mkdirSync(owner.bucketPath, { recursive: true })
  const fullPath = path.join(owner.bucketPath, name)
  fs.writeFileSync(fullPath, content)
  return fullPath
}

function allFiles(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else found.push(fullPath)
    }
  }
  visit(root)
  return found
}

function manifestFiles(env) {
  return allFiles(env.APP_DATA_DIR).filter((file) => path.basename(file) === 'manifest.json')
}

function operationInput(staged) {
  return {
    userId: staged.userId,
    operationId: staged.operationId,
    stageToken: staged.stageToken,
    digest: staged.digest,
  }
}

function reopenPort({ db, env, now = () => 2_000, terminalRetentionMs } = {}) {
  let tokenSequence = 0
  return createCompactionArchivePort(createSqliteFileCompactionArchiveAdapter({
    db,
    env,
    idFactory: () => 'reopened-create',
    governanceTokenFactory: () => `reopened-token-${tokenSequence += 1}`,
    now,
    governanceTerminalRetentionMs: terminalRetentionMs,
  }))
}

function insertBoundSessionJournal({ db, manifest, overrides = {} }) {
  db.prepare(`
    INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, operation_kind, session_id, compaction_port_id,
      compaction_governance_version, compaction_digest,
      compaction_stage_token, created_at, updated_at
    ) VALUES (?, ?, 'gc-test', ?, ?, ?, 'session_delete', ?,
              'builtin.sqlite-file', 1, ?, ?, ?, ?)
  `).run(
    manifest.operationId,
    manifest.userId,
    process.pid,
    10_000,
    overrides.status || (manifest.state === 'committed' ? 'database_committed' : 'staging'),
    manifest.scope.sessionId,
    overrides.digest || manifest.digest,
    manifest.stageToken,
    manifest.createdAt,
    manifest.terminalReceipt.completedAt,
  )
}

function readAllExportBytes(port, snapshot, entry, chunkSize = 5) {
  const chunks = []
  let offset = 0
  for (;;) {
    const chunk = port.readExportChunk({
      userId: snapshot.userId,
      snapshotToken: snapshot.snapshotToken,
      contentToken: entry.contentToken,
      offset,
      maxBytes: chunkSize,
    })
    assert.equal(Object.hasOwn(chunk, 'bytes'), false)
    chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
    offset = chunk.nextOffset
    if (chunk.done) break
  }
  return Buffer.concat(chunks)
}

test('governance export snapshots include legacy bodies without exposing rows or storage paths', (t) => {
  const { db, env, port } = fixture(t)
  const expected = new Map([
    ['file-a', createStored({
      db,
      env,
      id: 'file-a',
      userId: 'owner-a',
      sessionId: 'session-a',
      content: 'file backed private body',
    })],
    ['legacy-a', createLegacy({
      db,
      id: 'legacy-a',
      userId: 'owner-a',
      sessionId: 'session-a',
      content: 'legacy private body',
    })],
  ])
  createStored({
    db,
    env,
    id: 'other-owner',
    userId: 'owner-b',
    sessionId: 'session-a',
    content: 'must stay isolated',
  })

  const snapshot = port.createExportSnapshot({ userId: 'owner-a' })
  assert.equal(snapshot.entryCount, 2)
  const listed = port.listExportEntries({
    userId: 'owner-a',
    snapshotToken: snapshot.snapshotToken,
  })
  assert.deepEqual(listed.entries.map((entry) => entry.id).sort(), ['file-a', 'legacy-a'])
  assert.ok(listed.entries.every((entry) => entry.userId === 'owner-a'))
  const publicJson = JSON.stringify({ snapshot, listed })
  assert.equal(publicJson.includes(env.APP_DATA_DIR), false)
  assert.doesNotMatch(publicJson, /storage[_A-Z]?path|archived_messages_json|"row"/iu)

  for (const entry of listed.entries) {
    const bytes = readAllExportBytes(port, snapshot, entry)
    assert.equal(bytes.length, entry.sizeBytes)
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected.get(entry.id))
  }
  assert.throws(
    () => port.listExportEntries({
      userId: 'owner-b',
      snapshotToken: snapshot.snapshotToken,
    }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_EXPORT_SNAPSHOT_NOT_FOUND',
  )
  assert.deepEqual(port.releaseExportSnapshot({
    userId: 'owner-b',
    snapshotToken: snapshot.snapshotToken,
  }), {
    userId: 'owner-b',
    snapshotToken: snapshot.snapshotToken,
    released: false,
  })
  assert.equal(port.releaseExportSnapshot({
    userId: 'owner-a',
    snapshotToken: snapshot.snapshotToken,
  }).released, true)
  assert.equal(port.releaseExportSnapshot({
    userId: 'owner-a',
    snapshotToken: snapshot.snapshotToken,
  }).released, false)
})

test('session deletion establishes its managed write fence before collecting state and stays scoped', (t) => {
  let observedFence = false
  let currentEnv = null
  const state = fixture(t, {
    observeArchiveSelect() {
      if (observedFence) return
      const manifests = manifestFiles(currentEnv)
      assert.equal(manifests.length, 1)
      const manifest = JSON.parse(fs.readFileSync(manifests[0], 'utf8'))
      assert.equal(manifest.state, 'staging')
      observedFence = true
    },
  })
  const { db, env, port } = state
  currentEnv = env
  createStored({ db, env, id: 'session-a-file', userId: 'owner-a', sessionId: 'session-a', content: 'a' })
  createStored({ db, env, id: 'session-b-file', userId: 'owner-a', sessionId: 'session-b', content: 'b' })
  createStored({ db, env, id: 'owner-b-file', userId: 'owner-b', sessionId: 'session-a', content: 'c' })
  createLegacy({ db, id: 'session-a-legacy', userId: 'owner-a', sessionId: 'session-a', content: 'legacy' })
  const targetPath = storedPath({ env, id: 'session-a-file', userId: 'owner-a' })
  const otherSessionPath = storedPath({ env, id: 'session-b-file', userId: 'owner-a' })
  const otherOwnerPath = storedPath({ env, id: 'owner-b-file', userId: 'owner-b' })
  const ownerOrphanPath = writeOrphan({ env, userId: 'owner-a', content: 'owner orphan' })
  const otherOwnerOrphanPath = writeOrphan({
    env,
    userId: 'owner-b',
    content: 'other owner orphan',
  })

  const scope = { kind: 'session', sessionId: 'session-a' }
  const preview = port.previewDeletion({ userId: 'owner-a', scope })
  assert.equal(preview.fileCount, 1)
  state.startObserving()
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope,
    operationId: 'delete-session-a',
    expectedDigest: preview.digest,
  })

  assert.equal(observedFence, true)
  assert.equal(fs.existsSync(targetPath), false)
  assert.equal(fs.existsSync(otherSessionPath), true)
  assert.equal(fs.existsSync(otherOwnerPath), true)
  assert.equal(fs.existsSync(ownerOrphanPath), true)
  assert.equal(fs.existsSync(otherOwnerOrphanPath), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 4)
  const [manifestPath] = manifestFiles(env)
  const manifestText = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText)
  const relativeManifest = path.relative(path.resolve(env.APP_DATA_DIR), path.resolve(manifestPath))
  assert.ok(relativeManifest && !relativeManifest.startsWith(`..${path.sep}`))
  assert.equal(manifestText.includes(path.resolve(env.APP_DATA_DIR)), false)
  assert.equal(manifestText.includes(path.resolve(env.APP_DATA_DIR).replaceAll('\\', '\\\\')), false)
  assert.ok(manifest.files.every((file) => (
    !path.isAbsolute(file.storagePath)
      && !path.win32.isAbsolute(file.storagePath)
      && !path.isAbsolute(file.payloadName)
      && !path.win32.isAbsolute(file.payloadName)
  )))

  assert.throws(
    () => port.create({
      userId: 'owner-a',
      sessionId: 'session-a',
      archivedMessages: [],
      summaryText: 'blocked',
    }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_DELETION_IN_PROGRESS',
  )
  const allowedOtherSession = port.create({
    userId: 'owner-a',
    sessionId: 'session-b',
    archivedMessages: [],
    summaryText: 'allowed',
  })
  const allowedOtherOwner = port.create({
    userId: 'owner-b',
    sessionId: 'session-a',
    archivedMessages: [],
    summaryText: 'allowed',
  })
  assert.equal(allowedOtherSession.userId, 'owner-a')
  assert.equal(allowedOtherOwner.userId, 'owner-b')
  assert.equal(port.assertDeletionStable(operationInput(staged)).stable, true)
})

test('user deletion stability fails closed when a new orphan appears after staging', (t) => {
  const { db, env, port } = fixture(t)
  createStored({
    db,
    env,
    id: 'late-orphan-file',
    userId: 'owner-a',
    sessionId: 'session-a',
    content: 'stored before staging',
  })
  const source = storedPath({ env, id: 'late-orphan-file', userId: 'owner-a' })
  const originalOrphan = writeOrphan({
    env,
    userId: 'owner-a',
    name: 'original-orphan.json',
    content: 'orphan before staging',
  })
  const scope = { kind: 'user' }
  const preview = port.previewDeletion({ userId: 'owner-a', scope })
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope,
    operationId: 'late-orphan-operation',
    expectedDigest: preview.digest,
  })
  const input = operationInput(staged)
  const lateOrphan = writeOrphan({
    env,
    userId: 'owner-a',
    name: 'late-orphan.json',
    content: 'orphan after staging',
  })

  assert.throws(
    () => port.assertDeletionStable(input),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_STAGE_CHANGED',
  )

  const rolledBack = port.rollbackDeletion(input)
  assert.equal(rolledBack.state, 'rolled_back')
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.existsSync(originalOrphan), true)
  assert.equal(fs.existsSync(lateOrphan), true)
})

test('commit is idempotent, never deletes database rows, and leaves a non-blocking durable receipt', (t) => {
  const { db, env, port } = fixture(t)
  createStored({ db, env, id: 'commit-file', userId: 'owner-a', sessionId: 'session-a', content: 'commit' })
  createLegacy({ db, id: 'commit-legacy', userId: 'owner-a', sessionId: 'session-a', content: 'legacy' })
  const source = storedPath({ env, id: 'commit-file', userId: 'owner-a' })
  const scope = { kind: 'user' }
  const preview = port.previewDeletion({ userId: 'owner-a', scope })
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope,
    operationId: 'commit-operation',
    expectedDigest: preview.digest,
  })
  const input = operationInput(staged)
  port.assertDeletionStable(input)

  const beforeRows = db.prepare(`
    SELECT id, storage_path FROM compaction_archive WHERE user_id = ? ORDER BY id
  `).all('owner-a')
  const first = port.commitDeletion(input)
  const second = port.commitDeletion(input)
  assert.deepEqual(second, first)
  assert.equal(first.state, 'committed')
  assert.equal(first.removedFiles, 1)
  assert.equal(fs.existsSync(source), false)
  assert.deepEqual(db.prepare(`
    SELECT id, storage_path FROM compaction_archive WHERE user_id = ? ORDER BY id
  `).all('owner-a'), beforeRows)
  const [manifestPath] = manifestFiles(env)
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).state, 'committed')

  const created = port.create({
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages: [],
    summaryText: 'terminal receipt must not fence writes',
  })
  assert.equal(created.userId, 'owner-a')
  assert.deepEqual(port.recoverDeletion({
    userId: 'owner-a',
    operationId: 'commit-operation',
    databaseCommitted: true,
    expectedDigest: input.digest,
    expectedStageToken: input.stageToken,
  }), {
    userId: 'owner-a',
    operationId: 'commit-operation',
    recovered: true,
    state: 'committed',
    digest: input.digest,
    stageToken: input.stageToken,
  })
  assert.deepEqual(db.prepare(`
    SELECT id, storage_path FROM compaction_archive WHERE user_id = ? ORDER BY id
  `).all('owner-a').slice(0, beforeRows.length), beforeRows)
})

test('session terminal GC waits for journal release and its retention window', (t) => {
  const { db, env, port } = fixture(t)
  createStored({
    db, env, id: 'gc-session-file', userId: 'gc-owner',
    sessionId: 'gc-session', content: 'terminal gc',
  })
  const scope = { kind: 'session', sessionId: 'gc-session' }
  const preview = port.previewDeletion({ userId: 'gc-owner', scope })
  const staged = port.stageDeletion({
    userId: 'gc-owner', scope, operationId: 'gc-session-operation',
    expectedDigest: preview.digest,
  })
  port.commitDeletion(operationInput(staged))
  const [manifestPath] = manifestFiles(env)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.deepEqual({
    userId: manifest.terminalReceipt.userId,
    operationId: manifest.terminalReceipt.operationId,
    stageToken: manifest.terminalReceipt.stageToken,
    digest: manifest.terminalReceipt.digest,
    state: manifest.terminalReceipt.state,
  }, {
    userId: manifest.userId,
    operationId: manifest.operationId,
    stageToken: manifest.stageToken,
    digest: manifest.digest,
    state: 'committed',
  })

  reopenPort({
    db, env,
    now: () => manifest.terminalReceipt.completedAt + 99,
    terminalRetentionMs: 100,
  })
  assert.equal(fs.existsSync(manifestPath), true)
  insertBoundSessionJournal({ db, manifest })
  reopenPort({
    db, env,
    now: () => manifest.terminalReceipt.completedAt + 100,
    terminalRetentionMs: 100,
  })
  assert.equal(fs.existsSync(manifestPath), true)

  db.prepare('DELETE FROM user_data_clear_operations WHERE operation_id = ?')
    .run(manifest.operationId)
  reopenPort({
    db, env,
    now: () => manifest.terminalReceipt.completedAt + 100,
    terminalRetentionMs: 100,
  })
  assert.equal(fs.existsSync(manifestPath), false)
  assert.equal(manifestFiles(env).length, 0)
})

test('session terminal GC preserves active stages and terminal manifests without receipts', (t) => {
  const { db, env, port } = fixture(t)
  createStored({
    db, env, id: 'gc-active-file', userId: 'gc-active-owner',
    sessionId: 'gc-active-session', content: 'active stage',
  })
  const scope = { kind: 'session', sessionId: 'gc-active-session' }
  const preview = port.previewDeletion({ userId: 'gc-active-owner', scope })
  const staged = port.stageDeletion({
    userId: 'gc-active-owner', scope, operationId: 'gc-active-operation',
    expectedDigest: preview.digest,
  })
  const [manifestPath] = manifestFiles(env)
  reopenPort({ db, env, now: () => 1_000_000, terminalRetentionMs: 0 })
  assert.equal(fs.existsSync(manifestPath), true)
  port.rollbackDeletion(operationInput(staged))

  const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete legacyManifest.terminalReceipt
  fs.writeFileSync(manifestPath, `${JSON.stringify(legacyManifest)}\n`)
  reopenPort({ db, env, now: () => 2_000_000, terminalRetentionMs: 0 })
  assert.equal(fs.existsSync(manifestPath), true)
})

test('session terminal GC fails closed on receipt tampering and journal conflicts', (t) => {
  const { db, env, port } = fixture(t)
  createStored({
    db, env, id: 'gc-conflict-file', userId: 'gc-conflict-owner',
    sessionId: 'gc-conflict-session', content: 'conflict',
  })
  const scope = { kind: 'session', sessionId: 'gc-conflict-session' }
  const preview = port.previewDeletion({ userId: 'gc-conflict-owner', scope })
  const staged = port.stageDeletion({
    userId: 'gc-conflict-owner', scope, operationId: 'gc-conflict-operation',
    expectedDigest: preview.digest,
  })
  port.commitDeletion(operationInput(staged))
  const [manifestPath] = manifestFiles(env)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const originalReceiptDigest = manifest.terminalReceipt.receiptDigest
  manifest.terminalReceipt.receiptDigest = '0'.repeat(64)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  assert.throws(
    () => reopenPort({ db, env, now: () => 2_000_000, terminalRetentionMs: 0 }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
  )
  assert.equal(fs.existsSync(manifestPath), true)

  manifest.terminalReceipt.receiptDigest = originalReceiptDigest
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  const conflictingDigest = manifest.digest === 'f'.repeat(64)
    ? 'e'.repeat(64)
    : 'f'.repeat(64)
  insertBoundSessionJournal({ db, manifest, overrides: { digest: conflictingDigest } })
  assert.throws(
    () => reopenPort({ db, env, now: () => 2_000_000, terminalRetentionMs: 0 }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_JOURNAL_CONFLICT',
  )
  assert.equal(fs.existsSync(manifestPath), true)
})

test('rollback and both recovery decisions are idempotent and keep SQLite ownership with the host', (t) => {
  const { db, env, port } = fixture(t)
  createStored({ db, env, id: 'rollback-file', userId: 'owner-a', sessionId: 'session-a', content: 'rollback' })
  const source = storedPath({ env, id: 'rollback-file', userId: 'owner-a' })
  const orphan = writeOrphan({ env, userId: 'owner-a', content: 'rollback orphan' })
  const preview = port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } })
  assert.equal(preview.fileCount, 2)
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope: { kind: 'user' },
    operationId: 'rollback-operation',
    expectedDigest: preview.digest,
  })
  const input = operationInput(staged)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(orphan), false)
  const first = port.rollbackDeletion(input)
  const second = port.rollbackDeletion(input)
  assert.deepEqual(second, first)
  assert.equal(first.restoredFiles, 2)
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.existsSync(orphan), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
  const recoveredRollback = port.recoverDeletion({
    userId: 'owner-a',
    operationId: 'rollback-operation',
    databaseCommitted: false,
    expectedDigest: input.digest,
    expectedStageToken: input.stageToken,
  })
  assert.equal(recoveredRollback.state, 'rolled_back')

  const nextPreview = port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } })
  const commitStage = port.stageDeletion({
    userId: 'owner-a',
    scope: { kind: 'user' },
    operationId: 'recover-commit-operation',
    expectedDigest: nextPreview.digest,
  })
  const beforeRows = db.prepare('SELECT * FROM compaction_archive').all()
  const recoveredCommit = port.recoverDeletion({
    userId: 'owner-a',
    operationId: 'recover-commit-operation',
    databaseCommitted: true,
    expectedDigest: commitStage.digest,
    expectedStageToken: commitStage.stageToken,
  })
  assert.deepEqual(recoveredCommit, {
    userId: 'owner-a',
    operationId: 'recover-commit-operation',
    recovered: true,
    state: 'committed',
    digest: commitStage.digest,
    stageToken: commitStage.stageToken,
  })
  assert.deepEqual(port.recoverDeletion({
    userId: 'owner-a',
    operationId: 'recover-commit-operation',
    databaseCommitted: true,
    expectedDigest: commitStage.digest,
    expectedStageToken: commitStage.stageToken,
  }), recoveredCommit)
  assert.deepEqual(db.prepare('SELECT * FROM compaction_archive').all(), beforeRows)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.existsSync(orphan), false)
  assert.deepEqual(port.recoverDeletion({
    userId: 'owner-a',
    operationId: 'unknown-operation',
    databaseCommitted: false,
    expectedDigest: '0'.repeat(64),
    expectedStageToken: null,
  }), {
    userId: 'owner-a',
    operationId: 'unknown-operation',
    recovered: false,
    state: 'none',
    digest: null,
    stageToken: null,
  })
})

test('a reopened adapter rolls staged files back when the host database did not commit', (t) => {
  const { db, env, port } = fixture(t)
  createStored({ db, env, id: 'restart-rollback', userId: 'owner-a', sessionId: 'session-a', content: 'rollback' })
  const source = storedPath({ env, id: 'restart-rollback', userId: 'owner-a' })
  const preview = port.previewDeletion({
    userId: 'owner-a',
    scope: { kind: 'session', sessionId: 'session-a' },
  })
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope: { kind: 'session', sessionId: 'session-a' },
    operationId: 'restart-rollback-operation',
    expectedDigest: preview.digest,
  })
  assert.equal(fs.existsSync(source), false)

  const reopened = reopenPort({ db, env })
  assert.throws(
    () => reopened.create({
      userId: 'owner-a',
      sessionId: 'session-a',
      archivedMessages: [],
      summaryText: 'must remain fenced after restart',
    }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_DELETION_IN_PROGRESS',
  )
  const first = reopened.recoverDeletion({
    userId: 'owner-a',
    operationId: 'restart-rollback-operation',
    databaseCommitted: false,
    expectedDigest: staged.digest,
    expectedStageToken: staged.stageToken,
  })
  const second = reopenPort({ db, env }).recoverDeletion({
    userId: 'owner-a',
    operationId: 'restart-rollback-operation',
    databaseCommitted: false,
    expectedDigest: staged.digest,
    expectedStageToken: staged.stageToken,
  })
  assert.deepEqual(first, {
    userId: 'owner-a',
    operationId: 'restart-rollback-operation',
    recovered: true,
    state: 'rolled_back',
    digest: staged.digest,
    stageToken: staged.stageToken,
  })
  assert.deepEqual(second, first)
  assert.equal(fs.existsSync(source), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
})

test('a reopened adapter commits staged files after the host database already committed', (t) => {
  const { db, env, port } = fixture(t)
  createStored({ db, env, id: 'restart-commit', userId: 'owner-a', sessionId: 'session-a', content: 'commit' })
  const source = storedPath({ env, id: 'restart-commit', userId: 'owner-a' })
  const scope = { kind: 'session', sessionId: 'session-a' }
  const preview = port.previewDeletion({ userId: 'owner-a', scope })
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope,
    operationId: 'restart-commit-operation',
    expectedDigest: preview.digest,
  })
  db.prepare('DELETE FROM compaction_archive WHERE user_id = ? AND session_id = ?')
    .run('owner-a', 'session-a')

  const reopened = reopenPort({ db, env })
  const first = reopened.recoverDeletion({
    userId: 'owner-a',
    operationId: 'restart-commit-operation',
    databaseCommitted: true,
    expectedDigest: staged.digest,
    expectedStageToken: staged.stageToken,
  })
  const second = reopenPort({ db, env }).recoverDeletion({
    userId: 'owner-a',
    operationId: 'restart-commit-operation',
    databaseCommitted: true,
    expectedDigest: staged.digest,
    expectedStageToken: staged.stageToken,
  })
  assert.deepEqual(first, {
    userId: 'owner-a',
    operationId: 'restart-commit-operation',
    recovered: true,
    state: 'committed',
    digest: staged.digest,
    stageToken: staged.stageToken,
  })
  assert.deepEqual(second, first)
  assert.equal(fs.existsSync(source), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 0)
})

test('tampered logical manifests fail closed before commit, rollback, or recovery touches files', (t) => {
  const { db, env, port } = fixture(t)
  createStored({ db, env, id: 'tamper-file', userId: 'owner-a', sessionId: 'session-a', content: 'tamper' })
  const preview = port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } })
  const staged = port.stageDeletion({
    userId: 'owner-a',
    scope: { kind: 'user' },
    operationId: 'tamper-operation',
    expectedDigest: preview.digest,
  })
  const [manifestPath] = manifestFiles(env)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.files[0].storagePath = '../outside.json'
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)
  const outside = path.join(env.APP_DATA_DIR, 'outside.json')
  fs.writeFileSync(outside, 'sentinel')
  const input = operationInput(staged)

  for (const invoke of [
    () => port.commitDeletion(input),
    () => port.rollbackDeletion(input),
    () => port.recoverDeletion({
      userId: 'owner-a',
      operationId: 'tamper-operation',
      databaseCommitted: true,
      expectedDigest: input.digest,
      expectedStageToken: input.stageToken,
    }),
  ]) {
    assert.throws(
      invoke,
      (error) => [
        'COMPACTION_ARCHIVE_GOVERNANCE_MANIFEST_INVALID',
        'COMPACTION_ARCHIVE_STORAGE_INVALID',
      ].includes(error?.code),
    )
    assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel')
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
})

test('user deletion refuses non-regular owner bucket entries without touching data', (t) => {
  const { db, env, port } = fixture(t)
  createStored({
    db,
    env,
    id: 'unsafe-bucket-file',
    userId: 'owner-a',
    sessionId: 'session-a',
    content: 'preserve me',
  })
  const source = storedPath({ env, id: 'unsafe-bucket-file', userId: 'owner-a' })
  const unsafeDirectory = path.join(path.dirname(source), 'unexpected-directory')
  fs.mkdirSync(unsafeDirectory)

  assert.throws(
    () => port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
  )
  assert.equal(fs.existsSync(source), true)
  assert.equal(fs.existsSync(unsafeDirectory), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
})

test('user deletion refuses owner bucket symlinks without following them', (t) => {
  const { db, env, port, root } = fixture(t)
  createStored({
    db,
    env,
    id: 'unsafe-link-file',
    userId: 'owner-a',
    sessionId: 'session-a',
    content: 'preserve link target',
  })
  const source = storedPath({ env, id: 'unsafe-link-file', userId: 'owner-a' })
  const outside = path.join(root, 'outside.txt')
  const link = path.join(path.dirname(source), 'unexpected-link.json')
  fs.writeFileSync(outside, 'outside sentinel')
  try {
    fs.symlinkSync(outside, link, 'file')
  } catch (error) {
    t.skip(`file symlinks are unavailable: ${error.code || error.message}`)
    return
  }

  assert.throws(
    () => port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
  )
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside sentinel')
  assert.equal(fs.existsSync(source), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
})

test('user deletion refuses owner bucket junctions without reading outside data', (t) => {
  const { db, env, port, root } = fixture(t)
  createStored({
    db,
    env,
    id: 'unsafe-junction-file',
    userId: 'owner-a',
    sessionId: 'session-a',
    content: 'preserve junction target',
  })
  const source = storedPath({ env, id: 'unsafe-junction-file', userId: 'owner-a' })
  const outside = path.join(root, 'outside-directory')
  const junction = path.join(path.dirname(source), 'unexpected-junction')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside sentinel')
  try {
    fs.symlinkSync(outside, junction, 'junction')
  } catch (error) {
    t.skip(`junction creation is unavailable: ${error.code || error.message}`)
    return
  }

  assert.throws(
    () => port.previewDeletion({ userId: 'owner-a', scope: { kind: 'user' } }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_GOVERNANCE_STORAGE_UNSAFE',
  )
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside sentinel')
  assert.equal(fs.existsSync(source), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM compaction_archive').get().count, 1)
})
