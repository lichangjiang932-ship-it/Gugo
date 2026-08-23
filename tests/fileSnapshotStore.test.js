import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-file-snapshots-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  APP_DATA_DIR: process.env.APP_DATA_DIR,
}

process.env.APP_DB_PATH = path.join(workspace, 'snapshots.db')
process.env.APP_DATA_DIR = path.join(workspace, 'data')

const { closeDb, getDb } = await import('../server/db.js')
const {
  _testing,
  finalizeFileSnapshot,
  listSnapshots,
  recordFileSnapshot,
  restoreSnapshot,
  rewindFromToolCall,
} = await import('../server/services/fileSnapshotStore.js')

const userId = 'snap-user'
const sessionId = 'snap-session'
const turnId = 'snap-turn'
const fileA = path.join(workspace, 'a.txt')
const fileB = path.join(workspace, 'b.txt')

function finalizeSnapshot(snapshot, content) {
  const bytes = Buffer.from(content, 'utf8')
  return finalizeFileSnapshot({
    userId,
    id: snapshot.id,
    afterExists: true,
    afterSha256: createHash('sha256').update(bytes).digest('hex'),
    afterBytes: bytes.byteLength,
  })
}

before(() => {
  const now = Date.now()
  getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
    .run(userId, 'snap@example.com', now, now)
  fs.writeFileSync(fileA, 'A-v1', 'utf8')
  fs.writeFileSync(fileB, 'B-v1', 'utf8')
})

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('recordFileSnapshot is idempotent per tool call + path', () => {
  const first = recordFileSnapshot({
    userId, sessionId, turnId, toolCallId: 'call-1', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'A-v1', createdAt: 100,
  })
  const second = recordFileSnapshot({
    userId, sessionId, turnId, toolCallId: 'call-1', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'A-v1', createdAt: 200,
  })
  assert.equal(first.id, second.id)
  assert.equal(first.beforePath, second.beforePath)
})

test('listSnapshots returns owner-scoped snapshots newest first', () => {
  recordFileSnapshot({
    userId, sessionId, turnId, toolCallId: 'call-2', toolName: 'edit_file',
    filePath: fileB, beforeContent: 'B-v1', createdAt: 300,
  })
  const snapshots = listSnapshots({ userId, sessionId, turnId })
  assert.ok(snapshots.length >= 2)
  assert.equal(snapshots[0].toolCallId, 'call-2')
})

test('rewindFromToolCall restores files touched from the target call onward', () => {
  // Simulate later mutations on top of the recorded before-images.
  fs.writeFileSync(fileA, 'A-v2', 'utf8')
  fs.writeFileSync(fileB, 'B-v2', 'utf8')
  const snapshots = listSnapshots({ userId, sessionId, turnId })
  finalizeSnapshot(snapshots.find((entry) => entry.toolCallId === 'call-1'), 'A-v2')
  finalizeSnapshot(snapshots.find((entry) => entry.toolCallId === 'call-2'), 'B-v2')

  const result = rewindFromToolCall({ userId, sessionId, turnId, toolCallId: 'call-1' })
  assert.equal(result.found, true)
  assert.ok(result.count >= 2)
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'A-v1')
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'B-v1')
})

test('rewind deletes a file that did not exist before its recorded write', () => {
  const newFile = path.join(workspace, 'created-later.txt')
  fs.writeFileSync(newFile, 'created', 'utf8')
  recordFileSnapshot({
    userId, sessionId, turnId, toolCallId: 'call-create', toolName: 'write_file',
    filePath: newFile, beforeContent: null, createdAt: 400,
  })
  fs.writeFileSync(newFile, 'created-v2', 'utf8')
  const snapshot = listSnapshots({ userId, sessionId, turnId })
    .find((entry) => entry.toolCallId === 'call-create')
  finalizeSnapshot(snapshot, 'created-v2')

  const result = rewindFromToolCall({ userId, sessionId, turnId, toolCallId: 'call-create' })
  assert.equal(result.found, true)
  assert.equal(fs.existsSync(newFile), false)
})

