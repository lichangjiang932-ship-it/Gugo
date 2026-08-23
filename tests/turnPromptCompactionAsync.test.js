import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'

function dependencies(overrides = {}) {
  return {
    prepareSkillsForPrompt: () => [],
    prepareSkillCatalogForPrompt: () => [],
    prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
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
  assert.equal(warnings.some((warning) => warning.includes('archive storage offline')), true)
})
