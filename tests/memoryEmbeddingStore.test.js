import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeDb, getDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import {
  selectActiveMemoriesForInjection,
  deleteMemory,
  upsertMemory,
} from '../server/services/memoryStore.js'
import {
  getMemoryEmbeddings,
  listMemoriesNeedingEmbedding,
  scanMemoriesNeedingEmbedding,
  searchMemoryEmbeddings,
  setMemoryEmbedding,
} from '../server/services/memoryEmbeddingStore.js'
import { indexMemoryEmbeddings } from '../server/services/memoryEmbeddingIndexer.js'
import {
  memoryContentFingerprint,
  memoryEmbeddingSpaceId,
} from '../server/services/memoryEmbeddingService.js'

// One isolated database for this file. The runner gives each test file its own
// process, so the module-level APP_DATA_DIR binds before the first getDb().
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memembed-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'memembed@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id

const QUERY = 'how do I deploy the service'
const EMBED_ENV = Object.freeze({
  MEMORY_EMBEDDINGS_ENABLED: '1',
  MEMORY_EMBEDDING_MODEL: 'embed-test',
  MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
})
// A vector is only comparable inside the space it was produced in.
const EMBED_SPACE = memoryEmbeddingSpaceId({
  baseUrl: EMBED_ENV.MEMORY_EMBEDDING_BASE_URL,
  model: EMBED_ENV.MEMORY_EMBEDDING_MODEL,
})

test('semantic recall blends stored vectors into injection ranking', () => {
  const lexical = upsertMemory({
    userId, type: 'project', title: 'Deploy notes', body: 'deploy the service with docker',
  })
  const semanticOnly = upsertMemory({
    userId, type: 'user', title: 'Ops preference', body: 'blue-green release ritual',
  })
  setMemoryEmbedding({
    userId,
    memoryId: semanticOnly.id,
    model: 'embed-test',
    embeddingSpace: EMBED_SPACE,
    vector: [0.98, 0.02, 0],
    contentFingerprint: memoryContentFingerprint(semanticOnly),
  })

  const picked = selectActiveMemoriesForInjection({ userId, query: QUERY, queryVector: [1, 0, 0], querySpace: EMBED_SPACE })
  const ids = picked.memories.map((memory) => memory.id)
  assert.ok(ids.includes(semanticOnly.id), 'semantic-only memory must be recalled')
  assert.ok(ids.includes(lexical.id), 'lexical match must still be recalled')

  // Without a query vector the semantic-only memory is not recalled.
  const lexicalOnly = selectActiveMemoriesForInjection({ userId, query: QUERY })
  assert.deepEqual(lexicalOnly.memories.map((memory) => memory.id), [lexical.id])

  // A stale vector (edited body) is ignored by retrieval.
  upsertMemory({ userId, id: semanticOnly.id, type: 'user', title: 'Ops preference', body: 'changed ritual' })
  const stale = selectActiveMemoriesForInjection({ userId, query: QUERY, queryVector: [1, 0, 0], querySpace: EMBED_SPACE })
  assert.equal(stale.memories.some((memory) => memory.id === semanticOnly.id), false)
})

test('the indexer embeds pending memories once and reindexes stale content', async () => {
  const userId = isolatedUser('index-once')
  const memory = upsertMemory({ userId, type: 'user', title: 'Index note', body: 'index me' })
  const embedded = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    embedded.push(...body.input)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1] })) }),
    }
  }

  const first = await indexMemoryEmbeddings({ userId, env: EMBED_ENV, fetchImpl })
  assert.ok(first.indexed >= 1)
  assert.ok(embedded.includes('index me\n\nindex me') || embedded.some((text) => text.includes('index me')))

  const stored = getMemoryEmbeddings({ userId, memoryIds: [memory.id] })
  assert.equal(stored.size, 1)
  assert.equal(stored.get(memory.id).dimensions, 2)
  assert.deepEqual(stored.get(memory.id).vector, [1, 1])

  // Editing the body invalidates the fingerprint and re-queues it.
  upsertMemory({ userId, id: memory.id, type: 'user', title: 'Index note', body: 'index me again' })
  const pending = listMemoriesNeedingEmbedding({ userId, model: 'embed-test', limit: 64 })
  assert.ok(pending.some((entry) => entry.id === memory.id))
})

