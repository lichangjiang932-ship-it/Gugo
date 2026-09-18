import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertMemory } from '../server/services/memoryStore.js'
import { getDb } from '../server/db.js'
import { reindexUserMemoryEmbeddings } from '../server/services/memoryEmbeddingReindex.js'
import { memoryContentFingerprint, memoryEmbeddingSpaceId } from '../server/services/memoryEmbeddingService.js'
import { getMemoryEmbeddings, setMemoryEmbedding } from '../server/services/memoryEmbeddingStore.js'

const countEmbeddings = () => getDb()
  .prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE user_id = ?").get(userId).n

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-reindex-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

const issued = issueEmailCode({ email: 'reindex@example.com' })
const userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
for (let index = 0; index < 5; index += 1) {
  upsertMemory({
    userId, type: 'project', title: `note-${index}`, body: `body ${index}`,
  })
}

const EMBEDDING_ENV = Object.freeze({
  MEMORY_EMBEDDINGS_ENABLED: '1',
  MEMORY_EMBEDDING_BASE_URL: 'http://embeddings.test/v1',
  MEMORY_EMBEDDING_MODEL: 'test-embed',
  MEMORY_EMBEDDING_API_KEY: 'not-a-real-key',
})

function fakeEmbedder({ failAt = null } = {}) {
  let calls = 0
  return {
    get calls() { return calls },
    fetchImpl: async (_url, init) => {
      calls += 1
      if (failAt !== null && calls >= failAt) return { ok: false, status: 500, async json() { return null } }
      const inputs = JSON.parse(init.body).input
      return {
        ok: true,
        async json() {
          return { data: inputs.map((_text, index) => ({ index, embedding: [1, index] })) }
        },
      }
    },
  }
}

