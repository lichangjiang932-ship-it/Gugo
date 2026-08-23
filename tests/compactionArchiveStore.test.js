import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { migrateToV97 } from '../server/migrations/v97CompactionArchiveStorage.js'
import {
  _testing,
  createCompactionArchiveRecord,
  getCompactionArchiveRecord,
  resolveCompactionArchiveStorage,
} from '../server/services/compactionArchiveStore.js'
import { cleanupCompactionArchiveOrphans } from '../server/services/compactionArchiveStorageGc.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-compaction-archive-'))
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
  migrateToV97(db)
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { db, env, root }
}

function storedPath({ userId, id, env }) {
  return resolveCompactionArchiveStorage({
    userId,
    id,
    storagePath: _testing.expectedStoragePath(userId, id),
    env,
  }).fullPath
}

test('new compaction archives keep only metadata in SQLite and round-trip verified file content', (t) => {
  const { db, env } = fixture(t)
  const archivedMessages = [
    { role: 'user', content: 'private local context' },
    { role: 'assistant', content: 'local response' },
  ]
  const archive = createCompactionArchiveRecord({
    id: 'cmp-file-backed',
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages,
    summaryText: 'summary',
    now: 123,
    db,
    env,
  })

  assert.deepEqual(archive.archivedMessages, archivedMessages)
  const row = db.prepare('SELECT * FROM compaction_archive WHERE id = ?').get(archive.id)
  assert.equal(row.archived_messages_json, '[]')
  assert.equal(row.storage_path, _testing.expectedStoragePath('owner-a', archive.id))
  assert.equal(row.size_bytes, Buffer.byteLength(JSON.stringify(archivedMessages)))
  assert.match(row.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(fs.readFileSync(storedPath({ userId: 'owner-a', id: archive.id, env }), 'utf8'), JSON.stringify(archivedMessages))
  assert.deepEqual(getCompactionArchiveRecord({ userId: 'owner-a', id: archive.id, db, env }), archive)
})

test('legacy inline archives remain readable after the file metadata migration', (t) => {
  const { db, env } = fixture(t)
  const messages = [{ role: 'user', content: 'legacy body' }]
  db.prepare(`
    INSERT INTO compaction_archive (
      id, user_id, session_id, replaced_message_count,
      archived_messages_json, summary_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy', 'owner-a', 'session-a', messages.length, JSON.stringify(messages), 'legacy summary', 10)

  assert.deepEqual(
    getCompactionArchiveRecord({ userId: 'owner-a', id: 'legacy', db, env })?.archivedMessages,
    messages,
  )
})

test('reads fail closed on cross-user access, path tampering, size drift, and digest tampering', (t) => {
  const { db, env } = fixture(t)
  createCompactionArchiveRecord({
    id: 'protected',
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages: [{ role: 'user', content: 'secret' }],
    summaryText: '',
    db,
    env,
  })
  assert.equal(getCompactionArchiveRecord({ userId: 'owner-b', id: 'protected', db, env }), null)

  const originalPath = _testing.expectedStoragePath('owner-a', 'protected')
  db.prepare('UPDATE compaction_archive SET storage_path = ? WHERE id = ?').run('../outside.json', 'protected')
  assert.throws(
    () => getCompactionArchiveRecord({ userId: 'owner-a', id: 'protected', db, env }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_STORAGE_INVALID',
  )

  db.prepare('UPDATE compaction_archive SET storage_path = ? WHERE id = ?').run(originalPath, 'protected')
  db.prepare('UPDATE compaction_archive SET size_bytes = size_bytes + 1 WHERE id = ?').run('protected')
  assert.throws(
    () => getCompactionArchiveRecord({ userId: 'owner-a', id: 'protected', db, env }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
  )

  db.prepare('UPDATE compaction_archive SET size_bytes = size_bytes - 1 WHERE id = ?').run('protected')
  const fullPath = storedPath({ userId: 'owner-a', id: 'protected', env })
  const tampered = fs.readFileSync(fullPath, 'utf8').replace('secret', 'tamper')
  fs.writeFileSync(fullPath, tampered)
  assert.throws(
    () => getCompactionArchiveRecord({ userId: 'owner-a', id: 'protected', db, env }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_INTEGRITY_FAILED',
  )
})

test('a metadata failure removes the already-renamed archive file', (t) => {
  const { db, env } = fixture(t)
  db.prepare(`
    INSERT INTO compaction_archive (
      id, user_id, session_id, replaced_message_count,
      archived_messages_json, summary_text, created_at
    ) VALUES ('duplicate', 'legacy-owner', 'legacy-session', 0, '[]', '', 1)
  `).run()
  const fullPath = storedPath({ userId: 'owner-a', id: 'duplicate', env })

  assert.throws(() => createCompactionArchiveRecord({
    id: 'duplicate',
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages: [],
    summaryText: '',
    db,
    env,
  }), /UNIQUE constraint failed/u)
  assert.equal(fs.existsSync(fullPath), false)
})

test('a durable user-data clear journal fences archive creation and leaves no file behind', (t) => {
  const { db, env } = fixture(t)
  db.exec(`
    CREATE TABLE user_data_clear_operations (
      operation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL UNIQUE
    );
    INSERT INTO user_data_clear_operations VALUES ('operation-a', 'owner-a');
  `)
  const fullPath = storedPath({ userId: 'owner-a', id: 'blocked', env })

  assert.throws(
    () => createCompactionArchiveRecord({
      id: 'blocked',
      userId: 'owner-a',
      sessionId: 'session-a',
      archivedMessages: [],
      summaryText: '',
      db,
      env,
    }),
    (error) => error?.code === 'USER_DATA_CLEAR_IN_PROGRESS',
  )
  assert.equal(fs.existsSync(fullPath), false)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM compaction_archive WHERE id = 'blocked'").get().count, 0)
})

test('orphan cleanup preserves referenced archives and removes expired final and temporary files', (t) => {
  const { db, env } = fixture(t)
  createCompactionArchiveRecord({
    id: 'referenced',
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages: [],
    summaryText: '',
    now: 1,
    db,
    env,
  })
  const referenced = storedPath({ userId: 'owner-a', id: 'referenced', env })
  const bucket = path.dirname(referenced)
  const orphan = path.join(bucket, `${crypto.randomBytes(32).toString('hex')}.json`)
  const temporary = path.join(
    bucket,
    `.${crypto.randomBytes(32).toString('hex')}.json.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  fs.writeFileSync(orphan, 'orphan')
  fs.writeFileSync(temporary, 'temporary')
  fs.utimesSync(orphan, new Date(1), new Date(1))
  fs.utimesSync(temporary, new Date(1), new Date(1))

  const result = cleanupCompactionArchiveOrphans({
    userId: 'owner-a',
    db,
    env,
    now: Date.now(),
    orphanGraceMs: 0,
  })

  assert.equal(fs.existsSync(referenced), true)
  assert.equal(fs.existsSync(orphan), false)
  assert.equal(fs.existsSync(temporary), false)
  assert.equal(result.removedFiles, 2)
})