test('the indexer is a no-op while embeddings are disabled', async () => {
  let called = false
  const result = await indexMemoryEmbeddings({
    userId,
    env: {},
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } },
  })
  assert.deepEqual(result, { indexed: 0, skipped: true })
  assert.equal(called, false)
})

test('a backlog larger than one batch is not starved by the page limit', () => {
  // Regression: the staleness predicate runs in JS, so a SQL LIMIT applied
  // before it let a backlog bigger than the batch starve forever.
  const backlog = []
  for (let index = 0; index < 6; index += 1) {
    backlog.push(upsertMemory({
      userId, type: 'project', title: `backlog-${index}`, body: `backlog body ${index}`,
    }))
  }
  const firstBatch = listMemoriesNeedingEmbedding({ userId, model: 'embed-test', limit: 2 })
  assert.equal(firstBatch.length, 2)
  for (const memory of firstBatch) {
    setMemoryEmbedding({
      userId, memoryId: memory.id, model: 'embed-test', vector: [1, 0],
      contentFingerprint: memoryContentFingerprint(memory),
    })
  }
  const secondBatch = listMemoriesNeedingEmbedding({ userId, model: 'embed-test', limit: 2 })
  assert.equal(secondBatch.length, 2, 'the next batch must not re-read only the already-embedded head')
  assert.ok(
    secondBatch.every((memory) => !firstBatch.some((done) => done.id === memory.id)),
    'the second batch must be different memories',
  )
})

test('the scan cursor guarantees progress past rows that no longer need work', () => {
  const created = []
  for (let index = 0; index < 5; index += 1) {
    created.push(upsertMemory({
      userId, type: 'project', title: `cursor-${index}`, body: `cursor body ${index}`,
    }))
  }
  const wanted = new Set(created.map((memory) => memory.id))
  const seen = new Set()
  let cursor = null
  for (let round = 0; round < 20 && ![...wanted].every((id) => seen.has(id)); round += 1) {
    const page = scanMemoriesNeedingEmbedding({ userId, model: 'embed-test', limit: 1, cursor })
    for (const memory of page.memories) {
      seen.add(memory.id)
      // Mirror what the indexer does: once embedded, the row stops being stale.
      setMemoryEmbedding({
        userId, memoryId: memory.id, model: 'embed-test', vector: [1, 0],
        embeddingSpace: EMBED_SPACE,
        contentFingerprint: memoryContentFingerprint(memory),
      })
    }
    cursor = page.reachedEnd ? null : page.nextCursor
    if (!cursor && page.memories.length === 0) break
  }
  for (const id of wanted) {
    assert.ok(seen.has(id), 'every stale memory must be reachable through the cursor')
  }
})

test('enabling semantic recall does not lose an exact lexical hit far back in history', () => {
  // Reported: 1 target memory plus 241 newer unrelated ones. Without a vector
  // the target was found; with a vector it disappeared, because the semantic
  // path took only the most recent 240 and the lexical predicate was dropped.
  const target = upsertMemory({
    userId, type: 'project', title: 'Zebra deployment runbook',
    body: 'the zebra procedure is the only documented way to release',
  })
  for (let index = 0; index < 245; index += 1) {
    upsertMemory({
      userId, type: 'project', title: `noise-${index}`,
      body: `unrelated filler note number ${index} about nothing in particular`,
    })
  }
  const lexicalOnly = selectActiveMemoriesForInjection({ userId, query: 'zebra' })
  assert.ok(lexicalOnly.memories.some((memory) => memory.id === target.id),
    'lexical recall finds the target')

  const hybrid = selectActiveMemoriesForInjection({
    userId, query: 'zebra', queryVector: [1, 0], querySpace: EMBED_SPACE,
  })
  assert.ok(hybrid.memories.some((memory) => memory.id === target.id),
    'adding a query vector must not drop the exact lexical hit')
})

