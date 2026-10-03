import assert from 'node:assert/strict'
import test from 'node:test'
import { callBackgroundModelWithTools, callStreamingModelWithTools } from '../server/adapters/modelProxy.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'
import { modelToolArgumentsIdleMs } from '../server/adapters/modelStreamTiming.js'
import { isRetryableError } from '../server/utils/modelRetry.js'

const messages = [{ role: 'user', content: 'Finish the requested file change.' }]
const tools = [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }]
const env = { MODEL_NAME: 'recovery-fixture', MODEL_BASE_URL: 'https://compatible.example/v1' }
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`

function interruptedBody() {
  const bytes = new TextEncoder().encode(frame({ content: 'Verified prefix. ' })
    + frame({ tool_calls: [{ index: 0, id: 'incomplete-call', function: { name: 'write_file', arguments: '{"path":"never.txt","content":"draft"}' } }] }))
  let reads = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(bytes)
      else controller.error(Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' }))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

test('generic HTTP timeout, gateway, server errors and error frames cannot prove a request was rejected', async () => {
  for (const status of [408, 500, 502, 503, 504, 529]) {
    let requests = 0
    await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: `mr-http-${status}`,
      fetchImpl: async () => { requests += 1; return new Response('gateway failure', { status }) },
    }), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' && error.unsafeToReplay === true && error.upstreamStatus === status)
    assert.equal(requests, 1)
  }
  let requests = 0
  await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-error-frame',
    fetchImpl: async () => { requests += 1; return new Response('data: {"error":{"message":"service unavailable"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) },
  }), (error) => error.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN' && error.unsafeToReplay === true)
  assert.equal(requests, 1)
})

test('public generation flags do not authorize replay or turn an unknown result into not_sent', () => {
  const forged = Object.assign(new Error('socket interrupted'), {
    code: 'MODEL_GENERATION_INTERRUPTED', modelRequestOutcome: 'interrupted',
    safeToRetryGeneration: true, retryable: true, explicitModelResponseError: true,
  })
  const error = modelRequestOutcomeUnknown(forged, { modelRequestId: 'mr-untrusted-flags', responseReceived: true })
  assert.equal(error.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.equal(error.unsafeToReplay, true)
  assert.equal(isRetryableError(error), false)
  const local = Object.assign(new Error('outbound policy denied before dispatch'), { code: 'OUTBOUND_BLOCKED' })
  assert.equal(modelRequestOutcomeUnknown(local, { modelRequestId: 'mr-pre-send', requestStarted: false }).modelRequestOutcome, 'not_sent')
})

test('an interrupted stream retains diagnostic text without executing or checkpointing an incomplete tool proposal as complete', async () => {
  const ready = []
  let requests = 0
  await assert.rejects(callStreamingModelWithTools({ messages, tools, env, modelRequestId: 'mr-partial',
    fetchImpl: async () => { requests += 1; return interruptedBody() }, onToolCallReady: (call) => ready.push(call),
  }), (error) => {
    assert.equal(error.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(error.upstreamCode, 'ECONNRESET')
    assert.equal(error.partialGeneration.content, 'Verified prefix. ')
    assert.equal(error.partialGeneration.toolCalls, undefined)
    assert.equal(error.partialModelResult, undefined)
    return true
  })
  assert.equal(requests, 1)
  assert.equal(ready.length, 1, 'ready is progress, not an executed tool or an authoritative terminal batch')
})

test('a confirmed structured rate-limit rejection can back off and complete in streaming and background modes', async () => {
  for (const invoke of [callStreamingModelWithTools, callBackgroundModelWithTools]) {
    let requests = 0
    const result = await invoke({ messages, tools, env, modelRequestId: 'mr-rate-retry',
      fetchImpl: async () => {
        requests += 1
        return requests === 1
          ? Response.json({ error: { code: 'rate_limit_exceeded', message: 'rate limit exceeded' } }, { status: 429, headers: { 'retry-after': '0' } })
          : Response.json({ choices: [{ message: { content: 'Completed.' }, finish_reason: 'stop' }] })
      },
    })
    assert.equal(result.content, 'Completed.')
    assert.equal(requests, 2)
  }
})

test('tool-argument idle grace stays finite without shortening explicitly longer deadlines', () => {
  assert.equal(modelToolArgumentsIdleMs(60_000), 180_000)
  assert.equal(modelToolArgumentsIdleMs(40), 120)
  assert.equal(modelToolArgumentsIdleMs(120_000), 360_000)
  assert.equal(modelToolArgumentsIdleMs(600_000), 600_000)
})
