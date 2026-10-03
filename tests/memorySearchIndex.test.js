import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createNodeSqliteDatabase } from '../server/adapters/sqliteDriver.js'
import { migrateToV120 } from '../server/migrations/v120MemorySearchIndex.js'
import { findIndexedMemory } from '../server/services/memoryExactMatch.js'
import { prepareMemorySearchIndex } from '../server/services/memorySearchIndex.js'
import { searchLexicalMemories } from '../server/services/memoryLexicalSearch.js'

const drivers = [['better-sqlite3', Database]]
try {
  const { DatabaseSync } = await import('node:sqlite')
  drivers.push(['node:sqlite', createNodeSqliteDatabase(DatabaseSync)])
} catch { /* Node 20 does not provide the optional node:sqlite driver. */ }

function fixture(Driver, filename = ':memory:') {
  const db = new Driver(filename)
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES('owner'),('other');
    CREATE TABLE memories(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT,type TEXT NOT NULL,title TEXT NOT NULL,slug TEXT NOT NULL,body TEXT NOT NULL,
      frontmatter_json TEXT,pinned INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 1,last_used_at INTEGER,source_session_id TEXT,source_message_id TEXT);
    CREATE INDEX memories_owner ON memories(user_id);`)
  return db
}

function insert(db, id, options = {}) {
  db.prepare(`INSERT INTO memories(id,user_id,agent_id,type,title,slug,body,frontmatter_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, options.userId || 'owner', options.agentId || null,
    options.type || 'project', options.title || id, `old-${id}`, options.body || 'Stable body.',
    JSON.stringify(options.frontmatter || {}))
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total
const scope = { userId: 'owner', limits: { maxRows: 2, maxDurationMs: 1000 } }

for (const [label, Driver] of drivers) {
  test(`${label}: migration preserves duplicate legacy source rows and resumes bounded backfill`, () => {
    const db = fixture(Driver)
    try {
      for (let index = 0; index < 7; index += 1) insert(db, `old-${index}`, { title: 'Duplicate title', body: `Body ${index}` })
      const before = db.prepare('SELECT * FROM memories ORDER BY rowid').all()
      migrateToV120(db)
      assert.deepEqual(db.prepare('SELECT * FROM memories ORDER BY rowid').all(), before)
      assert.equal(count(db, 'memory_search_pending'), 7)
      const first = prepareMemorySearchIndex(db, scope)
      assert.equal(first.indexed, 2)
      assert.equal(first.complete, false)
      assert.equal(first.code, 'MEMORY_SEARCH_INDEX_ROW_LIMIT')
      migrateToV120(db)
      assert.equal(count(db, 'memory_search_pending'), 5)
      assert.equal(count(db, 'memory_search_index'), 2)
      for (let index = 0; index < 3; index += 1) prepareMemorySearchIndex(db, scope)
      assert.equal(count(db, 'memory_search_pending'), 0)
      assert.equal(count(db, 'memory_search_index'), 7)
      assert.deepEqual(db.prepare('SELECT * FROM memories ORDER BY rowid').all(), before)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    } finally { db.close() }
  })

  test(`${label}: incomplete matching never reports a false absence and its progress commits`, () => {
    const db = fixture(Driver)
    try {
      for (let index = 0; index < 5; index += 1) insert(db, `old-${index}`, { title: `Old ${index}` })
      migrateToV120(db)
      const lookup = () => findIndexedMemory(db, { ...scope, title: 'Old 4', mode: 'exact_title' })
      assert.throws(lookup, { code: 'MEMORY_SEARCH_INDEX_INCOMPLETE' })
      assert.equal(count(db, 'memory_search_pending'), 3)
      assert.throws(lookup, { code: 'MEMORY_SEARCH_INDEX_INCOMPLETE' })
      assert.equal(count(db, 'memory_search_pending'), 1)
      assert.equal(lookup().id, 'old-4')
      assert.equal(count(db, 'memories'), 5)
    } finally { db.close() }
  })

  test(`${label}: pending queue survives an actual database close and reopen`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-index-restart-'))
    const filename = path.join(directory, 'fixture.db')
    let db = fixture(Driver, filename)
    try {
      for (let index = 0; index < 5; index += 1) insert(db, `persisted-${index}`)
      migrateToV120(db)
      prepareMemorySearchIndex(db, scope)
      db.close()
      db = new Driver(filename)
      db.pragma('foreign_keys = ON')
      assert.equal(count(db, 'memory_search_index'), 2)
      const next = prepareMemorySearchIndex(db, scope)
      assert.equal(next.indexed, 2)
      assert.equal(count(db, 'memory_search_pending'), 1)
      assert.equal(prepareMemorySearchIndex(db, scope).complete, true)
    } finally {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })

  test(`${label}: external content and ownership changes invalidate stale keys before recall`, () => {
    const db = fixture(Driver)
    try {
      migrateToV120(db)
      insert(db, 'target', { title: 'Original', body: 'Alpha', frontmatter: { source: 'auto_chat' } })
      prepareMemorySearchIndex(db, scope)
      db.prepare('UPDATE memories SET title=?,body=?,agent_id=?,user_id=?,frontmatter_json=? WHERE id=?')
        .run('Ｆｏｏ', 'Beta', 'agent-two', 'other', '{"tags":["ÉQUIPE"]}', 'target')
      assert.equal(count(db, 'memory_search_index'), 0)
      assert.equal(count(db, 'memory_search_pending'), 1)
      assert.equal(findIndexedMemory(db, { userId: 'owner', title: 'Original' }), null)
      assert.equal(findIndexedMemory(db, { userId: 'other', title: 'Ｆｏｏ' }), null)
      const found = findIndexedMemory(db, { userId: 'other', agentId: 'agent-two', title: 'Ｆｏｏ' })
      assert.equal(found.id, 'target')
      assert.equal(found.frontmatter.source, undefined)
      assert.equal(searchLexicalMemories(db, { userId: 'other', agentId: 'agent-two', query: 'équipe' }).memories[0]?.id, 'target')
      db.prepare('DELETE FROM memories WHERE id=?').run('target')
      assert.equal(count(db, 'memory_search_index'), 0)
      assert.equal(count(db, 'memory_search_pending'), 0)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    } finally { db.close() }
  })

  test(`${label}: index write failure does not dequeue the original legacy row`, () => {
    const db = fixture(Driver)
    try {
      migrateToV120(db)
      insert(db, 'target')
      db.exec("CREATE TRIGGER reject_index BEFORE INSERT ON memory_search_index BEGIN SELECT RAISE(ABORT,'fixture rejected index'); END")
      assert.throws(() => prepareMemorySearchIndex(db, scope), /fixture rejected index/)
      assert.equal(count(db, 'memory_search_pending'), 1)
      assert.equal(count(db, 'memory_search_index'), 0)
      assert.equal(count(db, 'memories'), 1)
      db.exec('DROP TRIGGER reject_index')
      assert.equal(prepareMemorySearchIndex(db, scope).complete, true)
    } finally { db.close() }
  })

  test(`${label}: a later keyset page failure retains committed backfill and source data`, (t) => {
    const db = fixture(Driver)
    try {
      for (let index = 0; index < 70; index += 1) insert(db, `legacy-${index}`)
      migrateToV120(db)
      const prepare = db.prepare.bind(db)
      let pages = 0
      const mock = t.mock.method(db, 'prepare', (sql) => {
        const statement = prepare(sql)
        if (/p\.memory_order > \?/u.test(sql)) {
          const all = statement.all.bind(statement)
          statement.all = (...args) => {
            pages += 1
            if (pages === 2) throw new Error('fixture second keyset page failed')
            return all(...args)
          }
        }
        return statement
      })
      try {
        assert.throws(() => prepareMemorySearchIndex(db, {
          userId: 'owner', limits: { maxRows: 70, maxDurationMs: 1000 },
        }), /fixture second keyset page failed/)
      } finally { mock.mock.restore() }
      assert.equal(count(db, 'memory_search_index'), 32)
      assert.equal(count(db, 'memory_search_pending'), 38)
      assert.equal(count(db, 'memories'), 70)
      assert.equal(prepareMemorySearchIndex(db, { userId: 'owner', limits: { maxDurationMs: 1000 } }).complete, true)
    } finally { db.close() }
  })

  test(`${label}: scoped catch-up never consumes another owner's or agent's pending rows`, () => {
    const db = fixture(Driver)
    try {
      insert(db, 'global')
      insert(db, 'agent-one', { agentId: 'first' })
      insert(db, 'agent-two', { agentId: 'second' })
      insert(db, 'other-owner', { userId: 'other' })
      migrateToV120(db)
      const first = prepareMemorySearchIndex(db, { userId: 'owner', agentId: 'first', includeGlobal: true })
      assert.equal(first.complete, true)
      assert.equal(first.indexed, 2)
      assert.deepEqual(db.prepare('SELECT memory_id FROM memory_search_pending ORDER BY memory_id').all(), [
        { memory_id: 'agent-two' }, { memory_id: 'other-owner' },
      ])
    } finally { db.close() }
  })

  test(`${label}: lexical keyset continuation is query and ownership bound`, () => {
    const db = fixture(Driver)
    try {
      for (let index = 0; index < 5; index += 1) insert(db, `fact-${index}`, { body: `Alpha fact ${index}` })
      migrateToV120(db)
      prepareMemorySearchIndex(db, { userId: 'owner' })
      const options = { userId: 'owner', query: 'alpha', limits: { maxScanned: 2, maxDurationMs: 1000 } }
      const first = searchLexicalMemories(db, options)
      assert.equal(first.diagnostics.code, 'MEMORY_LEXICAL_SCAN_LIMIT')
      const second = searchLexicalMemories(db, { ...options, cursor: first.diagnostics.nextCursor })
      const last = searchLexicalMemories(db, { ...options, cursor: second.diagnostics.nextCursor })
      assert.equal(last.diagnostics.rangeComplete, true)
      assert.equal(last.diagnostics.coverage, 'partial')
      assert.equal(new Set([...first.memories, ...second.memories, ...last.memories].map((memory) => memory.id)).size, 5)
      for (const changed of [{ userId: 'other' }, { agentId: 'second' }, { query: 'different' }]) {
        const rejected = searchLexicalMemories(db, { ...options, ...changed, cursor: first.diagnostics.nextCursor })
        assert.equal(rejected.diagnostics.code, 'MEMORY_LEXICAL_CURSOR_MISMATCH')
        assert.deepEqual(rejected.memories, [])
      }
    } finally { db.close() }
  })

  test(`${label}: aborted or text-limited indexing is partial and does not lose work`, () => {
    const db = fixture(Driver)
    try {
      migrateToV120(db)
      insert(db, 'target', { body: 'A'.repeat(500) })
      const controller = new AbortController()
      controller.abort()
      const cancelled = prepareMemorySearchIndex(db, { ...scope, signal: controller.signal })
      assert.equal(cancelled.code, 'MEMORY_SEARCH_INDEX_ABORTED')
      assert.equal(cancelled.indexed, 0)
      const bounded = prepareMemorySearchIndex(db, { userId: 'owner', limits: { maxTextChars: 100 } })
      assert.equal(bounded.code, 'MEMORY_SEARCH_INDEX_TEXT_LIMIT')
      assert.equal(count(db, 'memory_search_pending'), 1)
      assert.equal(prepareMemorySearchIndex(db, scope).complete, true)
      insert(db, 'deadline-target')
      let now = 0
      const timed = prepareMemorySearchIndex(db, { userId: 'owner', limits: { maxDurationMs: 1 } }, { now: () => ++now })
      assert.equal(timed.code, 'MEMORY_SEARCH_INDEX_TIME_LIMIT')
      assert.equal(count(db, 'memory_search_pending'), 1)
    } finally { db.close() }
  })
}
