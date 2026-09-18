import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-matching-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
const { getDb, closeDb } = await import('../server/db.js')
const { findMatchingMemory, getMemory, upsertMemory } = await import('../server/services/memoryStore.js')
const { extractAndStoreAutoMemories } = await import('../server/services/autoMemoryService.js')
const { dispatchMemoryTool } = await import('../server/utils/memoryTools.js')
const db = getDb()
let sequence = 0

after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function owner() {
  const id = `indexed-owner-${++sequence}`
  db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)')
    .run(id, `${id}@example.com`, 1, 1)
  return id
}

function noise(userId, count = 700) {
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      upsertMemory({ userId, type: 'project', title: `Pinned note ${index}`, body: `Other fact ${index}`, pinned: true })
    }
  })()
}

function auto(userId, title, body, extra = {}) {
  return extractAndStoreAutoMemories({
    userId, messages: [{ role: 'user', content: 'Remember this preference for all future project tasks.' }],
    assistantText: 'Understood.', ...extra,
    callModel: async () => JSON.stringify({ memories: [{ type: 'project', title, body, confidence: 0.95 }] }),
  })
}

test('automatic deduplication uses indexed candidates instead of reading unrelated memory pages', async (t) => {
  const userId = owner()
  const original = upsertMemory({ userId, type: 'project', title: 'Answer language', body: 'Use Chinese.', frontmatter: { source: 'auto_chat' } })
  noise(userId)
  const prepare = db.prepare.bind(db)
  let readRows = 0
  const queries = []
  const mock = t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql)
    if (/\bSELECT\b/i.test(sql) && /\bmemories\b/i.test(sql)) {
      queries.push(sql)
      const all = statement.all.bind(statement)
      statement.all = (...args) => { const rows = all(...args); readRows += rows.length; return rows }
    }
    return statement
  })
  let result
  try { result = await auto(userId, 'ANSWER\tLANGUAGE', 'Use English.') } finally { mock.mock.restore() }
  assert.equal(result.stored[0]?.id, original.id)
  assert.ok(readRows < 30, `Read ${readRows} rows for one exact match`)
  assert.ok(queries.every((query) => !/\bOFFSET\b/i.test(query)))
})

test('explicit remember matches exact trimmed title through the same index without case folding', (t) => {
  const userId = owner()
  const original = upsertMemory({ userId, type: 'project', title: 'Keep case', body: 'Original.' })
  const differentlyCased = upsertMemory({ userId, type: 'project', title: 'KEEP CASE', body: 'Distinct.' })
  noise(userId)
  const prepare = db.prepare.bind(db)
  const mock = t.mock.method(db, 'prepare', (sql) => {
    assert.doesNotMatch(sql, /\bOFFSET\b/i)
    return prepare(sql)
  })
  let result
  try { result = dispatchMemoryTool('remember', { type: 'project', title: ' Keep case ', body: 'Updated.' }, { userId }) } finally { mock.mock.restore() }
  assert.equal(result.id, original.id)
  assert.equal(getMemory(userId, differentlyCased.id).body, 'Distinct.')
})

test('generic predicate lookup fails closed when its bounded scan is incomplete', () => {
  const userId = owner()
  noise(userId, 5)
  assert.throws(() => findMatchingMemory({ userId, maxScanned: 2 }, () => false), {
    code: 'MEMORY_MATCH_SCAN_INCOMPLETE',
  })
})

test('generic predicate lookup checks cancellation before reading or reporting no match', () => {
  const userId = owner()
  const controller = new AbortController()
  controller.abort(new Error('fixture aborted'))
  assert.throws(() => findMatchingMemory({ userId, signal: controller.signal }, () => false), {
    code: 'MEMORY_MATCH_ABORTED',
  })
})

test('external source metadata edits become manual protection before automatic persistence', async () => {
  const userId = owner()
  const original = upsertMemory({ userId, type: 'project', title: 'Stable preference', body: 'Keep manual fact.', frontmatter: { source: 'auto_chat' } })
  db.prepare('UPDATE memories SET frontmatter_json=? WHERE id=?').run('{"source":"manual"}', original.id)
  const result = await auto(userId, 'stable preference', 'Unwanted override.')
  assert.deepEqual(result.stored, [])
  assert.equal(getMemory(userId, original.id).body, 'Keep manual fact.')
})