test('reindex is a no-op with a stable code when embeddings are disabled', async () => {
  const result = await reindexUserMemoryEmbeddings({ userId, env: {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MEMORY_EMBEDDINGS_DISABLED')
  assert.equal(result.indexed, 0)
})

test('reindex drains the backlog in bounded batches and is restartable', async () => {
  const embedder = fakeEmbedder()
  const progress = []
  const first = await reindexUserMemoryEmbeddings({
    userId, env: EMBEDDING_ENV, batchSize: 2, maxTotal: 100, fetchImpl: embedder.fetchImpl,
    onProgress: (event) => progress.push(event.indexed),
  })
  assert.equal(first.ok, true)
  assert.equal(first.indexed, 5)
  assert.equal(first.model, 'test-embed')
  assert.deepEqual(progress, [2, 4, 5], 'progress is reported per batch')
  assert.equal(countEmbeddings(), 5)

  // A second run finds nothing left and makes no further network calls.
  const callsAfterFirst = embedder.calls
  const second = await reindexUserMemoryEmbeddings({
    userId, env: EMBEDDING_ENV, batchSize: 2, maxTotal: 100, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(second.indexed, 0)
  assert.equal(embedder.calls, callsAfterFirst, 'an empty backlog must not call the endpoint')
})

test('a failing endpoint ends the loop with a stable code instead of spinning', async () => {
  upsertMemory({ userId, type: 'project', title: 'note-fail', body: 'needs embedding' })
  const embedder = fakeEmbedder({ failAt: 1 })
  const result = await reindexUserMemoryEmbeddings({
    userId, env: EMBEDDING_ENV, batchSize: 2, maxTotal: 100, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(result.ok, false)
  assert.match(String(result.code), /^MEMORY_EMBEDDING_HTTP_500$/)
  assert.equal(embedder.calls, 1, 'the loop stops on the first hard failure')
})

test('maxTotal caps how much work a single run performs', async () => {
  const embedder = fakeEmbedder()
  const result = await reindexUserMemoryEmbeddings({
    userId, env: EMBEDDING_ENV, batchSize: 1, maxTotal: 1, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.ok(result.indexed <= 1)
})

test('reindex reports the scope it actually covered instead of claiming success', async () => {
  // Reported: the command only ever saw global memories, skipped agent-scoped
  // ones, and still reported success.
  const { ensureDefaultAgent } = await import('../server/services/agentStore.js')
  const agentId = ensureDefaultAgent({ userId }).id
  upsertMemory({ userId, type: 'project', title: 'scope-global', body: 'global body' })
  upsertMemory({ userId, agentId, type: 'project', title: 'scope-agent', body: 'agent body' })
  const embedder = fakeEmbedder()

  const globalPass = await reindexUserMemoryEmbeddings({
    userId, env: EMBEDDING_ENV, batchSize: 8, maxTotal: 100, fetchImpl: embedder.fetchImpl,
  })
  assert.deepEqual(globalPass.scope, { kind: 'global', agentId: null })
  assert.equal(globalPass.space, memoryEmbeddingSpaceId({
    baseUrl: EMBEDDING_ENV.MEMORY_EMBEDDING_BASE_URL, model: EMBEDDING_ENV.MEMORY_EMBEDDING_MODEL,
  }))

  // The agent-scoped memory is still pending after the global pass.
  const { scanMemoriesNeedingEmbedding } = await import('../server/services/memoryEmbeddingStore.js')
  const stillPending = scanMemoriesNeedingEmbedding({
    userId, agentId, model: EMBEDDING_ENV.MEMORY_EMBEDDING_MODEL, space: globalPass.space, limit: 10,
  })
  assert.ok(stillPending.memories.some((memory) => memory.title === 'scope-agent'))

  const allAgents = await reindexUserMemoryEmbeddings({
    userId, agentId: '__all__', env: EMBEDDING_ENV, batchSize: 8, maxTotal: 100,
    fetchImpl: embedder.fetchImpl,
  })
  assert.deepEqual(allAgents.scope, { kind: 'all_agents', agentId: null })
  assert.ok(allAgents.indexed >= 1, 'the all-agents scope reaches agent memories')
})

function isolatedUser(label) {
  const issued = issueEmailCode({ email: `${label}@example.com` })
  return verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
}

function createNotes(owner, count) {
  return Array.from({ length: count }, (_, index) => upsertMemory({
    userId: owner, type: 'project', title: `Reindex note ${index}`, body: `input ${index}`,
  }))
}

test('exact-limit completion is not truncated, and a partial run resumes without skipping rows', async () => {
  const exactOwner = isolatedUser('reindex-exact-limit')
  createNotes(exactOwner, 3)
  const exact = await reindexUserMemoryEmbeddings({
    userId: exactOwner, env: EMBEDDING_ENV, batchSize: 2, maxTotal: 3, fetchImpl: fakeEmbedder().fetchImpl,
  })
  assert.equal(exact.indexed, 3)
  assert.equal(exact.truncated, false)
  assert.equal(exact.coverage, 'complete')
  assert.equal(exact.remaining, 0)
  assert.equal(exact.remainingIsExact, true)

  const owner = isolatedUser('reindex-resume-limit')
  const notes = createNotes(owner, 5)
  const first = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, batchSize: 2, maxTotal: 3, fetchImpl: fakeEmbedder().fetchImpl,
  })
  assert.equal(first.indexed, 3)
  assert.equal(first.truncated, true)
  assert.equal(first.remaining, 2)
  assert.equal(first.remainingIsExact, true)
  assert.ok(first.nextCursor)
  const last = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, cursor: first.nextCursor, fetchImpl: fakeEmbedder().fetchImpl,
  })
  assert.equal(last.indexed, 2)
  assert.equal(last.truncated, false)
  assert.equal(getMemoryEmbeddings({ userId: owner, memoryIds: notes.map((memory) => memory.id) }).size, 5)
})

test('write failures are reported without discarding progress and are retryable', async () => {
  const owner = isolatedUser('reindex-write-failure')
  const [memory] = createNotes(owner, 1)
  getDb().exec(`CREATE TEMP TRIGGER reject_test_memory_vector BEFORE INSERT ON memory_embeddings
    BEGIN SELECT RAISE(ABORT, 'synthetic embedding write failure'); END`)
  let failed
  try {
    failed = await reindexUserMemoryEmbeddings({ userId: owner, env: EMBEDDING_ENV, fetchImpl: fakeEmbedder().fetchImpl })
  } finally {
    getDb().exec('DROP TRIGGER reject_test_memory_vector')
  }
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'MEMORY_EMBEDDING_WRITE_FAILED')
  assert.equal(failed.indexed, 0)
  assert.equal(failed.remaining, 1)
  assert.equal(failed.truncated, true)
  assert.equal(getMemoryEmbeddings({ userId: owner, memoryIds: [memory.id] }).size, 0)
  const recovered = await reindexUserMemoryEmbeddings({ userId: owner, env: EMBEDDING_ENV, fetchImpl: fakeEmbedder().fetchImpl })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.indexed, 1)
  assert.equal(recovered.truncated, false)
})

test('an input edited while embedding is in flight is left pending for a fresh retry', async () => {
  const owner = isolatedUser('reindex-edit-race')
  const [memory] = createNotes(owner, 1)
  const result = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV,
    fetchImpl: async () => {
      upsertMemory({ userId: owner, id: memory.id, type: 'project', title: memory.title, body: 'new input' })
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) }
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MEMORY_EMBEDDING_INPUT_CHANGED')
  assert.equal(result.indexed, 0)
  assert.equal(result.remaining, 1)
  assert.equal(getMemoryEmbeddings({ userId: owner, memoryIds: [memory.id] }).size, 0)
  const retry = await reindexUserMemoryEmbeddings({ userId: owner, env: EMBEDDING_ENV, fetchImpl: fakeEmbedder().fetchImpl })
  assert.equal(retry.indexed, 1)
  assert.equal(retry.coverage, 'complete')
})

test('cancelled reindex does no new work and preserves already committed vectors', async () => {
  const owner = isolatedUser('reindex-cancel')
  createNotes(owner, 3)
  const controller = new AbortController()
  controller.abort()
  const embedder = fakeEmbedder()
  const cancelled = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, signal: controller.signal, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(cancelled.code, 'MEMORY_EMBEDDING_ABORTED')
  assert.equal(embedder.calls, 0)
  assert.equal(cancelled.remaining, null, 'no probe should claim the cancelled scope has no backlog')

  const midRun = new AbortController()
  const partial = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, batchSize: 1, signal: midRun.signal, fetchImpl: embedder.fetchImpl,
    onProgress: () => midRun.abort(),
  })
  assert.equal(partial.code, 'MEMORY_EMBEDDING_ABORTED')
  assert.equal(partial.indexed, 1)
  assert.equal(embedder.calls, 1)
  const resumed = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(resumed.indexed, 2)
  assert.equal(resumed.remaining, 0)
})