test('a vector from another embedding space is never compared', () => {
  const memory = upsertMemory({
    userId, type: 'user', title: 'Ops preference', body: 'blue-green release ritual',
  })
  const otherSpace = memoryEmbeddingSpaceId({ baseUrl: 'http://127.0.0.1:9/v1', model: 'other-model' })
  assert.notEqual(otherSpace, EMBED_SPACE)
  setMemoryEmbedding({
    userId, memoryId: memory.id, model: 'embed-test', vector: [1, 0],
    contentFingerprint: memoryContentFingerprint(memory),
    // Same width, different model: the vector looks usable but is not.
    embeddingSpace: otherSpace,
  })

  const mismatched = selectActiveMemoriesForInjection({
    userId, query: 'completely unrelated wording', queryVector: [1, 0], querySpace: EMBED_SPACE,
  })
  assert.equal(mismatched.memories.some((entry) => entry.id === memory.id), false,
    'a different space must not produce a similarity score')

  // With the space it was written in, the same vector is used.
  const matched = selectActiveMemoriesForInjection({
    userId, query: 'completely unrelated wording', queryVector: [1, 0], querySpace: otherSpace,
  })
  assert.ok(matched.memories.some((entry) => entry.id === memory.id))
})

test('a query vector without a reported space falls back to lexical recall', () => {
  const memory = upsertMemory({
    userId, type: 'user', title: 'Ops preference', body: 'blue-green release ritual',
  })
  setMemoryEmbedding({
    userId, memoryId: memory.id, model: 'embed-test', vector: [1, 0],
    contentFingerprint: memoryContentFingerprint(memory), embeddingSpace: EMBED_SPACE,
  })
  const picked = selectActiveMemoriesForInjection({
    userId, query: 'nothing matches this text', queryVector: [1, 0],
  })
  assert.equal(picked.memories.some((entry) => entry.id === memory.id), false)
})

test('a vector written in another space is queued for rebuild', () => {
  const userId = isolatedUser('space-rebuild')
  const memory = upsertMemory({
    userId, type: 'project', title: 'Rebuild me', body: 'needs a fresh vector after a model switch',
  })
  setMemoryEmbedding({
    userId, memoryId: memory.id, model: 'embed-test', vector: [1, 0],
    contentFingerprint: memoryContentFingerprint(memory),
    embeddingSpace: memoryEmbeddingSpaceId({ baseUrl: 'http://127.0.0.1:9/v1', model: 'old-model' }),
  })
  const pending = scanMemoriesNeedingEmbedding({
    userId, model: 'embed-test', space: EMBED_SPACE, limit: 50,
  })
  assert.ok(pending.memories.some((entry) => entry.id === memory.id),
    'a same-model vector from another space must be re-embedded')
})

test('agent-scoped memories are reachable only when the scope asks for them', async () => {
  const userId = isolatedUser('index-agent-scope')
  const { ensureDefaultAgent } = await import('../server/services/agentStore.js')
  const agentId = ensureDefaultAgent({ userId }).id
  const agentMemory = upsertMemory({
    userId, agentId, type: 'project', title: 'Agent scoped',
    body: 'only this persona should index me',
  })
  const globalOnly = scanMemoriesNeedingEmbedding({ userId, model: 'embed-test', space: EMBED_SPACE, limit: 200 })
  assert.equal(globalOnly.memories.some((entry) => entry.id === agentMemory.id), false,
    'the default global scope must not claim to cover agent memories')

  const allAgents = scanMemoriesNeedingEmbedding({
    userId, model: 'embed-test', space: EMBED_SPACE, includeAllAgents: true, limit: 200,
  })
  assert.ok(allAgents.memories.some((entry) => entry.id === agentMemory.id),
    'the all-agents scope reaches it')

  const oneAgent = scanMemoriesNeedingEmbedding({
    userId, agentId, model: 'embed-test', space: EMBED_SPACE, limit: 200,
  })
  assert.ok(oneAgent.memories.some((entry) => entry.id === agentMemory.id))
})

