import test from 'node:test'
import assert from 'node:assert/strict'

import { readModelSseLines } from '../server/adapters/modelResponseStream.js'
import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'

function fixtureStream({ closed = false, cancelError = null, frames = 'data: [DONE]\n\n' } = {}) {
  let cancellations = 0
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      if (closed) controller.close()
    },
    cancel() { cancellations += 1; if (cancelError) throw cancelError },
  })
  return { body, cancellations: () => cancellations }
}

test('leaving an SSE reader on a terminal line cancels an otherwise open response and releases its lock', async () => {
  const fixture = fixtureStream()
  for await (const line of readModelSseLines(fixture.body.getReader())) {
    if (line === 'data: [DONE]') break
  }
  assert.equal(fixture.cancellations(), 1)
  assert.equal(fixture.body.locked, false)
})

test('natural SSE EOF releases the reader without cancelling an already finished source', async () => {
  const fixture = fixtureStream({ closed: true })
  const lines = []
  for await (const line of readModelSseLines(fixture.body.getReader())) lines.push(line)
  assert.ok(lines.includes('data: [DONE]'))
  assert.equal(fixture.cancellations(), 0)
  assert.equal(fixture.body.locked, false)
})

test('SSE cleanup cannot replace a provider parsing failure with its own cancellation error', async () => {
  const fixture = fixtureStream({ cancelError: new Error('cleanup failed') })
  const providerError = new Error('provider parser rejected a frame')
  await assert.rejects(async () => {
    for await (const line of readModelSseLines(fixture.body.getReader())) {
      if (line) throw providerError
    }
  }, (error) => error === providerError)
  assert.equal(fixture.cancellations(), 1)
  assert.equal(fixture.body.locked, false)
})

test('an active SSE stream is not disposed while its owner continues reading', async () => {
  const fixture = fixtureStream({ frames: 'data: {"content":"ongoing"}\n\n' })
  const iterator = readModelSseLines(fixture.body.getReader())
  assert.equal((await iterator.next()).value, 'data: {"content":"ongoing"}')
  assert.equal(fixture.cancellations(), 0)
  assert.equal(fixture.body.locked, true)
  await iterator.return()
  assert.equal(fixture.cancellations(), 1)
  assert.equal(fixture.body.locked, false)
})

test('a tracked model response stays completed when terminal cleanup rejects', async () => {
  const fixture = fixtureStream({ cancelError: new Error('cleanup failed'), frames: [
    'data: {"choices":[{"delta":{"content":"Complete."}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('') })
  const result = await callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'Answer once.' }], tools: [], modelRequestId: 'cleanup-tracked',
    env: { MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'cleanup-fixture' },
    fetchImpl: async () => new Response(fixture.body, { headers: { 'content-type': 'text/event-stream' } }),
  })
  assert.equal(result.content, 'Complete.')
  assert.equal(result.finishReason, 'stop')
  assert.equal(fixture.cancellations(), 1)
  assert.equal(fixture.body.locked, false)
})