test('one-agent and all-agent rebuild scopes preserve persona and user isolation', async () => {
  const { createAgent } = await import('../server/services/agentStore.js')
  const owner = isolatedUser('reindex-scope-owner')
  const other = isolatedUser('reindex-scope-other')
  const a = createAgent({ userId: owner, name: 'A', soulMd: 's', identityMd: 'i' })
  const b = createAgent({ userId: owner, name: 'B', soulMd: 's', identityMd: 'i' })
  const [global] = createNotes(owner, 1)
  const first = upsertMemory({ userId: owner, agentId: a.id, type: 'user', title: 'A private', body: 'alpha' })
  const second = upsertMemory({ userId: owner, agentId: b.id, type: 'user', title: 'B private', body: 'beta' })
  const [foreign] = createNotes(other, 1)
  const single = await reindexUserMemoryEmbeddings({
    userId: owner, agentId: a.id, env: EMBEDDING_ENV, fetchImpl: fakeEmbedder().fetchImpl,
  })
  assert.equal(single.indexed, 2, 'one-agent injection scope includes global memories')
  assert.equal(single.scope.kind, 'agent')
  assert.equal(single.scope.agentId, a.id)
  assert.equal(single.truncated, false)
  assert.deepEqual([...getMemoryEmbeddings({
    userId: owner, memoryIds: [global.id, first.id, second.id, foreign.id],
  }).keys()].sort(), [global.id, first.id].sort())
  const all = await reindexUserMemoryEmbeddings({
    userId: owner, agentId: '__all__', env: EMBEDDING_ENV, fetchImpl: fakeEmbedder().fetchImpl,
  })
  assert.equal(all.indexed, 1)
  assert.equal(getMemoryEmbeddings({ userId: other, memoryIds: [foreign.id] }).size, 0)
})

test('reindex reaches a backlog beyond a full clean scan budget and verifies final coverage', async () => {
  const owner = isolatedUser('reindex-large-clean-head')
  const space = memoryEmbeddingSpaceId({
    baseUrl: EMBEDDING_ENV.MEMORY_EMBEDDING_BASE_URL, model: EMBEDDING_ENV.MEMORY_EMBEDDING_MODEL,
  })
  getDb().transaction(() => {
    for (let index = 0; index < 4_005; index += 1) {
      const memory = upsertMemory({ userId: owner, type: 'reference', title: `Ready ${index}`, body: `known ${index}` })
      setMemoryEmbedding({
        userId: owner, memoryId: memory.id, model: EMBEDDING_ENV.MEMORY_EMBEDDING_MODEL,
        vector: [1, 0], embeddingSpace: space, contentFingerprint: memoryContentFingerprint(memory),
      })
    }
  })()
  createNotes(owner, 1)
  const embedder = fakeEmbedder()
  const result = await reindexUserMemoryEmbeddings({
    userId: owner, env: EMBEDDING_ENV, maxTotal: 1, fetchImpl: embedder.fetchImpl,
  })
  assert.equal(result.indexed, 1)
  assert.equal(embedder.calls, 1)
  assert.equal(result.scanComplete, true)
  assert.equal(result.remaining, 0)
  assert.equal(result.remainingIsExact, true)
  assert.equal(result.coverage, 'complete')
})
