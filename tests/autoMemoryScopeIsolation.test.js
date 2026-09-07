import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-scope-'))
process.env.APP_DATA_DIR = dataDir
const { getDb } = await import('../server/db.js')
const { createAgent } = await import('../server/services/agentStore.js')
const { dispatchMemoryTool } = await import('../server/utils/memoryTools.js')
const { extractAndStoreAutoMemories } = await import('../server/services/autoMemoryService.js')
const { buildMemoryIndex, findBySlug, getMemory, listMemories, traverseMemoryLinks, upsertMemory } = await import('../server/services/memoryStore.js')
const db = getDb()
let fixtureId = 0

function scope() {
  const userId = `memory-scope-user-${++fixtureId}`
  const now = Date.now()
  db.prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
    .run(userId, `${userId}@example.com`, now, now)
  const makeAgent = (name) => createAgent({ userId, name, soulMd: 'Local fixture', identityMd: name, isDefault: false })
  return { userId, first: makeAgent('First'), second: makeAgent('Second') }
}

function remember({ userId, agentId = null, title = 'Project convention', body, sessionId = 'session-first' }) {
  return extractAndStoreAutoMemories({
    userId, agentId, sessionId,
    messages: [{ id: `${sessionId}:user`, role: 'user', content: 'Remember this durable project convention for future tasks.' }],
    assistantText: 'Understood.',
    callModel: async () => ({ content: JSON.stringify({ memories: [
      { type: 'project', title, body, confidence: 0.95 },
    ] }) }),
  })
}

test('automatic memories with the same title remain isolated between agents', async () => {
  const { userId, first, second } = scope()
  const one = await remember({ userId, agentId: first.id, body: 'First project uses TypeScript.' })
  const two = await remember({ userId, agentId: second.id, body: 'Second project uses Python.' })
  assert.notEqual(one.stored[0].id, two.stored[0].id)
  assert.equal(getMemory(userId, one.stored[0].id).agentId, first.id)
  assert.equal(getMemory(userId, one.stored[0].id).body, 'First project uses TypeScript.')
  assert.equal(listMemories({ userId, agentFilter: first.id }).length, 1)
  assert.equal(listMemories({ userId, agentFilter: second.id }).length, 1)
})

test('agent extraction cannot move or replace global automatic memories', async () => {
  const { userId, first } = scope()
  const global = await remember({ userId, body: 'Global examples prefer short explanations.' })
  const scoped = await remember({ userId, agentId: first.id, body: 'This project needs detailed explanations.' })
  assert.notEqual(global.stored[0].id, scoped.stored[0].id)
  assert.equal(getMemory(userId, global.stored[0].id).agentId, null)
  assert.equal(listMemories({ userId, agentFilter: '__global__' }).length, 1)
})

test('unrelated agent manual memories do not suppress another agent extraction', async () => {
  const { userId, first, second } = scope()
  const manual = upsertMemory({ userId, agentId: first.id, type: 'project', title: 'Project convention', body: 'First manual convention.' })
  const result = await remember({ userId, agentId: second.id, body: 'Second automatic convention.' })
  assert.equal(result.stored.length, 1)
  assert.equal(result.stored[0].agentId, second.id)
  assert.equal(getMemory(userId, manual.id).body, 'First manual convention.')
})

test('global and same-agent manual instructions retain priority over automatic extraction', async () => {
  const { userId, first } = scope()
  upsertMemory({ userId, type: 'project', title: 'Global convention', body: 'Explicit global convention.' })
  upsertMemory({ userId, agentId: first.id, type: 'project', title: 'Project convention', body: 'Explicit local convention.' })
  const global = await remember({ userId, agentId: first.id, title: 'Global convention', body: 'Do not replace explicit global guidance.' })
  const scoped = await remember({ userId, agentId: first.id, body: 'Do not replace explicit local guidance.' })
  assert.equal(global.stored.length, 0)
  assert.equal(scoped.stored.length, 0)
})

test('same-scope automatic updates retain identity and refresh their source attribution', async () => {
  const { userId, first } = scope()
  const original = await remember({ userId, agentId: first.id, body: 'Use JavaScript.' })
  const changed = await remember({ userId, agentId: first.id, body: 'Use TypeScript.', sessionId: 'session-changed' })
  assert.equal(changed.stored[0].id, original.stored[0].id)
  assert.equal(changed.stored[0].sourceSessionId, 'session-changed')
  assert.equal(changed.stored[0].sourceMessageId, 'session-changed:user')
})