test('rewind without a target restores every snapshot in the turn', () => {
  const localTurnId = 'rewind-all-turn'
  const snapshotA = recordFileSnapshot({
    userId, sessionId, turnId: localTurnId, toolCallId: 'all-a', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'A-v1', createdAt: 500,
  })
  fs.writeFileSync(fileA, 'A-v4', 'utf8')
  finalizeSnapshot(snapshotA, 'A-v4')
  const snapshotB = recordFileSnapshot({
    userId, sessionId, turnId: localTurnId, toolCallId: 'all-b', toolName: 'edit_file',
    filePath: fileB, beforeContent: 'B-v1', createdAt: 600,
  })
  fs.writeFileSync(fileB, 'B-v4', 'utf8')
  finalizeSnapshot(snapshotB, 'B-v4')
  const result = rewindFromToolCall({ userId, sessionId, turnId: localTurnId })
  assert.equal(result.found, true)
  assert.ok(result.count >= 1)
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'A-v1')
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'B-v1')
})

test('restoreSnapshot restores one file and returns its snapshot', () => {
  const target = recordFileSnapshot({
    userId, sessionId, turnId: 'restore-one-turn', toolCallId: 'restore-one', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'A-v1', createdAt: 700,
  })
  fs.writeFileSync(fileA, 'A-v3', 'utf8')
  finalizeSnapshot(target, 'A-v3')
  const outcome = restoreSnapshot({ userId, id: target.id })
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'A-v1')
  assert.equal(outcome.snapshot.id, target.id)
  assert.equal(outcome.action, 'restored')
})

test('restore rejects a user edit made after the tool write', () => {
  const snapshot = recordFileSnapshot({
    userId, sessionId, turnId: 'user-edit-turn', toolCallId: 'user-edit', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'A-v1', createdAt: 800,
  })
  fs.writeFileSync(fileA, 'tool-output', 'utf8')
  finalizeSnapshot(snapshot, 'tool-output')
  fs.writeFileSync(fileA, 'user-output', 'utf8')
  assert.throws(
    () => restoreSnapshot({ userId, id: snapshot.id }),
    (error) => error.code === 'FILE_SNAPSHOT_CONFLICT' && error.statusCode === 409,
  )
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'user-output')
})

test('rewind never deletes a newly created file that was changed later', () => {
  const createdPath = path.join(workspace, 'created-and-changed.txt')
  const snapshot = recordFileSnapshot({
    userId, sessionId, turnId: 'created-conflict-turn', toolCallId: 'created-conflict', toolName: 'write_file',
    filePath: createdPath, beforeContent: null, createdAt: 900,
  })
  fs.writeFileSync(createdPath, 'tool-created', 'utf8')
  finalizeSnapshot(snapshot, 'tool-created')
  fs.writeFileSync(createdPath, 'user-replaced', 'utf8')
  assert.throws(
    () => rewindFromToolCall({ userId, sessionId, turnId: 'created-conflict-turn' }),
    (error) => error.code === 'FILE_SNAPSHOT_CONFLICT' && error.statusCode === 409,
  )
  assert.equal(fs.readFileSync(createdPath, 'utf8'), 'user-replaced')
})

test('legacy snapshots without an after identity fail closed', () => {
  const snapshot = recordFileSnapshot({
    userId, sessionId, turnId: 'legacy-turn', toolCallId: 'legacy-call', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'before-legacy', createdAt: 1000,
  })
  fs.writeFileSync(fileA, 'after-legacy', 'utf8')
  assert.throws(
    () => restoreSnapshot({ userId, id: snapshot.id }),
    (error) => error.code === 'FILE_SNAPSHOT_CONFLICT' && error.statusCode === 409,
  )
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'after-legacy')
})

