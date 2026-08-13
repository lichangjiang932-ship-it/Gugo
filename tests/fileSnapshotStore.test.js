import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
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

  const result = rewindFromToolCall({ userId, sessionId, turnId, toolCallId: 'call-create' })
  assert.equal(result.found, true)
  assert.equal(fs.existsSync(newFile), false)
})

test('rewind without a target restores every snapshot in the turn', () => {
  fs.writeFileSync(fileA, 'A-v4', 'utf8')
  fs.writeFileSync(fileB, 'B-v4', 'utf8')
  const result = rewindFromToolCall({ userId, sessionId, turnId })
  assert.equal(result.found, true)
  assert.ok(result.count >= 1)
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'A-v1')
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'B-v1')
})

test('restoreSnapshot restores one file and returns its snapshot', () => {
  fs.writeFileSync(fileA, 'A-v3', 'utf8')
  const snapshots = listSnapshots({ userId, sessionId, turnId })
  const target = snapshots.find((snapshot) => snapshot.toolCallId === 'call-1')
  const outcome = restoreSnapshot({ userId, id: target.id })
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'A-v1')
  assert.equal(outcome.snapshot.id, target.id)
  assert.equal(outcome.action, 'restored')
})