test('source and links roll back if synchronous index maintenance fails', () => {
  const userId = owner()
  const original = upsertMemory({ userId, type: 'project', title: 'Atomic index', body: 'Keep [[original]].' })
  const originalIndex = db.prepare('SELECT * FROM memory_search_index WHERE memory_id=?').get(original.id)
  db.exec("CREATE TRIGGER reject_memory_index BEFORE INSERT ON memory_search_index WHEN NEW.search_title='atomic index' BEGIN SELECT RAISE(ABORT,'fixture index unavailable'); END")
  try {
    assert.throws(() => upsertMemory({ userId, id: original.id, type: 'project', title: 'Atomic index', body: 'Change [[replacement]].' }), /fixture index unavailable/)
  } finally { db.exec('DROP TRIGGER reject_memory_index') }
  assert.deepEqual(getMemory(userId, original.id), original)
  assert.deepEqual(db.prepare('SELECT * FROM memory_search_index WHERE memory_id=?').get(original.id), originalIndex)
  assert.deepEqual(db.prepare('SELECT to_slug FROM memory_links WHERE from_id=?').all(original.id), [{ to_slug: 'original' }])
})

test('legacy indexing failure exposes only stable retry metadata and never creates a duplicate', () => {
  const userId = owner()
  noise(userId, 300)
  db.prepare('UPDATE memories SET body=body WHERE user_id=?').run(userId)
  const before = db.prepare('SELECT COUNT(*) AS total FROM memories WHERE user_id=?').get(userId).total
  const result = dispatchMemoryTool('remember', { type: 'project', title: 'New fact', body: 'Do not duplicate.' }, { userId })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MEMORY_SEARCH_INDEX_INCOMPLETE')
  assert.equal(result.retryable, true)
  assert.equal(Object.hasOwn(result, 'diagnostics'), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM memories WHERE user_id=?').get(userId).total, before)
  assert.ok(db.prepare('SELECT COUNT(*) AS total FROM memory_search_index WHERE user_id=?').get(userId).total > 0)
})

function concurrentRememberWorker(t, userId) {
  const source = `
    import { dispatchMemoryTool } from './server/utils/memoryTools.js';
    import { closeDb } from './server/db.js';
    process.once('message', () => {
      const result = dispatchMemoryTool('remember', {type:'project',title:'Concurrent fact',body:'One canonical fact.'}, {userId:process.env.MEMORY_FIXTURE_OWNER});
      closeDb();
      process.send({type:'result',result}, () => process.disconnect());
    });
    process.send({type:'ready'});
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: process.cwd(), env: { ...process.env, APP_DATA_DIR: dataDir, APP_DB_PATH: path.join(dataDir, 'app.db'), MEMORY_FIXTURE_OWNER: userId },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  t.after(() => { if (child.exitCode == null) child.kill() })
  let stderr = ''
  child.stderr.on('data', (value) => { stderr = (stderr + value).slice(-2000) })
  const event = (kind) => new Promise((resolve, reject) => {
    child.on('message', (message) => { if (message.type === kind) resolve(message.result) })
    child.once('error', reject)
    child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr || `fixture exited ${code}`)) })
  })
  return { child, ready: event('ready'), result: event('result') }
}

test('two processes remembering the same new key converge on one memory', { timeout: 20_000 }, async (t) => {
  const userId = owner()
  const workers = [concurrentRememberWorker(t, userId), concurrentRememberWorker(t, userId)]
  await Promise.all(workers.map((worker) => worker.ready))
  for (const worker of workers) worker.child.send({ type: 'go' })
  const results = await Promise.all(workers.map((worker) => worker.result))
  assert.ok(results.every((result) => result.ok === true), JSON.stringify(results))
  assert.equal(results[0].id, results[1].id)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM memories WHERE user_id=?').get(userId).total, 1)
})