test('restore preserves an external write made after claim hash verification', () => {
  const snapshot = recordFileSnapshot({
    userId, sessionId, turnId: 'claim-race-turn', toolCallId: 'claim-race', toolName: 'edit_file',
    filePath: fileA, beforeContent: 'before-race', createdAt: 1100,
  })
  fs.writeFileSync(fileA, 'tool-race-output', 'utf8')
  finalizeSnapshot(snapshot, 'tool-race-output')
  _testing.setAfterClaimVerifiedHook(() => {
    fs.writeFileSync(fileA, 'external-after-hash', 'utf8')
  })
  try {
    assert.throws(
      () => restoreSnapshot({ userId, id: snapshot.id }),
      (error) => error.code === 'FILE_SNAPSHOT_CONFLICT'
        && error.statusCode === 409
        && error.reason === 'target_recreated_during_restore'
        && typeof error.recoveryPath === 'string'
        && fs.readFileSync(error.recoveryPath, 'utf8') === 'tool-race-output',
    )
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'external-after-hash')
  } finally {
    _testing.setAfterClaimVerifiedHook(null)
  }
})

test('multi-file rewind reports completed entries before a later conflict', () => {
  const conflictPath = path.join(workspace, 'partial-conflict.txt')
  const restoredPath = path.join(workspace, 'partial-restored.txt')
  fs.writeFileSync(conflictPath, 'conflict-before', 'utf8')
  fs.writeFileSync(restoredPath, 'restored-before', 'utf8')
  const first = recordFileSnapshot({
    userId, sessionId, turnId: 'partial-turn', toolCallId: 'partial-first', toolName: 'edit_file',
    filePath: conflictPath, beforeContent: 'conflict-before', createdAt: 1200,
  })
  fs.writeFileSync(conflictPath, 'conflict-tool', 'utf8')
  finalizeSnapshot(first, 'conflict-tool')
  const second = recordFileSnapshot({
    userId, sessionId, turnId: 'partial-turn', toolCallId: 'partial-second', toolName: 'edit_file',
    filePath: restoredPath, beforeContent: 'restored-before', createdAt: 1300,
  })
  fs.writeFileSync(restoredPath, 'restored-tool', 'utf8')
  finalizeSnapshot(second, 'restored-tool')
  fs.writeFileSync(conflictPath, 'conflict-user', 'utf8')

  assert.throws(
    () => rewindFromToolCall({
      userId,
      sessionId,
      turnId: 'partial-turn',
      toolCallId: 'partial-first',
    }),
    (error) => error.code === 'FILE_SNAPSHOT_CONFLICT'
      && error.partialCount === 1
      && error.partialRewind?.[0]?.snapshotId === second.id,
  )
  assert.equal(fs.readFileSync(restoredPath, 'utf8'), 'restored-before')
  assert.equal(fs.readFileSync(conflictPath, 'utf8'), 'conflict-user')
})

test('an owner clear journal blocks snapshot recording and rewind mutations', () => {
  const db = getDb()
  const timestamp = Date.now()
  db.prepare(`
    INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
  `).run(
    'snapshot-clear-guard-operation',
    userId,
    'snapshot-clear-guard',
    process.pid,
    timestamp + 60_000,
    timestamp,
    timestamp,
  )
  try {
    assert.throws(
      () => recordFileSnapshot({
        userId,
        sessionId,
        turnId,
        toolCallId: 'call-blocked-by-clear',
        toolName: 'edit_file',
        filePath: fileA,
        beforeContent: 'blocked',
      }),
      (error) => error.code === 'USER_DATA_CLEAR_IN_PROGRESS'
        && error.statusCode === 409,
    )
    fs.writeFileSync(fileA, 'must-not-rewind', 'utf8')
    assert.throws(
      () => rewindFromToolCall({ userId, sessionId, turnId }),
      (error) => error.code === 'USER_DATA_CLEAR_IN_PROGRESS'
        && error.statusCode === 409,
    )
    assert.equal(fs.readFileSync(fileA, 'utf8'), 'must-not-rewind')
  } finally {
    db.prepare('DELETE FROM user_data_clear_operations WHERE owner_id = ?').run(userId)
  }
})