function isolatedUser(label) {
  const issued = issueEmailCode({ email: `${label}@example.com` })
  return verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
}

function storeVector(memory, vector = [1, 0], embeddingSpace = EMBED_SPACE) {
  return setMemoryEmbedding({
    userId: memory.userId, memoryId: memory.id, model: 'embed-test', vector,
    contentFingerprint: memoryContentFingerprint(memory), embeddingSpace,
  })
}

test('semantic recall reaches an old synonym beyond 400 newer unrelated vectors', () => {
  const owner = isolatedUser('semantic-history')
  let target
  getDb().transaction(() => {
    target = upsertMemory({
      userId: owner, type: 'reference', title: 'Orion', body: 'blue-green release ritual',
    })
    storeVector(target)
    getDb().prepare('UPDATE memories SET updated_at = ? WHERE user_id = ? AND id = ?')
      .run(1, owner, target.id)
    for (let index = 0; index < 425; index += 1) {
      storeVector(upsertMemory({
        userId: owner, type: 'reference', title: `Noise ${index}`, body: `gardening ${index}`,
      }), [0, 1])
    }
  })()
  const picked = selectActiveMemoriesForInjection({
    userId: owner, query: 'deployment procedure', queryVector: [1, 0], querySpace: EMBED_SPACE,
  })
  assert.deepEqual(picked.memories.map((memory) => memory.id), [target.id])
})

test('an indexing cursor never consumes the first unprocessed row or ends a partial page', () => {
  const owner = isolatedUser('cursor-exact')
  const expected = Array.from({ length: 5 }, (_, index) => upsertMemory({
    userId: owner, type: 'reference', title: `Cursor ${index}`, body: `body ${index}`,
  }).id)
  let cursor = null
  const seen = []
  for (let index = 0; index < expected.length; index += 1) {
    const page = scanMemoriesNeedingEmbedding({ userId: owner, space: EMBED_SPACE, limit: 1, cursor })
    assert.equal(page.memories.length, 1)
    seen.push(page.memories[0].id)
    assert.equal(page.reachedEnd, index === expected.length - 1)
    storeVector(page.memories[0])
    cursor = page.nextCursor
  }
  assert.deepEqual([...seen].sort(), [...expected].sort())
})

test('embedding writes cannot take ownership of another user memory', () => {
  const owner = isolatedUser('vector-owner')
  const other = isolatedUser('vector-other')
  const memory = upsertMemory({ userId: owner, type: 'user', title: 'Private', body: 'owner only' })
  storeVector(memory)
  assert.equal(setMemoryEmbedding({
    userId: other, memoryId: memory.id, model: 'embed-test', vector: [0, 1],
    contentFingerprint: memoryContentFingerprint(memory), embeddingSpace: EMBED_SPACE,
  }), false)
  assert.deepEqual(getMemoryEmbeddings({ userId: owner, memoryIds: [memory.id] }).get(memory.id).vector, [1, 0])
  assert.equal(getMemoryEmbeddings({ userId: other, memoryIds: [memory.id] }).size, 0)
})

test('late embedding writes reject deleted or edited inputs instead of resurrecting stale vectors', () => {
  const owner = isolatedUser('vector-race')
  const memory = upsertMemory({ userId: owner, type: 'user', title: 'Race', body: 'original' })
  const write = () => storeVector(memory)
  upsertMemory({ userId: owner, id: memory.id, type: 'user', title: 'Race', body: 'edited' })
  assert.equal(write(), false)
  deleteMemory(owner, memory.id)
  assert.equal(write(), false)
  assert.equal(getMemoryEmbeddings({ userId: owner, memoryIds: [memory.id] }).size, 0)
})

function search(owner, overrides = {}) {
  return searchMemoryEmbeddings({
    userId: owner, queryVector: [1, 0], querySpace: EMBED_SPACE, ...overrides,
  })
}

