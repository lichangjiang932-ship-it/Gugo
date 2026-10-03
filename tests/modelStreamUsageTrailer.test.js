import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'
import { runToolLoop } from '../server/services/loop/index.js'

const usage = { prompt_tokens: 14, completion_tokens: 64, total_tokens: 78 }
const expectedUsage = { promptTokens: 14, completionTokens: 64, totalTokens: 78 }
const frame = (delta = {}, finish_reason = null) => ({ choices: [{ delta, finish_reason }] })
const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }

async function controlledCall(t, { requested = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController()
  const state = { settled: false, calls: 0, cancelled: 0, text: [], ready: [], retries: [] }
  let source
  let detach = () => {}
  let closed = false
  const completion = callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'Answer once.' }], tools: [tool], signal: abort.signal,
    modelRequestId: 'mr_usage_trailer',
    env: { MODEL_BASE_URL: 'http://127.0.0.1:1234/v1', MODEL_NAME: 'fixture-model',
      MODEL_STREAM_USAGE: requested ? '1' : '0', MODEL_FIRST_TOKEN_TIMEOUT_MS: '1500', MODEL_IDLE_TIMEOUT_MS: '1000' },
    fetchImpl: async (_url, init) => {
      state.calls += 1
      assert.equal(JSON.parse(init.body).stream_options?.include_usage === true, requested)
      return new Response(new ReadableStream({
        start(controller) {
          source = controller
          const onAbort = () => {
            if (closed) return
            closed = true
            controller.error(new DOMException('cancelled', 'AbortError'))
          }
          init.signal.addEventListener('abort', onAbort, { once: true })
          detach = () => init.signal.removeEventListener('abort', onAbort)
        },
        cancel() { state.cancelled += 1; closed = true; detach() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
    onTextDelta: (delta) => state.text.push(delta),
    onToolCallReady: (call) => state.ready.push(call),
    onRetry: (event) => state.retries.push(event),
  }).then((result) => { state.settled = true; return { result } }, (error) => { state.settled = true; return { error } })
  await nextTurn()
  t.after(() => { detach(); if (!closed) { closed = true; source.close() } })
  return {
    state, abort, completion,
    async send(...payloads) {
      source.enqueue(new TextEncoder().encode(payloads.map((payload) => typeof payload === 'string'
        ? payload : `data: ${JSON.stringify(payload)}\n\n`).join('')))
      await nextTurn()
    },
    async advance(ms) { t.mock.timers.tick(ms); await nextTurn() },
    async fail() { closed = true; source.error(new Error('trailer reset')); await nextTurn() },
  }
}

test('Chat Completions usage after finish_reason reaches the canonical result without inventing cache hits', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'), { choices: [], usage }, 'data: [DONE]\n\n')
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.content, 'Complete.')
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(result.usage, expectedUsage)
  assert.equal(result.usage.cacheHitTokens, undefined)
  assert.equal(call.state.calls, 1)
  assert.equal(call.state.cancelled, 1)
})

test('tool terminal collects only usage and cannot accept tool or text deltas after completion', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ tool_calls: [{ index: 0, id: 'original', function: { name: 'read_file', arguments: '{"path":"safe.txt"}' } }] }),
    frame({}, 'tool_calls'), { choices: [], usage },
    frame({ content: 'late text', tool_calls: [{ index: 1, id: 'late', function: { name: 'write_file', arguments: '{}' } }] }),
    'data: [DONE]\n\n')
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.usage, expectedUsage)
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].id, 'original')
  assert.equal(call.state.ready.length, 1)
  assert.deepEqual(call.state.text, [])
})

test('a missing usage trailer has a fixed deadline that keepalives cannot renew', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'))
  assert.equal(call.state.settled, false, 'allow a separately delivered usage frame after finish_reason')
  await call.advance(600)
  await call.send(': keepalive\n\n')
  await call.advance(401)
  const { result, error } = await call.completion
  assert.equal(error, undefined, 'optional statistics cannot turn a verified terminal into an unknown outcome')
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage, null)
  assert.equal(call.state.cancelled, 1)
  assert.equal(call.state.calls, 1)
  assert.deepEqual(call.state.retries, [])
})

