import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-lexical-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
const { getDb, closeDb } = await import('../server/db.js')
const { createAgent } = await import('../server/services/agentStore.js')
const { getMemory, listMemories, selectActiveMemoriesForInjection, upsertMemory } = await import('../server/services/memoryStore.js')
const db = getDb()
let sequence = 0

after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function owner() {
  const id = `lexical-owner-${++sequence}`
  db.prepare('INSERT INTO users(id,email,created_at,updated_at) VALUES(?,?,?,?)')
    .run(id, `${id}@example.com`, 1, 1)
  return id
}

function remember(userId, title, body = 'A durable reference.', options = {}) {
  return upsertMemory({ userId, type: 'project', title, body, ...options })
}

function noise(userId, count, options = {}) {
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      remember(userId, `Recent notes ${index}`, 'An incidental alpha mention.', options)
    }
  })()
}

test('lexical recall ranks the whole bounded history before limiting to 240 candidates', () => {
  const userId = owner()
  const target = remember(userId, 'Alpha guidelines', 'Use the documented deployment procedure.')
  db.prepare('UPDATE memories SET updated_at = 1 WHERE id = ?').run(target.id)
  noise(userId, 260)
  const result = selectActiveMemoriesForInjection({ userId, query: 'alpha', deferFitting: true })
  assert.equal(result.memories[0]?.id, target.id)
  assert.equal(result.memories.length, 240)
  assert.equal(result.diagnostics.lexical.coverage, 'complete')
  assert.equal(result.diagnostics.lexical.matched, 261)
  assert.equal(result.diagnostics.lexical.candidateTruncated, true)
  assert.equal(result.diagnostics.tokenTruncated, false)
})

test('old exact title remains reachable beyond the bounded general scan', () => {
  const userId = owner()
  noise(userId, 20)
  const target = remember(userId, 'alpha')
  const result = selectActiveMemoriesForInjection({
    userId, query: 'alpha', deferFitting: true,
    lexicalLimits: { maxScanned: 2, maxDurationMs: 1000 },
  })
  assert.equal(result.memories[0]?.id, target.id)
  assert.equal(result.diagnostics.lexical.coverage, 'partial')
  assert.equal(result.diagnostics.lexical.code, 'MEMORY_LEXICAL_SCAN_LIMIT')
  assert.ok(result.diagnostics.lexical.nextCursor)
})

test('lexical normalization agrees with ranking after a title change preserves its old slug', () => {
  for (const [title, query] of [['Ｆｏｏ', 'foo'], ['ÉQUIPE', 'équipe'], ['Cafe\u0301', 'café']]) {
    const userId = owner()
    const initial = remember(userId, 'Original identity')
    const target = remember(userId, title, 'No query word here.', { id: initial.id })
    assert.equal(target.slug, initial.slug)
    const result = selectActiveMemoriesForInjection({ userId, query, deferFitting: true })
    assert.deepEqual(result.memories.map((memory) => memory.id), [target.id])
    assert.deepEqual(listMemories({ userId, query }).map((memory) => memory.id), [target.id])
    assert.equal(getMemory(userId, target.id).title, title)
  }
})

test('pinned recall cannot consume the independent lexical candidate budget', () => {
  const userId = owner()
  const target = remember(userId, 'alpha')
  db.transaction(() => {
    for (let index = 0; index < 245; index += 1) {
      remember(userId, `Preference ${index}`, 'Prefer concise answers.', { pinned: true })
    }
  })()
  const result = selectActiveMemoriesForInjection({ userId, query: 'alpha', deferFitting: true })
  assert.ok(result.memories.some((memory) => memory.id === target.id))
  assert.ok(result.memories[0].pinned)
})

test('normalized title, body and tags respect owner and agent visibility', () => {
  const userId = owner()
  const other = owner()
  const agent = createAgent({ userId, name: 'Visible agent' })
  const hidden = createAgent({ userId, name: 'Hidden agent' })
  const global = remember(userId, 'Old title', 'ＦＯＯ rollback notes.')
  const local = remember(userId, 'Agent notes', 'Other content.', {
    agentId: agent.id, frontmatter: { tags: ['Ｆｏｏ'] },
  })
  remember(userId, 'Ｆｏｏ hidden', 'Secret.', { agentId: hidden.id })
  remember(other, 'Ｆｏｏ other owner', 'Secret.')
  const read = (agentId) => selectActiveMemoriesForInjection({ userId, agentId, query: 'foo', deferFitting: true }).memories.map((m) => m.id).sort()
  assert.deepEqual(read(null), [global.id])
  assert.deepEqual(read(agent.id), [global.id, local.id].sort())
  assert.deepEqual(selectActiveMemoriesForInjection({ userId: "' OR 1=1 --", query: 'foo' }).memories, [])
})

test('candidate scan cancellation is reported instead of returning complete recall', () => {
  const userId = owner()
  noise(userId, 4)
  const controller = new AbortController()
  controller.abort()
  const result = selectActiveMemoriesForInjection({ userId, query: 'alpha', signal: controller.signal })
  assert.deepEqual(result.memories, [])
  assert.equal(result.diagnostics.cancelled, true)
})
