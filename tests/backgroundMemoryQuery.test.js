import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareBackgroundPromptContextAsync } from '../server/services/turnPromptContext.js'
import { prepareOptionalPromptContextAsync } from '../server/services/optionalPromptContext.js'
import { resolveMemoryEmbeddingSpace } from '../server/services/memoryEmbeddingService.js'

const env = { MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'fixture',
  MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1', MEMORY_EMBEDDING_DIMENSIONS: '2' }

function dependencies() {
  const requests = []
  const recalls = []
  return {
    requests, recalls,
    prepareSkillsForPrompt: () => [], prepareSkillCatalogForPrompt: () => [], readWorkspaceInstructions: () => null,
    embedMemoryTexts: async (input) => { requests.push(input); return { ok: true, vectors: [[1, 0]], dimensions: 2 } },
    fetchImpl: async () => { throw new Error('unexpected real request') },
    prepareMemoryInjectionContext: (input) => {
      recalls.push(input)
      return { text: '# Memory\nfixture fact', memoryIds: ['memory-fixture'], diagnostics: {
        query: 'PRIVATE_QUERY', retrieval: { lexical: { coverage: 'partial', truncated: true, scanned: 12 } },
      } }
    },
  }
}

test('background embedding is opt-in, scope-bound and generated once with a frozen space', async () => {
  const deps = dependencies()
  await prepareBackgroundPromptContextAsync({ userId: 'alice', agentId: 'agent-a', query: 'query', env: {} }, deps)
  assert.equal(deps.requests.length, 0)
  const controller = new AbortController()
  const result = await prepareBackgroundPromptContextAsync({ userId: 'alice', agentId: 'agent-a', query: 'PRIVATE_QUERY', env, signal: controller.signal }, deps)
  assert.equal(deps.requests.length, 1)
  assert.equal(deps.requests[0].signal, controller.signal)
  assert.equal(deps.recalls.at(-1).userId, 'alice')
  assert.equal(deps.recalls.at(-1).agentId, 'agent-a')
  assert.equal(deps.recalls.at(-1).querySpace, resolveMemoryEmbeddingSpace(env))
  assert.deepEqual(deps.recalls.at(-1).queryVector, [1, 0])
  assert.deepEqual(result.memoryIds, ['memory-fixture'])
  assert.equal(result.memoryDiagnostics.embedding.status, 'ready')
  assert.equal(result.memoryDiagnostics.lexical.coverage, 'partial')
  assert.doesNotMatch(JSON.stringify(result.memoryDiagnostics), /PRIVATE_QUERY/u)
})

test('already-cancelled background context starts no embedding or recall', async () => {
  const deps = dependencies()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'query', env, signal: controller.signal }, deps), { name: 'AbortError' })
  assert.equal(deps.requests.length, 0)
  assert.equal(deps.recalls.length, 0)
})

test('embedding cancellation propagates and failed requests degrade once without retrying', async () => {
  const deps = dependencies()
  const controller = new AbortController()
  deps.embedMemoryTexts = async () => { controller.abort(); return { ok: false, code: 'MEMORY_EMBEDDING_ABORTED' } }
  await assert.rejects(prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'q', env, signal: controller.signal }, deps), { name: 'AbortError' })
  assert.equal(deps.recalls.length, 0)
  let attempts = 0
  deps.embedMemoryTexts = async () => { attempts += 1; throw new Error('https://secret.invalid/?token=PRIVATE_TOKEN') }
  const result = await prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'q', env }, deps)
  assert.equal(attempts, 1)
  assert.equal(result.memoryDiagnostics.embedding.code, 'MEMORY_EMBEDDING_FAILED')
  assert.equal(deps.recalls.at(-1).queryVector, null)
  assert.doesNotMatch(JSON.stringify(result.memoryDiagnostics), /secret|PRIVATE_TOKEN/u)
})

test('async optional wrapper preserves bounded IDs/diagnostics and never swallows cancellation', async () => {
  const result = await prepareOptionalPromptContextAsync({ preparePromptContext: async () => ({
    messages: [{ role: 'system', content: 'fixture' }], skillIds: ['skill'], memoryIds: ['memory'],
    memoryDiagnostics: { embedding: { status: 'ready', code: 'MEMORY_EMBEDDING_READY' }, query: 'PRIVATE_QUERY' },
  }) })
  assert.deepEqual(result.memoryIds, ['memory'])
  assert.equal(result.memoryDiagnostics.embedding.status, 'ready')
  assert.doesNotMatch(JSON.stringify(result.memoryDiagnostics), /PRIVATE_QUERY/u)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareOptionalPromptContextAsync({ input: { signal: controller.signal } }), { name: 'AbortError' })
})

test('embedding and recall keep the original config/space when a mutable source changes during await', async () => {
  const source = { ...env }
  const space = resolveMemoryEmbeddingSpace(source)
  const deps = dependencies()
  deps.embedMemoryTexts = async ({ config }) => {
    source.MEMORY_EMBEDDING_MODEL = 'changed-after-request'
    assert.equal(config.model, 'fixture')
    assert.equal(Object.isFrozen(config), true)
    return { ok: true, vectors: [[1, 0]], dimensions: 2 }
  }
  const result = await prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'query', env: source }, deps)
  assert.equal(deps.recalls[0].querySpace, space)
  assert.equal(result.memoryDiagnostics.embedding.space, space)
})

test('explicitly invalid config and resumed tasks do not request embeddings and report distinct reasons', async () => {
  const deps = dependencies()
  const invalid = await prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'query', env: { MEMORY_EMBEDDINGS_ENABLED: '1' } }, deps)
  assert.equal(invalid.memoryDiagnostics.embedding.code, 'MEMORY_EMBEDDING_CONFIG_INVALID')
  const resumed = await prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'query', env, resuming: true }, deps)
  assert.equal(resumed.memoryDiagnostics.embedding.code, 'MEMORY_EMBEDDING_RESUME_SKIPPED')
  assert.equal(deps.requests.length, 0)
})

test('failed optional recall reports failure without leaking its exception or query to logs', async () => {
  const deps = dependencies()
  const warnings = []
  deps.logWarn = (...args) => warnings.push(args)
  deps.prepareMemoryInjectionContext = () => { throw new Error('PRIVATE_QUERY_AND_SQL_ARGUMENT') }
  const result = await prepareBackgroundPromptContextAsync({ userId: 'alice', query: 'PRIVATE_QUERY', env: {} }, deps)
  assert.equal(result.memoryDiagnostics.failed, true)
  assert.deepEqual(result.memoryIds, [])
  assert.doesNotMatch(JSON.stringify({ diagnostics: result.memoryDiagnostics, warnings }), /PRIVATE_/u)
})
