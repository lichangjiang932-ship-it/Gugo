import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'

const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }
const frame = (delta, finishReason = null) => ({ choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })

async function controlledCall(t, { native = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { requests: [], progress: [], ready: [], text: [], reasoning: [], retries: [], failovers: [], settled: false }
  let streamController
  let detachSignal = () => {}
  let streamClosed = false
  const completion = callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'Read the requested file.' }], tools: [tool],
    modelRequestId: 'mr_progress_test',
    env: native ? {
      MODEL_BASE_URL: 'https://api.anthropic.com', MODEL_API_KEY: 'fixture', MODEL_NAME: 'claude-sonnet-4-5',
      MODEL_FIRST_TOKEN_TIMEOUT_MS: '1500', MODEL_IDLE_TIMEOUT_MS: '1000',
    } : {
      MODEL_NAME: 'shared-model', MODEL_PROVIDERS: 'primary,backup',
      MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1', MODEL_PROVIDER_PRIMARY_API_KEY: 'fixture-primary',
      MODEL_PROVIDER_PRIMARY_MODELS: 'shared-model', MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
      MODEL_PROVIDER_BACKUP_API_KEY: 'fixture-backup', MODEL_PROVIDER_BACKUP_MODELS: 'shared-model',
      MODEL_FAILOVER_CROSS_PROVIDER: '1', MODEL_FIRST_TOKEN_TIMEOUT_MS: '1500', MODEL_IDLE_TIMEOUT_MS: '1000',
    },
    fetchImpl: async (url, init) => {
      state.requests.push(String(url))
      assert.equal(state.requests.length, 1, 'an accepted tracked request must never retry or fail over')
      return new Response(new ReadableStream({
        start(controller) {
          streamController = controller
          const abort = () => {
            if (streamClosed) return
            streamClosed = true
            controller.error(new DOMException('fixture stream aborted', 'AbortError'))
          }
          init.signal.addEventListener('abort', abort, { once: true })
          detachSignal = () => init.signal.removeEventListener('abort', abort)
          if (init.signal.aborted) abort()
        },
        cancel() { streamClosed = true; detachSignal() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
    onToolCallProgress: (progress) => state.progress.push(progress),
    onToolCallReady: (call) => state.ready.push(call),
    onTextDelta: (delta) => state.text.push(delta), onReasoningDelta: (delta) => state.reasoning.push(delta),
    onRetry: (event) => state.retries.push(event), onFailover: (event) => state.failovers.push(event),
  }).then((result) => { state.settled = true; return { result } }, (error) => { state.settled = true; return { error } })
  await nextTurn()
  assert.ok(streamController)
  t.after(() => {
    detachSignal()
    if (!streamClosed) { streamClosed = true; streamController.close() }
  })
  return {
    state, completion,
    async send(payload) {
      assert.equal(streamClosed, false)
      const line = typeof payload === 'string' ? payload : `data: ${JSON.stringify(payload)}\n\n`
      streamController.enqueue(new TextEncoder().encode(line))
      await nextTurn()
    },
    async advance(ms) { t.mock.timers.tick(ms); await nextTurn() },
  }
}

function assertUnknown(outcome, phase, state) {
  assert.equal(outcome.result, undefined)
  assert.equal(outcome.error?.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(outcome.error?.timeoutPhase, phase)
  assert.equal(outcome.error?.modelRequestId, 'mr_progress_test')
  assert.equal(outcome.error?.unsafeToReplay, true)
  assert.equal(outcome.error?.retryable, false)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.retries, [])
  assert.deepEqual(state.failovers, [])
}

test('comments, empty SSE fields, role, usage, and whitespace cannot renew the first substantive-token deadline', async (t) => {
  const call = await controlledCall(t)
  await call.send(': keepalive\n\ndata:\n\n')
  await call.advance(400)
  await call.send(frame({ role: 'assistant' }))
  await call.advance(400)
  await call.send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } })
  await call.advance(400)
  await call.send(frame({ content: '  ', reasoning_content: '\n' }))
  assert.equal(call.state.settled, false)
  await call.advance(301)
  assertUnknown(await call.completion, 'first_token', call.state)
  assert.deepEqual(call.state.progress, [])
  assert.deepEqual(call.state.ready, [])
})

test('keepalives after real output cannot renew the substantive-output idle deadline', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Started.' }))
  for (let index = 0; index < 3; index += 1) {
    await call.advance(300)
    await call.send(': keepalive\n\n')
    await call.send(frame({ role: 'assistant', content: ' ' }))
  }
  assert.equal(call.state.settled, false)
  await call.advance(101)
  assertUnknown(await call.completion, 'idle', call.state)
})