test('semantic top-k spans pages and returns honest partial coverage and a continuation cursor', () => {
  const owner = isolatedUser('semantic-pages')
  const memories = Array.from({ length: 7 }, (_, index) => {
    const memory = upsertMemory({ userId: owner, type: 'reference', title: `Vector ${index}`, body: 'synonym' })
    storeVector(memory, [index + 1, 7 - index])
    return memory
  })
  const full = search(owner, { limits: { pageSize: 2, topK: 2, maxDurationMs: 1000 } })
  assert.deepEqual(full.memories.map((memory) => memory.id), [memories[6].id, memories[5].id])
  assert.equal(full.diagnostics.scanned, 7)
  assert.equal(full.diagnostics.coverage, 'complete')
  assert.equal(full.diagnostics.truncated, false)
  assert.equal(full.diagnostics.nextCursor, null)

  const first = search(owner, { limits: { pageSize: 2, topK: 2, maxScanned: 3, maxDurationMs: 1000 } })
  assert.equal(first.diagnostics.scanned, 3)
  assert.equal(first.diagnostics.coverage, 'partial')
  assert.equal(first.diagnostics.code, 'MEMORY_SEMANTIC_SCAN_LIMIT')
  assert.ok(first.diagnostics.nextCursor)
  const rest = search(owner, { cursor: first.diagnostics.nextCursor, limits: { topK: 2, maxDurationMs: 1000 } })
  assert.equal(rest.diagnostics.scanned, 4)
  assert.equal(rest.diagnostics.rangeComplete, true)
  assert.equal(rest.diagnostics.coverage, 'partial', 'a continuation alone is not full-history top-k')
  assert.deepEqual(rest.memories.map((memory) => memory.id), full.memories.map((memory) => memory.id))
  const wrongQuery = search(owner, { cursor: first.diagnostics.nextCursor, queryVector: [0, 1] })
  assert.equal(wrongQuery.diagnostics.code, 'MEMORY_SEMANTIC_CURSOR_MISMATCH')
  assert.equal(wrongQuery.diagnostics.scanned, 0)
})

test('semantic scan respects vector work, cancellation and elapsed-time budgets', () => {
  const owner = isolatedUser('semantic-budgets')
  const memory = upsertMemory({ userId: owner, type: 'reference', title: 'Exact fallback', body: 'deploy' })
  storeVector(memory)
  const vectorLimited = selectActiveMemoriesForInjection({
    userId: owner, query: 'Exact fallback', queryVector: [1, 0], querySpace: EMBED_SPACE,
    semanticLimits: { maxVectorElements: 1 },
  })
  assert.deepEqual(vectorLimited.memories.map((entry) => entry.id), [memory.id], 'lexical path survives scan truncation')
  assert.equal(vectorLimited.diagnostics.semantic.code, 'MEMORY_SEMANTIC_VECTOR_LIMIT')
  assert.equal(vectorLimited.diagnostics.semantic.scanned, 0)

  const controller = new AbortController()
  controller.abort()
  const cancelled = search(owner, { signal: controller.signal })
  assert.equal(cancelled.diagnostics.code, 'MEMORY_SEMANTIC_ABORTED')
  assert.equal(cancelled.diagnostics.scanned, 0)
  let ticks = 0
  const timed = searchMemoryEmbeddings({
    userId: owner, queryVector: [1, 0], querySpace: EMBED_SPACE, limits: { maxDurationMs: 1 },
  }, { now: () => ticks++ })
  assert.equal(timed.diagnostics.code, 'MEMORY_SEMANTIC_TIME_LIMIT')
  assert.equal(timed.diagnostics.scanned, 0)
})

