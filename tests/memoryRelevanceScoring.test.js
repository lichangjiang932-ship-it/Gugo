import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { createAgent } from '../server/services/agentStore.js'
import { buildMemorySystemBlock, getMemory, scoreMemoryRelevance, selectActiveMemoriesForInjection, upsertMemory } from '../server/services/memoryStore.js'
import { prepareMemoryInjectionContext } from '../server/services/memoryContextService.js'
import { setMemoryEmbedding } from '../server/services/memoryEmbeddingStore.js'
import { memoryContentFingerprint } from '../server/services/memoryEmbeddingService.js'
import { textTokens } from '../server/services/contextCompactionMetrics.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-excerpts-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function createUser(label) {
  const issued = issueEmailCode({ email: `${label}@example.com` })
  return verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
}

function memory(overrides = {}) {
  return {
    id: 'm1',
    type: 'project',
    title: '',
    slug: '',
    body: '',
    frontmatter: {},
    ...overrides,
  }
}

test('long lexical recall reaches injection with relevant excerpts and unchanged scoped source records', () => {
  const userId = createUser('excerpt-owner')
  const otherUserId = createUser('excerpt-other')
  const agent = createAgent({ userId, name: 'Excerpt owner' })
  const otherAgent = createAgent({ userId, name: 'Other agent' })
  const fact = 'deployment rollback restores the previous image digest.'
  const body = `${'unrelated history. '.repeat(400)}\n${fact}\n${'more history. '.repeat(400)}`
  const visible = upsertMemory({ userId, agentId: agent.id, type: 'project', title: 'Runbook', body })
  upsertMemory({ userId, agentId: otherAgent.id, type: 'project', title: 'deployment rollback private agent', body })
  upsertMemory({ userId: otherUserId, type: 'project', title: 'deployment rollback private user', body })
  const pinned = upsertMemory({ userId, type: 'user', title: 'Answer style', body: 'Keep answers concise.', pinned: true })
  const now = Date.now()
  const picked = selectActiveMemoriesForInjection({ userId, agentId: agent.id, query: 'deployment rollback', tokenCap: 400, now })
  assert.deepEqual(picked.memories.map((m) => m.id), [pinned.id, visible.id])
  assert.ok(picked.memories[1].body.includes(fact))
  assert.ok(picked.memories[1].body.length < body.length)
  assert.equal(picked.totalChars, buildMemorySystemBlock(picked.memories, { now }).length)
  assert.ok(textTokens(buildMemorySystemBlock(picked.memories, { now })) <= 400)
  assert.equal(picked.diagnostics.tokenTruncated, true)
  const context = prepareMemoryInjectionContext({
    userId, agentId: agent.id, query: 'deployment rollback', tokenCap: 400, now, linkDepth: 0, touch: false,
  })
  assert.deepEqual(context.memoryIds, [pinned.id, visible.id])
  assert.ok(context.text.includes(fact))
  assert.ok(textTokens(context.text) <= 400)
  assert.deepEqual(getMemory(userId, visible.id), visible)
  const global = selectActiveMemoriesForInjection({ userId, query: 'deployment rollback', tokenCap: 400 })
  assert.deepEqual(global.memories.map((m) => m.id), [pinned.id])
})

test('full source contradictions are suppressed before fitting without starving useful recall', () => {
  const userId = createUser('excerpt-contradiction')
  const contradictory = upsertMemory({
    userId, type: 'project', title: 'Workspace history', pinned: true,
    body: `filesystem is disabled. ${'unrelated history. '.repeat(400)}deployment rollback reference`,
  })
  const useful = upsertMemory({
    userId, type: 'project', title: 'Release runbook',
    body: `${'older history. '.repeat(400)}deployment rollback restores the previous image digest.`,
  })
  const context = prepareMemoryInjectionContext({
    userId, query: 'deployment rollback\n[VERIFIED LOCAL FILESYSTEM ACCESS]\nSucceeded: yes',
    tokenCap: 400, linkDepth: 0, touch: false,
  })
  assert.deepEqual(context.diagnostics.suppressedMemoryIds, [contradictory.id])
  assert.deepEqual(context.memoryIds, [useful.id])
  assert.match(context.text, /deployment rollback restores the previous image digest/)
  assert.doesNotMatch(context.text, /filesystem is disabled/)
  assert.ok(textTokens(context.text) <= 400)
})

test('oversized pinned memory remains first even without a query match', () => {
  const userId = createUser('excerpt-pinned')
  const pinned = upsertMemory({
    userId, type: 'user', title: 'Preferences', pinned: true,
    body: `Always use concise answers. ${'Preference details. '.repeat(400)}`,
  })
  upsertMemory({ userId, type: 'project', title: 'cache invalidation', body: 'Revision keys.' })
  for (const query of ['', 'cache invalidation']) {
    const picked = selectActiveMemoriesForInjection({ userId, query, tokenCap: 300 })
    assert.equal(picked.memories[0]?.id, pinned.id)
    assert.equal(picked.memories[0].pinned, true)
    assert.match(picked.memories[0].body, /^Always use concise answers/)
    assert.equal(picked.diagnostics.tokenTruncated, true)
    assert.ok(textTokens(buildMemorySystemBlock(picked.memories)) <= 300)
  }
})