test('failed link replacement rolls back the entire memory update', () => {
  const { userId } = scope()
  const original = upsertMemory({ userId, type: 'project', title: 'Atomic memory', body: 'Keep [[safe-link]].' })
  db.exec("CREATE TRIGGER fail_memory_link_insert BEFORE INSERT ON memory_links WHEN NEW.to_slug = 'reject-link' BEGIN SELECT RAISE(ABORT, 'fixture rejected link'); END")
  try {
    assert.throws(() => upsertMemory({ userId, id: original.id, type: 'project', title: 'Atomic memory', body: 'Replace with [[reject-link]].' }), /fixture rejected link/)
    assert.equal(getMemory(userId, original.id).body, original.body)
    assert.deepEqual(db.prepare('SELECT to_slug FROM memory_links WHERE from_id = ?').all(original.id), [{ to_slug: 'safe-link' }])
  } finally { db.exec('DROP TRIGGER fail_memory_link_insert') }
})

test('Chinese memory names have distinct canonical links that resolve to the intended memory', () => {
  const { userId } = scope()
  const first = upsertMemory({ userId, type: 'project', title: '项目规范', body: 'Keep the current coding conventions.' })
  const second = upsertMemory({ userId, type: 'project', title: '交付要求', body: 'Verify all requested deliverables.' })
  assert.notEqual(first.slug, second.slug)
  assert.equal(findBySlug(userId, first.slug).id, first.id)
  assert.equal(findBySlug(userId, second.slug).id, second.id)
  const source = upsertMemory({ userId, type: 'reference', title: 'Project links', body: `Read [[${first.slug}]] and [[${second.slug}]].` })
  const graph = traverseMemoryLinks({ userId, seedIds: [source.id], direction: 'outgoing' })
  assert.deepEqual(new Set(graph.memories.map((memory) => memory.id)), new Set([first.id, second.id, source.id]))
  assert.equal(graph.links.length, 2)
  assert.ok(buildMemoryIndex(userId).includes(`[[${first.slug}]]`))
})

test('duplicate titles receive distinct links and renaming preserves existing inbound links', () => {
  const { userId } = scope()
  const first = upsertMemory({ userId, type: 'project', title: 'Project conventions', body: 'Original.' })
  const second = upsertMemory({ userId, type: 'reference', title: 'Project conventions', body: 'Different reference.' })
  assert.notEqual(first.slug, second.slug)
  const source = upsertMemory({ userId, type: 'reference', title: 'Link source', body: `Read [[${first.slug}]].` })
  const changed = upsertMemory({ userId, id: first.id, type: 'project', title: 'Renamed conventions', body: 'Updated.' })
  assert.equal(changed.slug, first.slug)
  assert.equal(findBySlug(userId, first.slug).id, first.id)
  assert.equal(findBySlug(userId, second.slug).id, second.id)
  assert.equal(traverseMemoryLinks({ userId, seedIds: [source.id], direction: 'outgoing' }).links[0]?.toId, first.id)
})

test('raw provider credentials are neither sent for extraction nor accepted as candidate memories', async () => {
  const { userId } = scope()
  for (const prefix of ['ghp_', 'github_pat_', 'glpat-', 'xoxb-']) {
    const fakeCredential = prefix + 'x'.repeat(36)
    const skipped = await extractAndStoreAutoMemories({
      userId, messages: [{ role: 'user', content: `For the connection use ${fakeCredential}` }],
      assistantText: 'Understood.',
      callModel: async () => assert.fail('Credential-bearing content must not be resent for extraction'),
    })
    assert.equal(skipped.attempted, false)
    const rejected = await remember({ userId, body: `Connection credential: ${fakeCredential}` })
    assert.equal(rejected.stored.length, 0)
  }
})

