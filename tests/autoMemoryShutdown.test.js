import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { setImmediate as nextImmediate } from 'node:timers/promises'
import test from 'node:test'

const { closeDb, createUser } = await import('../server/db.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { listMemories } = await import('../server/services/memoryStore.js')
const { dispatchMemoryTool } = await import('../server/utils/memoryTools.js')
const { extractAndStoreAutoMemories, scheduleAutoMemoryExtraction } = await import('../server/services/autoMemoryService.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { createTestTurnEnginePersistence } = await import('./helpers/turnEnginePersistence.js')

test.after(() => closeDb())

const userId = 'auto-memory-shutdown-user'
createUser({ id: userId, email: 'auto-memory-shutdown@example.invalid' })
const prompt = 'This project uses SQLite and TypeScript across sessions.'
const reply = 'The complete chat response remains saved.'
let sequence = 0

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function memoryResponse(title) {
  return JSON.stringify({ memories: [
    { type: 'project', title, body: 'The project uses SQLite and TypeScript.', confidence: 0.95 },
  ] })
}

async function completedEngine(t, options = {}) {
  const id = ++sequence
  const scope = { userId, sessionId: `memory-shutdown-session-${id}`, turnId: `memory-shutdown-turn-${id}` }
  upsertSession({ id: scope.sessionId, userId, title: 'Optional memory lifecycle' })
  const engine = new TurnEngine({
    persistence: createTestTurnEnginePersistence(),
    toolSpecs: [],
    preparePromptContext: async () => ({ messages: [], skillIds: [], memoryIds: [] }),
    runLoop: async () => ({ text: reply, artifactIds: [], iterations: 0 }),
    dispatchHooks: async () => ({ allow: true }),
    ...options,
  })
  t.after(() => engine.shutdown())
  await engine.startTurn({ ...scope, content: prompt })
  await engine.waitForTurn(scope)
  assert.equal((await engine.getTurn(scope)).status, 'completed')
  return { engine, scope }
}

function assertChatRetained(scope) {
  const messages = listMessages({ userId, sessionId: scope.sessionId, limit: 100 })
  assert.ok(messages.some((message) => message.role === 'user' && message.content === prompt))
  assert.ok(messages.some((message) => message.role === 'assistant' && message.content === reply))
}

test('aborted and cancelled queued extraction never starts a model request', async () => {
  const controller = new AbortController()
  let calls = 0
  const options = { userId, messages: [{ role: 'user', content: prompt }],
    assistantText: reply, signal: controller.signal, callModel: async () => { calls += 1; return '{}' } }
  scheduleAutoMemoryExtraction(options)
  controller.abort()
  scheduleAutoMemoryExtraction(options)
  await nextImmediate()
  const skipped = await extractAndStoreAutoMemories(options)
  assert.equal(calls, 0)
  assert.equal(skipped.attempted, false)
})

test('engine shutdown cancels queued memory but retains chat and explicit remember', async (t) => {
  let calls = 0
  const { engine, scope } = await completedEngine(t, {
    runMemoryModel: async () => { calls += 1; return memoryResponse('must not be queued') },
  })
  await engine.shutdown()
  await nextImmediate()
  assert.equal(calls, 0)
  assertChatRetained(scope)
  const explicit = dispatchMemoryTool('remember', {
    type: 'project', title: 'Explicit memory remains available', body: 'The project uses SQLite.',
  }, scope)
  assert.equal(explicit.ok, true)
})

test('running web-style engine still extracts automatic memories after completion', async (t) => {
  const started = deferred()
  const response = deferred()
  let modelSignal
  const title = 'Web automatic memory remains enabled'
  const { engine, scope } = await completedEngine(t, {
    runMemoryModel: ({ signal }) => { modelSignal = signal; started.resolve(); return response.promise },
  })
  await started.promise
  assert.equal(modelSignal.aborted, false)
  response.resolve(memoryResponse(title))
  await nextImmediate()
  assert.ok(listMemories({ userId }).some((memory) => memory.title === title
    && memory.frontmatter.source === 'auto_chat' && memory.sourceSessionId === scope.sessionId))
  assertChatRetained(scope)
  await engine.shutdown()
  assert.equal(modelSignal.aborted, true)
})

test('shutdown aborts in-flight memory and rejects a late adapter result without writes', async (t) => {
  const started = deferred()
  const response = deferred()
  let modelSignal
  let aborted = false
  const title = 'Late cancelled memory must never be stored'
  const { engine, scope } = await completedEngine(t, {
    runMemoryModel: ({ signal }) => {
      modelSignal = signal
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      started.resolve()
      // Deliberately ignore cancellation to verify the persistence fence too.
      return response.promise
    },
  })
  await started.promise
  await engine.shutdown()
  assert.equal(modelSignal.aborted, true)
  assert.equal(aborted, true)
  response.resolve(memoryResponse(title))
  await nextImmediate()
  assert.equal(listMemories({ userId }).some((memory) => memory.title === title), false)
  assertChatRetained(scope)
})

test('an old scheduled callback cannot send a new request after engine shutdown', async (t) => {
  let scheduled
  let calls = 0
  const { engine } = await completedEngine(t, {
    scheduleMemoryExtraction: (options) => { scheduled = options },
    runMemoryModel: async () => { calls += 1; return '{}' },
  })
  assert.equal(scheduled.signal.aborted, false)
  await engine.shutdown()
  assert.equal(scheduled.signal.aborted, true)
  await assert.rejects(async () => scheduled.callModel({ messages: [] }), { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('memory abort listeners share the already-published engine shutdown barrier', async (t) => {
  let scheduled
  const { engine } = await completedEngine(t, {
    scheduleMemoryExtraction: (options) => { scheduled = options },
  })
  let reentrantClose
  scheduled.signal.addEventListener('abort', () => { reentrantClose = engine.shutdown() }, { once: true })
  const closing = engine.shutdown()
  assert.strictEqual(reentrantClose, closing)
  await closing
})
