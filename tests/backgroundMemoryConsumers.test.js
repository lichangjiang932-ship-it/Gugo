import assert from 'node:assert/strict'
import test from 'node:test'

import '../server/services/loop/index.js'
import { createDefaultExecuteStep } from '../server/services/jobStepExecutionRuntime.js'
import { prepareBackgroundPromptContextAsync } from '../server/services/turnPromptContext.js'
import { runSubagent } from '../server/services/subagentRuntime.js'
import { closeDb, createUser, getDb } from '../server/db.js'
import { appendJobSteps, createJob } from '../server/services/jobStore.js'
import { createSqliteSubagentRunPersistenceAdapter } from '../server/adapters/sqliteSubagentRunPersistenceAdapter.js'

const userId = 'background-memory-alice'
const otherUser = 'background-memory-bob'
createUser({ id: userId, email: 'background-alice@example.test' })
createUser({ id: otherUser, email: 'background-bob@example.test' })
test.after(() => closeDb())
const ENV = { MODEL_BASE_URL: 'http://127.0.0.1:9/v1', MODEL_NAME: 'offline-model',
  MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'offline-vector',
  MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1', MEMORY_EMBEDDING_DIMENSIONS: '2' }
const persistencePort = createSqliteSubagentRunPersistenceAdapter({ getDb })

function contextFactory() {
  const requests = []
  const recalls = []
  const prepares = []
  const dependencies = {
    prepareSkillsForPrompt: () => [], prepareSkillCatalogForPrompt: () => [], readWorkspaceInstructions: () => null,
    fetchImpl: async () => { throw new Error('real network is forbidden') },
    embedMemoryTexts: async (request) => { requests.push(request); return { ok: true, vectors: [[1, 0]], dimensions: 2 } },
    prepareMemoryInjectionContext: (input) => { recalls.push(input); return {
      text: `# Memory\nowned-${input.userId}-${input.agentId}`, memoryIds: [`memory-${input.userId}-${input.agentId}`],
    } },
  }
  return { requests, recalls, prepares, dependencies,
    prepare: async (input) => { prepares.push(input); return prepareBackgroundPromptContextAsync(input, dependencies) } }
}

test('actual job consumer awaits one semantic recall, forwards scope/signal and exposes safe diagnostics', async () => {
  const context = contextFactory()
  let calls = 0
  const controller = new AbortController()
  const execute = createDefaultExecuteStep({ enableServerTools: false, preparePromptContext: context.prepare,
    runModel: async ({ messages }) => {
      calls += 1
      assert.ok(messages.some((message) => message.content.includes(`owned-${userId}-agent-a`)))
      return 'fixture summary'
    } })
  const result = await execute({ job: { userId, agentId: 'agent-a', prompt: 'PRIVATE_JOB_QUERY', steps: [] },
    step: { kind: 'chat' }, signal: controller.signal, modelEnv: ENV })
  assert.equal(calls, 1)
  assert.equal(context.requests.length, 1)
  assert.equal(context.requests[0].signal, controller.signal)
  assert.equal(Object.isFrozen(context.prepares[0].env), true)
  assert.deepEqual(result.output.promptContext.memoryIds, [`memory-${userId}-agent-a`])
  assert.doesNotMatch(JSON.stringify(result.output.promptContext), /PRIVATE_JOB_QUERY/u)
})

test('actual job consumer defaults disabled and already cancelled tasks make zero requests', async () => {
  const context = contextFactory()
  let models = 0
  const execute = createDefaultExecuteStep({ enableServerTools: false, preparePromptContext: context.prepare,
    runModel: async () => { models += 1; return 'fixture' } })
  const input = { job: { userId, prompt: 'fixture', steps: [] }, step: { kind: 'chat' }, modelEnv: {} }
  await execute(input)
  assert.equal(context.requests.length, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(execute({ ...input, signal: controller.signal, modelEnv: ENV }), { name: 'AbortError' })
  assert.equal(context.requests.length, 0)
  assert.equal(models, 1)
})

test('job resume loads its owner-scoped checkpoint once and does not rebuild memory context', async () => {
  const id = 'memory-restored-job'
  const stepId = 'memory-restored-step'
  createJob({ id, userId, title: 'restore', prompt: 'Explain the fixture.' })
  appendJobSteps(id, [{ id: stepId, title: 'explain', kind: 'chat' }])
  const context = contextFactory()
  let loads = 0
  const restored = { state: { version: 1, messages: [{ role: 'user', content: 'Explain the fixture.' }],
    promptContext: { memoryIds: ['restored-memory'], memoryDiagnostics: { linkedCount: 1 } },
    final: { text: 'Saved answer.', incomplete: false }, toolCalls: [] } }
  const execute = createDefaultExecuteStep({ preparePromptContext: context.prepare,
    runtimeCore: { checkpoint: {
      load: async (scope) => { loads += 1; assert.deepEqual(scope, { jobId: id, stepId, userId }); return restored },
      save: async (_scope, state) => ({ state }),
    } },
    runModelWithTools: async () => { assert.fail('completed checkpoint must not call a model') },
  })
  const result = await execute({ job: { id, userId, prompt: 'Explain the fixture.', steps: [] }, step: { id: stepId, kind: 'chat' }, modelEnv: ENV })
  assert.equal(loads, 1)
  assert.equal(context.prepares.length, 0)
  assert.equal(context.requests.length, 0)
  assert.deepEqual(result.output.promptContext.memoryIds, ['restored-memory'])
})

function subagentOptions(context, overrides = {}) {
  return {
    userId, agentId: 'agent-a', type: 'explore', prompt: 'PRIVATE_SUBAGENT_QUERY', persistencePort,
    resolveModelBinding: () => ({ providerId: null, configRevision: null, modelName: 'offline-model', env: ENV }),
    invokeSubagentProvider: async () => ({ kind: 'builtin', provenance: { decision: 'absent' } }),
    preparePromptContext: context.prepare,
    runToolLoop: async () => ({ text: 'fixture result', incomplete: false }),
    ...overrides,
  }
}

test('actual subagent consumer embeds once per fresh owner/agent scope and records no query in diagnostics', async () => {
  const context = contextFactory()
  for (const scope of [{ userId, agentId: 'agent-a' }, { userId: otherUser, agentId: 'agent-b' }]) {
    const run = await runSubagent(subagentOptions(context, { ...scope, runToolLoop: async ({ messages }) => {
      assert.ok(messages.some((message) => message.content.includes(`owned-${scope.userId}-${scope.agentId}`)))
      return { text: 'fixture result', incomplete: false }
    } }))
    const row = getDb().prepare('SELECT trace_json FROM subagent_runs WHERE id = ? AND user_id = ?').get(run.id, scope.userId)
    const event = JSON.parse(row.trace_json).find((entry) => entry.type === 'prompt_context')
    assert.deepEqual(event.memoryIds, [`memory-${scope.userId}-${scope.agentId}`])
    assert.equal(event.memoryDiagnostics.embedding.status, 'ready')
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_SUBAGENT_QUERY/u)
  }
  assert.equal(context.requests.length, 2)
  assert.deepEqual(context.recalls.map(({ userId: owner, agentId }) => [owner, agentId]), [[userId, 'agent-a'], [otherUser, 'agent-b']])
})

test('subagent resume uses persisted messages and does not repeat query embedding', async () => {
  const context = contextFactory()
  const id = 'subagent-memory-resume'
  const input = subagentOptions(context, { id,
    runToolLoop: async ({ messages, saveCheckpoint }) => {
      await saveCheckpoint({ version: 1, messages, toolCalls: [], iterations: 0 })
      return { text: 'partial', interrupted: true }
    },
  })
  const first = await runSubagent(input)
  assert.equal(first.status, 'interrupted')
  assert.equal(context.requests.length, 1)
  await runSubagent({ ...input, agentId: 'must-not-recall-other-agent', runToolLoop: async ({ messages }) => {
    assert.ok(messages.some((message) => message.content.includes(`owned-${userId}-agent-a`)))
    return { text: 'resumed', incomplete: false }
  } })
  assert.equal(context.requests.length, 1)
  assert.equal(context.prepares.length, 1)
})

test('actual subagent consumer starts no embedding when disabled or cancelled', async () => {
  const context = contextFactory()
  const disabled = subagentOptions(context, {
    resolveModelBinding: () => ({ providerId: null, configRevision: null, modelName: 'offline-model', env: {} }),
  })
  await runSubagent(disabled)
  assert.equal(context.requests.length, 0)
  const before = context.prepares.length
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runSubagent(subagentOptions(context, { signal: controller.signal })), { name: 'AbortError' })
  assert.equal(context.requests.length, 0)
  assert.equal(context.prepares.length, before)
})

test('resuming a partial subagent without saved messages skips new embeddings and retains its initial agent scope', async () => {
  const context = contextFactory()
  const input = subagentOptions(context, { id: 'subagent-memory-no-checkpoint',
    runToolLoop: async () => ({ text: 'partial', interrupted: true }),
  })
  await runSubagent(input)
  assert.equal(context.requests.length, 1)
  await runSubagent({ ...input, agentId: 'not-the-original-agent', runToolLoop: async () => ({ text: 'done' }) })
  assert.equal(context.requests.length, 1)
  assert.equal(context.recalls.at(-1).agentId, 'agent-a')
  assert.equal(context.recalls.at(-1).queryVector, null)
})