test('the explicit remember tool uses host scope and type instead of moving another agent memory', () => {
  const { userId, first } = scope()
  const owned = upsertMemory({ userId, agentId: first.id, type: 'project', title: 'Project convention', body: 'Private agent convention.' })
  const global = dispatchMemoryTool('remember', { type: 'project', title: 'Project convention', body: 'Global convention.' }, { userId })
  assert.equal(global.ok, true)
  assert.notEqual(global.id, owned.id)
  assert.equal(getMemory(userId, owned.id).agentId, first.id)
  const scoped = dispatchMemoryTool('remember', { type: 'project', title: 'Project convention', body: 'Updated agent convention.' }, { userId, agentId: first.id, sessionId: 'manual-session' })
  assert.equal(scoped.id, owned.id)
  assert.equal(getMemory(userId, owned.id).sourceSessionId, 'manual-session')
  const preference = dispatchMemoryTool('remember', { type: 'user', title: 'Project convention', body: 'A distinct preference.' }, { userId, agentId: first.id })
  assert.notEqual(preference.id, owned.id)
  assert.equal(getMemory(userId, owned.id).type, 'project')
})

test('new session attribution never retains a message from the previous session', () => {
  const { userId } = scope()
  const original = upsertMemory({ userId, type: 'project', title: 'Attribution', body: 'Old fact.', sourceSessionId: 'old-session', sourceMessageId: 'old-session:user' })
  const result = dispatchMemoryTool('remember', { type: 'project', title: 'Attribution', body: 'New fact.' }, { userId, sessionId: 'new-session' })
  const changed = getMemory(userId, result.id)
  assert.equal(changed.id, original.id)
  assert.equal(changed.sourceSessionId, 'new-session')
  assert.equal(changed.sourceMessageId, null)
  const renamed = upsertMemory({ userId, id: original.id, type: 'project', title: 'Renamed attribution', body: 'New fact.' })
  assert.equal(renamed.sourceSessionId, 'new-session')
  assert.equal(renamed.sourceMessageId, null)
})

test('partial source updates clear the unknown half instead of borrowing old provenance', () => {
  const { userId } = scope()
  const original = upsertMemory({ userId, type: 'project', title: 'Source pair', body: 'Old fact.', sourceSessionId: 'same-session', sourceMessageId: 'old-message' })
  const sameSession = upsertMemory({ userId, id: original.id, type: 'project', title: 'Source pair', body: 'New fact.', sourceSessionId: 'same-session' })
  assert.equal(sameSession.sourceMessageId, null)
  const messageOnly = upsertMemory({ userId, id: original.id, type: 'project', title: 'Source pair', body: 'Another fact.', sourceMessageId: 'new-message' })
  assert.equal(messageOnly.sourceSessionId, null)
  assert.equal(messageOnly.sourceMessageId, 'new-message')
})

test('same-batch automatic deduplication sees the fact updated earlier in that batch', async () => {
  const { userId } = scope()
  await remember({ userId, title: 'Answer language', body: 'Use English.' })
  await extractAndStoreAutoMemories({
    userId, messages: [{ role: 'user', content: 'Use Chinese for all future replies in this project.' }],
    assistantText: 'Understood.',
    callModel: async () => ({ content: JSON.stringify({ memories: [
      { type: 'project', title: 'Answer language', body: 'Use Chinese.', confidence: 0.95 },
      { type: 'project', title: 'Default reply language', body: 'Use Chinese.', confidence: 0.95 },
    ] }) }),
  })
  assert.equal(listMemories({ userId }).length, 1)
})

test('canonically equivalent Unicode wikilinks resolve without changing the stored body', () => {
  const { userId } = scope()
  const target = upsertMemory({ userId, type: 'reference', title: 'Café reference', body: 'A stable reference.' })
  const body = `Read [[${target.slug.normalize('NFD')}]].`
  const source = upsertMemory({ userId, type: 'reference', title: 'Unicode links', body })
  assert.equal(source.body, body)
  assert.equal(traverseMemoryLinks({ userId, seedIds: [source.id], direction: 'outgoing' }).links[0]?.toId, target.id)
})

test('candidate secrets are rejected before truncation can hide their recognizable prefix', async () => {
  const { userId } = scope()
  const body = 'a'.repeat(3990) + '\n' + 'ghp_' + 'x'.repeat(36)
  const result = await remember({ userId, body })
  assert.equal(result.stored.length, 0)
  assert.equal(listMemories({ userId }).length, 0)
})
