import test from 'node:test'
import assert from 'node:assert/strict'

import { createLoopContext } from '../server/services/loop/context.js'
import { prepareToolsLoopRuntime, usePreparedToolsLoopRuntime as accessPreparedToolsLoopRuntime } from '../server/services/loop/runtime.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function prepareState(runModel, onModelPhase) {
  const checkpoints = []
  const context = createLoopContext({
    job: { id: 'model-progress-turn', userId: 'model-progress-user', sessionId: 'model-progress-session',
      origin: 'chat', prompt: 'Answer once.', modelName: 'fixture-model', modelProviderId: 'fixture-provider', modelConfigRevision: 1 },
    step: { id: 'model-progress-turn', kind: 'chat' }, messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [], maxIters: 1, modelHeartbeatIntervalMs: 0, runModel, onModelPhase,
    saveCheckpoint: async (state, meta = {}) => { checkpoints.push({ state: structuredClone(state), meta }); return true },
  })
  const prepared = await prepareToolsLoopRuntime(context)
  let state
  accessPreparedToolsLoopRuntime(prepared, (value) => { state = value })
  return { state, checkpoints }
}

function invoke(state, options = {}) {
  return state.callTrackedModel({ messages: state.convo, tools: [], toolChoice: 'none', allowOverBudget: false, ...options })
}

test('tracked progress wiring ignores blank content, forwards safe argument metadata, and stops after the request', async () => {
  const phases = []
  const text = []
  let lateProgress
  const { state } = await prepareState(async (request) => {
    await request.onTextDelta(' \n')
    await request.onReasoningDelta('\t')
    assert.deepEqual(phases.map((event) => event.phase), ['started', 'waiting_first_token'])
    await request.onToolCallProgress({ toolName: 'read_file', toolCallId: 'call-progress', toolArgumentsChars: 4,
      arguments: 'private-partial-input', reasoning: 'private-thought' })
    assert.equal(phases.at(-1).phase, 'tool_arguments')
    lateProgress = request.onToolCallProgress
    return { content: 'Done.', toolCalls: [] }
  }, (event) => phases.push(event))
  await invoke(state, { onTextDelta: (delta) => text.push(delta) })
  assert.deepEqual(text, [' \n'], 'ignoring whitespace for liveness does not rewrite the model output')
  assert.equal(phases.at(-1).toolArgumentsChars, 4)
  assert.equal(JSON.stringify(phases).includes('private-'), false)
  const count = phases.length
  await lateProgress({ toolName: 'read_file', toolCallId: 'call-progress', toolArgumentsChars: 5 })
  assert.equal(phases.length, count, 'callbacks retained by a provider cannot revive a stopped heartbeat')
})

test('revoked tracked requests reject late argument progress before appending a durable phase or checkpoint', async () => {
  const started = deferred()
  const response = deferred()
  const phases = []
  let reportProgress
  const { state, checkpoints } = await prepareState(async (request) => {
    reportProgress = request.onToolCallProgress
    started.resolve()
    return response.promise
  }, (event) => phases.push(event))
  let active = true
  const revoked = Object.assign(new Error('fixture request lease revoked'), { code: 'TRACKED_MODEL_REQUEST_REVOKED' })
  const pending = invoke(state, { assertRequestActive() { if (!active) throw revoked } })
  const rejected = assert.rejects(pending, (error) => error === revoked)
  await started.promise
  const phaseCount = phases.length
  active = false
  await assert.rejects(() => reportProgress({ toolName: 'read_file', toolCallId: 'call-progress', toolArgumentsChars: 5 }),
    (error) => error === revoked)
  response.resolve({ content: 'Too late.', toolCalls: [] })
  await rejected
  assert.equal(phases.length, phaseCount)
  assert.deepEqual(checkpoints.map(({ meta }) => meta.boundary), ['model-request'])
  assert.equal(state.modelInvocation.status, 'in_flight')
})