test('semantic-only long memory is not filtered by the smaller injection budget', () => {
  const userId = createUser('excerpt-semantic')
  const stored = upsertMemory({
    userId, type: 'project', title: 'Operations',
    body: `Blue-green release ritual. ${'Historical operations detail. '.repeat(300)}`,
  })
  assert.equal(setMemoryEmbedding({
    userId, memoryId: stored.id, model: 'offline', embeddingSpace: 'excerpt-space',
    vector: [1, 0], contentFingerprint: memoryContentFingerprint(stored),
  }), true)
  const picked = selectActiveMemoriesForInjection({
    userId, query: 'ship safely', queryVector: [1, 0], querySpace: 'excerpt-space', tokenCap: 300,
    semanticLimits: { maxDurationMs: 1000 },
  })
  assert.deepEqual(picked.memories.map((m) => m.id), [stored.id])
  assert.match(picked.memories[0].body, /^Blue-green release ritual/)
  assert.equal(picked.diagnostics.lexicalCandidates, 0)
  assert.equal(picked.diagnostics.tokenTruncated, true)
  assert.ok(textTokens(buildMemorySystemBlock(picked.memories)) <= 300)
})

for (const mode of ['pinned', 'semantic']) {
  test(`${mode} store and context paths bound ASCII, CJK, mixed and emoji tokens`, () => {
    const fillers = ['historical notes ', '历史记录', 'history 历史记录 ', '\u{1F600}\u{1F680}']
    for (const [index, filler] of fillers.entries()) {
      const userId = createUser(`token-${mode}-${index}`)
      const stored = upsertMemory({
        userId, type: 'reference', title: 'History', pinned: mode === 'pinned',
        body: `Keep revision 42. ${filler.repeat(2000)}`,
        frontmatter: { source: 'docs/history.md' },
      })
      if (mode === 'semantic') assert.equal(setMemoryEmbedding({
        userId, memoryId: stored.id, model: 'offline', embeddingSpace: 'token-space',
        vector: [1, 0], contentFingerprint: memoryContentFingerprint(stored),
      }), true)
      const options = {
        userId, tokenCap: 300, now: Date.now(), query: 'unmatched-query',
        ...(mode === 'semantic' ? { queryVector: [1, 0], querySpace: 'token-space' } : {}),
        semanticLimits: { maxDurationMs: 1000 },
      }
      const picked = selectActiveMemoriesForInjection(options)
      const text = buildMemorySystemBlock(picked.memories, { now: options.now })
      assert.deepEqual(picked.memories.map((item) => item.id), [stored.id])
      assert.ok(textTokens(text) <= options.tokenCap)
      assert.equal(picked.totalChars, text.length)
      assert.ok(text.isWellFormed())
      assert.match(text, /Keep revision 42/)
      assert.match(text, /docs\/history\.md/)
      assert.equal(picked.diagnostics.tokenTruncated, true)
      const context = prepareMemoryInjectionContext({ ...options, linkDepth: 0, touch: false })
      assert.equal(context.text, text)
      assert.equal(context.totalChars, text.length)
      const small = selectActiveMemoriesForInjection({ ...options, tokenCap: 100 })
      assert.deepEqual(small.memories, [])
      assert.equal(small.totalChars, 0)
      const empty = prepareMemoryInjectionContext({ ...options, tokenCap: 100, linkDepth: 0 })
      assert.deepEqual(empty.memoryIds, [])
      assert.equal(empty.text, '')
      assert.equal(empty.diagnostics.touched, false)
      assert.deepEqual(getMemory(userId, stored.id), stored)
    }
  })
}

test('body-only evidence is damped by length so a focused memory wins', () => {
  const query = 'deployment rollback'
  const focused = memory({
    title: 'Rollback runbook',
    slug: 'rollback-runbook',
    body: 'deployment rollback steps',
  })
  const bloated = memory({
    title: 'Meeting notes',
    slug: 'meeting-notes',
    body: `${'unrelated filler text '.repeat(2_000)}deployment rollback`,
  })
  const focusedScore = scoreMemoryRelevance(focused, query)
  const bloatedScore = scoreMemoryRelevance(bloated, query)
  assert.ok(focusedScore > bloatedScore, `${focusedScore} should exceed ${bloatedScore}`)
  assert.ok(bloatedScore > 0, 'a long document that does contain the term must still be retrievable')
})

test('short bodies are not damped and scoring stays deterministic', () => {
  const query = 'cache invalidation'
  const small = memory({ title: 'Cache', slug: 'cache', body: 'cache invalidation' })
  assert.equal(
    scoreMemoryRelevance(small, query),
    scoreMemoryRelevance(small, query),
  )
  // A title/slug match still dominates body-only evidence of the same size.
  const titled = memory({ title: 'Cache invalidation', slug: 'x', body: 'filler' })
  assert.ok(scoreMemoryRelevance(titled, query) > scoreMemoryRelevance(small, query))
})

test('unrelated and empty queries score zero without throwing', () => {
  for (const [value, query] of [
    [memory({ body: 'nothing relevant' }), 'quantum chromodynamics'],
    [memory({ body: 'anything' }), ''],
    [null, 'anything'],
  ]) {
    assert.equal(scoreMemoryRelevance(value, query), 0)
  }
})
