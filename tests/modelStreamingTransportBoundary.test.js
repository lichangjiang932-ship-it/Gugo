import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { callStreamingModelWithTools } from '../server/adapters/modelProxy.js'
import { streamModelProviderEvents } from '../server/adapters/modelStreamingTransport.js'

const sourceUrl = new URL('../server/adapters/modelStreamingTransport.js', import.meta.url)

test('model streaming transport stays below session, database, middleware, and service boundaries', () => {
  const source = fs.readFileSync(sourceUrl, 'utf8')
  for (const forbidden of [
    "from '../db.js'",
    "from '../middleware.js'",
    "from '../services/",
    "from './modelProxy.js'",
  ]) {
    assert.equal(source.includes(forbidden), false, `transport imports privileged boundary: ${forbidden}`)
  }
})

test('model streaming transport requires its request builder dependency explicitly', async () => {
  const stream = streamModelProviderEvents({})
  await assert.rejects(
    stream.next(),
    (error) => error instanceof TypeError
      && error.message === 'streamModelProviderEvents requires buildRequest',
  )
})

function failoverEnabledEnv() {
  return {
    MODEL_NAME: 'shared-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'primary-secret',
    MODEL_PROVIDER_PRIMARY_MODELS: 'shared-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'backup-secret',
    MODEL_PROVIDER_BACKUP_MODELS: 'shared-model',
    MODEL_FAILOVER_CROSS_PROVIDER: '1',
  }
}

test('tracked streaming 503 is sent once without retry or provider failover', async () => {
  const urls = []
  await assert.rejects(
    () => callStreamingModelWithTools({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      modelRequestId: 'mr_streaming_503_once',
      env: failoverEnabledEnv(),
      fetchImpl: async (url) => {
        urls.push(String(url))
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      },
    }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.modelRequestId === 'mr_streaming_503_once'
      && error?.upstreamStatus === 503,
  )

  assert.equal(urls.length, 1)
  assert.match(urls[0], /^https:\/\/primary\.example\//u)
})

test('tracked stream EOF before the first provider event is not a successful empty response', async () => {
  let fetchCalls = 0
  await assert.rejects(
    () => callStreamingModelWithTools({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      modelRequestId: 'mr_streaming_empty_once',
      env: failoverEnabledEnv(),
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response(new ReadableStream({
          start(controller) {
            controller.close()
          },
        }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.modelRequestId === 'mr_streaming_empty_once'
      && error?.cause?.code === 'MODEL_STREAM_TRUNCATED',
  )

  assert.equal(fetchCalls, 1)
})

test('stream EOF after a complete-looking tool call is marked truncated', async () => {
  const result = await callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'write it' }],
    tools: [{
      type: 'function',
      function: { name: 'write_file', parameters: { type: 'object' } },
    }],
    env: failoverEnabledEnv(),
    fetchImpl: async () => new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-eof","function":{"name":"write_file","arguments":"{\\"path\\":\\"result.txt\\",\\"content\\":\\"complete-looking\\"}"}}]}}]}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  })

  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.finishReason, 'truncated')
})