test('semantic search excludes wrong widths, unknown spaces, changed content and deleted vectors', () => {
  const owner = isolatedUser('semantic-invalid')
  const create = (title) => upsertMemory({ userId: owner, type: 'reference', title, body: 'unrelated text' })
  const wrongWidth = create('Wide')
  storeVector(wrongWidth, [1, 0, 0])
  const unknown = create('Unknown')
  storeVector(unknown, [1, 0], 'unknown')
  const stale = create('Stale')
  storeVector(stale)
  upsertMemory({ userId: owner, id: stale.id, type: 'reference', title: 'Stale', body: 'edited input' })
  const gone = create('Deleted')
  storeVector(gone)
  deleteMemory(owner, gone.id)
  const corrupt = create('Corrupt')
  storeVector(corrupt)
  const badVector = Buffer.alloc(8)
  badVector.writeFloatLE(Number.NaN, 0)
  getDb().prepare('UPDATE memory_embeddings SET vector = ? WHERE user_id = ? AND memory_id = ?')
    .run(badVector, owner, corrupt.id)
  const result = search(owner)
  assert.deepEqual(result.memories, [])
  assert.equal(result.diagnostics.stale, 1)
  assert.equal(result.diagnostics.invalid, 1)
  assert.equal(result.diagnostics.coverage, 'complete')
  assert.equal(getMemoryEmbeddings({ userId: owner, memoryIds: [gone.id] }).size, 0)
  assert.equal(search(owner, { querySpace: 'unknown' }).diagnostics.code, 'MEMORY_SEMANTIC_QUERY_INVALID')
  const pending = scanMemoriesNeedingEmbedding({
    userId: owner, model: 'embed-test', space: EMBED_SPACE, dimensions: 2, limit: 32,
  }).memories.map((memory) => memory.id)
  assert.deepEqual(pending.sort(), [wrongWidth.id, unknown.id, stale.id, corrupt.id].sort())
})

test('history recall enforces user and persona scope even with parameter-like identifiers', async () => {
  const { createAgent } = await import('../server/services/agentStore.js')
  const owner = isolatedUser('semantic-owner')
  const other = isolatedUser('semantic-stranger')
  const firstAgent = createAgent({ userId: owner, name: 'First', soulMd: 's', identityMd: 'i' })
  const secondAgent = createAgent({ userId: owner, name: 'Second', soulMd: 's', identityMd: 'i' })
  const make = (userId, agentId, title) => {
    const memory = upsertMemory({ userId, agentId, type: 'reference', title, body: 'only correct scope' })
    storeVector(memory)
    return memory
  }
  const global = make(owner, null, 'Global')
  const first = make(owner, firstAgent.id, 'First only')
  const second = make(owner, secondAgent.id, 'Second only')
  const foreign = make(other, null, 'Other owner')
  assert.deepEqual(search(owner).memories.map((memory) => memory.id), [global.id])
  assert.deepEqual(search(owner, { agentId: firstAgent.id }).memories.map((memory) => memory.id).sort(), [global.id, first.id].sort())
  assert.deepEqual(search(owner, { agentId: secondAgent.id }).memories.map((memory) => memory.id).sort(), [global.id, second.id].sort())
  assert.deepEqual(search(other).memories.map((memory) => memory.id), [foreign.id])
  assert.deepEqual(search("' OR 1=1 --").memories, [])
  assert.deepEqual(search(owner, { agentId: "' OR 1=1 --" }).memories.map((memory) => memory.id), [global.id])
  assert.throws(() => upsertMemory({
    userId: other, agentId: firstAgent.id, type: 'user', title: 'Forged', body: 'wrong owner',
  }), { code: 'MEMORY_AGENT_NOT_FOUND' })
})

test('background indexing advances over clean scan pages without cross-scope cursor reuse', async () => {
  const owner = isolatedUser('background-progress')
  for (let index = 0; index < 5; index += 1) {
    storeVector(upsertMemory({ userId: owner, type: 'reference', title: `Done ${index}`, body: 'indexed' }))
  }
  const target = upsertMemory({ userId: owner, type: 'reference', title: 'Pending', body: 'old backlog' })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }
  }
  const counts = []
  for (let turn = 0; turn < 6; turn += 1) {
    counts.push((await indexMemoryEmbeddings({ userId: owner, env: EMBED_ENV, fetchImpl, maxScanned: 1 })).indexed)
  }
  assert.deepEqual(counts, [0, 0, 0, 0, 0, 1])
  assert.equal(calls, 1)
  assert.ok(getMemoryEmbeddings({ userId: owner, memoryIds: [target.id] }).has(target.id))
})