test('ongoing text and reasoning may outlive the idle timeout without a total-request deadline', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ reasoning_content: 'Inspecting.' }))
  await call.advance(900)
  await call.send(frame({ reasoning_content: 'Checking.' }))
  await call.advance(900)
  await call.send(frame({ content: 'Read ' }))
  await call.advance(900)
  await call.send(frame({ content: 'complete.' }))
  await call.advance(900)
  await call.send(frame({}, 'stop'))
  const outcome = await call.completion
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.result.content, 'Read complete.')
  assert.equal(outcome.result.finishReason, 'stop')
  assert.deepEqual(call.state.reasoning, ['Inspecting.', 'Checking.'])
})

test('partial tool arguments renew idle and emit only counts while the canonical batch remains pending', async (t) => {
  const call = await controlledCall(t)
  const partials = ['{"path":', '"private-', 'fixture.txt"}']
  for (const [index, argumentsDelta] of partials.entries()) {
    if (index) await call.advance(900)
    await call.send(frame({ tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call-args' } : {}),
      function: { ...(index === 0 ? { name: 'read_file' } : {}), arguments: argumentsDelta } }] }))
    assert.equal(call.state.progress.length, index + 1)
    assert.equal(call.state.settled, false, 'partial or ready inputs do not finish the model invocation')
    assert.equal(call.state.ready.length, index === 2 ? 1 : 0)
  }
  assert.deepEqual(call.state.progress.map((progress) => progress.toolArgumentsChars), [8, 17, 30])
  assert.ok(call.state.progress.every((progress) => Object.keys(progress).sort().join(',') === 'toolArgumentsChars,toolCallId,toolName'))
  assert.equal(JSON.stringify(call.state.progress).includes('private-'), false)
  await call.advance(900)
  await call.send(frame({}, 'tool_calls'))
  const outcome = await call.completion
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.result.toolCalls.length, 1)
  assert.equal(outcome.result.toolCalls[0].function.arguments, partials.join(''))
  assert.equal(outcome.result.finishReason, 'tool_calls')
})

test('buffered tool arguments can pause beyond the old idle deadline and complete on the same request', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ tool_calls: [{ index: 0, id: 'buffered-file',
    function: { name: 'read_file', arguments: '{"path":"buffered-' } }] }))
  await call.advance(1600)
  assert.equal(call.state.settled, false, 'the old 1000ms deadline must not cut off a progressing argument buffer')
  assert.equal(call.state.ready.length, 0)
  await call.send(frame({ tool_calls: [{ index: 0, function: { arguments: 'file.txt"}' } }] }))
  await call.advance(1600)
  assert.equal(call.state.settled, false)
  await call.send(frame({}, 'tool_calls'))
  const outcome = await call.completion
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.result.toolCalls[0].function.arguments, '{"path":"buffered-file.txt"}')
  assert.equal(call.state.requests.length, 1, 'waiting for the existing stream must not submit a replacement request')
  assert.deepEqual(call.state.retries, [])
})

test('argument idle grace remains bounded and keepalives cannot mask a permanently stalled generation', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ tool_calls: [{ index: 0, id: 'stalled-file',
    function: { name: 'read_file', arguments: '{"path":"' } }] }))
  for (let index = 0; index < 5; index += 1) {
    await call.advance(500)
    await call.send(': keepalive\n\n')
  }
  assert.equal(call.state.settled, false)
  await call.advance(501)
  const outcome = await call.completion
  assertUnknown(outcome, 'idle', call.state)
  assert.equal(outcome.error.timeoutMs, 3000)
  assert.equal(call.state.ready.length, 0)
})

test('Anthropic input_json_delta progress keeps an incomplete native call alive without duplicate execution evidence', async (t) => {
  const call = await controlledCall(t, { native: true })
  await call.send({ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'toolu-progress', name: 'read_file', input: {} } })
  for (const [index, partial] of ['{"path":', '"native-', 'fixture.txt"}'].entries()) {
    if (index) await call.advance(900)
    await call.send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })
    assert.equal(call.state.progress.length, index + 1)
    assert.equal(call.state.ready.length, 0)
    assert.equal(call.state.settled, false)
  }
  await call.advance(900)
  await call.send({ type: 'content_block_stop', index: 0 })
  assert.equal(call.state.progress.length, 3, 'a repeated complete snapshot is not new argument progress')
  assert.equal(call.state.ready.length, 1)
  await call.send({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  await call.send({ type: 'message_stop' })
  const outcome = await call.completion
  assert.equal(outcome.error, undefined)
  assert.equal(outcome.result.toolCalls.length, 1)
  assert.equal(outcome.result.toolCalls[0].function.arguments, '{"path":"native-fixture.txt"}')
})
