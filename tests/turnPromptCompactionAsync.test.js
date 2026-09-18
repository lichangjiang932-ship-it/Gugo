import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'

function dependencies(overrides = {}) {
  return {
    prepareSkillsForPrompt: () => [],
    prepareSkillCatalogForPrompt: () => [],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    goalToolContextForTurn: () => ({ active: false, planId: null, promptBlock: null }),
    renderRuntimePromptBlocks: () => ({ blocks: [], errors: [] }),
    readWorkspaceInstructions: () => null,
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    userId: 'async-prompt-owner',
    sessionId: 'async-prompt-session',
    recentMessages: [{ id: 'archive-reference', role: 'assistant', content: 'marker' }],
    env: { AGENT_INJECT_ENABLED: '0' },
    ...overrides,
  }
}

test('turn prompt awaits an async compaction session block without losing its boundary', async () => {
  const compactionArchivePort = Object.freeze({ id: 'async-test-port' })
  const compactionBoundary = Object.freeze({
    compacted: true,
    referenceMessageId: 'archive-reference',
    referenceMessageIndex: 0,
  })
  let observedInput = null
  const pending = prepareTurnPromptContext(request({ compactionArchivePort }), dependencies({
    buildSessionsBlock: async (input) => {
      observedInput = input
      return {
        text: '# Session Context\n\n## Compacted Archive\nASYNC ARCHIVE SUMMARY',
        sources: {
          archiveId: 'archive-async-1',
          compactionBoundary,
        },
      }
    },
  }))

  assert.equal(typeof pending?.then, 'function')
  const prepared = await pending

  assert.equal(observedInput.compactionArchivePort, compactionArchivePort)
  assert.equal(
    prepared.messages.some((message) => message.content.includes('ASYNC ARCHIVE SUMMARY')),
    true,
  )
  assert.equal(prepared.compactionArchiveId, 'archive-async-1')
  assert.equal(prepared.compactionBoundary, compactionBoundary)
})

test('turn prompt preserves a synchronous return for synchronous session blocks', () => {
  const prepared = prepareTurnPromptContext(request(), dependencies({
    buildSessionsBlock: () => ({
      text: '# Session Context\nSYNCHRONOUS SUMMARY',
      sources: { archiveId: 'archive-sync-1', compactionBoundary: null },
    }),
  }))

  assert.equal(typeof prepared?.then, 'undefined')
  assert.equal(prepared.compactionArchiveId, 'archive-sync-1')
  assert.equal(
    prepared.messages.some((message) => message.content.includes('SYNCHRONOUS SUMMARY')),
    true,
  )
})

test('turn prompt fails soft when an async session block rejects', async () => {
  const warnings = []
  const prepared = await prepareTurnPromptContext(request(), dependencies({
    buildSessionsBlock: async () => {
      throw new Error('archive storage offline')
    },
    logWarn: (...args) => warnings.push(args.join(' ')),
  }))

  assert.deepEqual(prepared.messages, [])
  assert.equal(prepared.compactionArchiveId, null)
  assert.equal(prepared.compactionBoundary, null)
  // Optional provider errors can contain paths, credentials or prompt content.
  // The diagnostic contract is the exact failed stage and bounded error code.
  assert.deepEqual(warnings, ['turn.prompt session block failed: PROMPT_CONTEXT_UNAVAILABLE'])
  assert.doesNotMatch(warnings.join('\n'), /archive storage offline/u)
})

test('async session fallback preserves its safe storage code and other available prompt blocks', async () => {
  const warnings = []
  const prepared = await prepareTurnPromptContext(request(), dependencies({
    buildSessionsBlock: async () => {
      throw Object.assign(new Error('archive storage offline; token=PRIVATE_ARCHIVE_TOKEN'), {
        code: 'COMPACTION_ARCHIVE_STORAGE_UNAVAILABLE',
      })
    },
    readWorkspaceInstructions: () => ({ text: 'AVAILABLE_WORKSPACE_INSTRUCTIONS' }),
    prepareMemoryInjectionContext: () => ({ text: 'AVAILABLE_MEMORY_CONTEXT', memoryIds: ['available-memory'] }),
    logWarn: (...args) => warnings.push(args.join(' ')),
  }))

  assert.deepEqual(prepared.messages.map((message) => message.content), [
    'AVAILABLE_WORKSPACE_INSTRUCTIONS', 'AVAILABLE_MEMORY_CONTEXT',
  ])
  assert.deepEqual(prepared.memoryIds, ['available-memory'])
  assert.equal(prepared.compactionArchiveId, null)
  assert.equal(prepared.compactionBoundary, null)
  assert.deepEqual(warnings, ['turn.prompt session block failed: COMPACTION_ARCHIVE_STORAGE_UNAVAILABLE'])
  assert.doesNotMatch(JSON.stringify({ warnings, prepared }), /PRIVATE_ARCHIVE_TOKEN|archive storage offline/u)
})

test('async session diagnostics reject arbitrary codes instead of copying exception details', async () => {
  const warnings = []
  const prepared = await prepareTurnPromptContext(request(), dependencies({
    buildSessionsBlock: async () => {
      throw Object.assign(new Error('PRIVATE_ARCHIVE_MESSAGE'), {
        code: 'COMPACTION_ARCHIVE_FAILED\nPRIVATE_ARCHIVE_TOKEN',
      })
    },
    logWarn: (...args) => warnings.push(args.join(' ')),
  }))

  assert.deepEqual(prepared.messages, [])
  assert.equal(prepared.compactionArchiveId, null)
  assert.equal(prepared.compactionBoundary, null)
  assert.deepEqual(warnings, ['turn.prompt session block failed: PROMPT_CONTEXT_UNAVAILABLE'])
  assert.doesNotMatch(JSON.stringify({ warnings, prepared }), /PRIVATE_/u)
})

test('async session failure stays fail-soft if its diagnostic logger also fails', async () => {
  let attempts = 0
  let warnings = 0
  const prepared = await prepareTurnPromptContext(request(), dependencies({
    buildSessionsBlock: async () => {
      attempts += 1
      throw new Error('archive storage offline')
    },
    logWarn: () => { warnings += 1; throw new Error('diagnostic writer unavailable') },
  }))

  assert.deepEqual(prepared.messages, [])
  assert.equal(prepared.compactionArchiveId, null)
  assert.equal(prepared.compactionBoundary, null)
  assert.equal(attempts, 1)
  assert.equal(warnings, 1)
})
