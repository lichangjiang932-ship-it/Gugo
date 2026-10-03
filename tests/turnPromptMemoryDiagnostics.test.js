import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareBackgroundPromptContext, prepareTurnPromptContext } from '../server/services/turnPromptContext.js'
import { resolveMemoryEmbeddingSpace } from '../server/services/memoryEmbeddingService.js'

const env = { AGENT_INJECT_ENABLED: '0', MEMORY_EMBEDDINGS_ENABLED: '1',
  MEMORY_EMBEDDING_MODEL: 'fixture-embedding', MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:43210/v1' }

function dependencies(capture) {
  return {
    prepareSkillsForPrompt: () => [], prepareSkillCatalogForPrompt: () => [],
    readWorkspaceInstructions: () => null, buildSessionsBlock: () => null,
    goalToolContextForTurn: () => ({ active: false, planId: null, promptBlock: null }),
    renderRuntimePromptBlocks: () => ({ blocks: [], errors: [] }),
    prepareMemoryInjectionContext: (input) => {
      capture.push(input)
      return { text: '', memoryIds: [], diagnostics: { failed: false, linkedCount: 2,
        query: 'PRIVATE_QUERY_MUST_NOT_LEAK', error: 'PRIVATE_ERROR_MUST_NOT_LEAK',
        retrieval: { semantic: { code: 'MEMORY_SEMANTIC_SCAN_LIMIT', coverage: 'partial', truncated: true, scanned: 42 } } } }
    },
  }
}

test('background memory uses the same embedding space and cancellation signal as the turn path', () => {
  const capture = []
  const controller = new AbortController()
  prepareBackgroundPromptContext({ userId: 'fixture-user', agentId: 'fixture-agent', query: 'query',
    queryVector: [1, 0], signal: controller.signal, env }, dependencies(capture))
  assert.equal(capture[0].querySpace, resolveMemoryEmbeddingSpace(env))
  assert.equal(capture[0].signal, controller.signal)
})

test('prompt diagnostics retain retrieval coverage without copying private query/error text', async () => {
  const capture = []
  const controller = new AbortController()
  const context = await prepareTurnPromptContext({ userId: 'fixture-user', sessionId: 'fixture-session',
    memoryQueryVector: [1, 0], signal: controller.signal, env }, dependencies(capture))
  assert.equal(capture[0].signal, controller.signal)
  assert.equal(capture[0].querySpace, resolveMemoryEmbeddingSpace(env))
  assert.equal(context.memoryDiagnostics.semantic.coverage, 'partial')
  assert.equal(context.memoryDiagnostics.semantic.scanned, 42)
  assert.equal(context.memoryDiagnostics.linkedCount, 2)
  assert.ok(!JSON.stringify(context.memoryDiagnostics).includes('PRIVATE_'))
})