test('a stream reset after verified completion cannot retry the model for missing telemetry', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'))
  assert.equal(call.state.settled, false)
  await call.fail()
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage, null)
  assert.equal(call.state.calls, 1)
  assert.deepEqual(call.state.retries, [])
})

test('usage sent in a later HTTP chunk is still observed without changing a length terminal', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Partial answer.' }), frame({}, 'length'))
  assert.equal(call.state.settled, false)
  await call.advance(500)
  await call.send({ choices: [], usage })
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.finishReason, 'length')
  assert.deepEqual(result.usage, expectedUsage)
})

test('the trailer byte bound also stops an unterminated SSE line', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'))
  await call.send('data: ' + 'x'.repeat(70_000))
  assert.equal(call.state.settled, true)
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.usage, null)
  assert.equal(call.state.cancelled, 1)
})

test('cancellation during optional trailer reading keeps the known response and never replays it', async (t) => {
  const call = await controlledCall(t)
  await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'))
  assert.equal(call.state.settled, false)
  call.abort.abort()
  const { result, error } = await call.completion
  assert.equal(error, undefined)
  assert.equal(result.finishReason, 'stop')
  assert.equal(call.abort.signal.aborted, true, 'the runtime still owns cancellation and must not dispatch tools')
  assert.equal(call.state.calls, 1)
})

test('the real loop cannot approve or dispatch a known tool batch after trailer cancellation', async (t) => {
  const call = await controlledCall(t)
  let approvals = 0
  let executions = 0
  let modelCalls = 0
  const prompt = 'Read safe.txt with read_file.'
  const loop = runToolLoop({ job: { id: 'trailer-cancel', userId: 'trailer-user', origin: 'chat', prompt },
    step: { id: 'trailer-step', kind: 'chat' }, messages: [{ role: 'user', content: prompt }], toolSpecs: [tool],
    signal: call.abort.signal, enableToolHooks: false, maxIters: 2,
    runModel: async () => { modelCalls += 1; return (await call.completion).result },
    requestToolApproval: async () => { approvals += 1; return { proceed: true, approvalId: 'never' } },
    executeTool: async () => { executions += 1; return { ok: true, content: 'never' } },
  }).then((result) => ({ result }), (error) => ({ error }))
  await nextTurn()
  await call.send(frame({ tool_calls: [{ index: 0, id: 'cancelled', function: { name: 'read_file', arguments: '{"path":"safe.txt"}' } }] }),
    frame({}, 'tool_calls'))
  assert.equal(call.state.settled, false)
  call.abort.abort()
  const outcome = await loop
  assert.equal(outcome.error?.name, 'AbortError')
  assert.equal(approvals, 0)
  assert.equal(executions, 0)
  assert.equal(modelCalls, 1)
  assert.equal(call.state.calls, 1)
})

test('non-requested usage, Responses completion, and DONE do not wait for a trailer', async (t) => {
  for (const kind of ['disabled', 'responses', 'done']) {
    await t.test(kind, async (st) => {
      const call = await controlledCall(st, { requested: kind !== 'disabled' })
      await call.send(frame({ content: 'Complete.' }), kind === 'responses' ? { type: 'response.completed' }
        : kind === 'done' ? 'data: [DONE]\n\n' : frame({}, 'stop'))
      assert.equal(call.state.settled, true)
      assert.equal((await call.completion).result.finishReason, 'stop')
      assert.equal(call.state.cancelled, 1)
    })
  }
})

test('malformed or excess trailer frames do not reopen generation or fail verified output', async (t) => {
  for (const trailer of ['data: null\n\n', ': keepalive\n\n'.repeat(100), `data: ${'x'.repeat(70_000)}\n\n`]) {
    await t.test(`trailer-${trailer.length}`, async (st) => {
      const call = await controlledCall(st)
      await call.send(frame({ content: 'Complete.' }), frame({}, 'stop'), trailer)
      const { result, error } = await call.completion
      assert.equal(error, undefined)
      assert.equal(result.content, 'Complete.')
      assert.equal(result.finishReason, 'stop')
      assert.equal(result.usage, null)
      assert.equal(call.state.cancelled, 1)
    })
  }
})
