import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callBackgroundModel, callBackgroundModelWithTools, callStreamingModelWithTools,
} from '../server/adapters/modelInvocationRuntime.js'
import { streamOpenAICompatible } from '../server/adapters/modelProxyResponseCoordinator.js'
import { resetUsageStats } from '../server/adapters/modelUsage.js'

const CONFIG = { baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1', apiKey: 'fixture-only' }
const ENV = { MODEL_BASE_URL: CONFIG.baseUrl, MODEL_NAME: CONFIG.modelName, MODEL_API_KEY: CONFIG.apiKey }
const MESSAGES = [{ role: 'system', content: 'Stable fixture instructions.' }, { role: 'user', content: 'Reply with the fixture answer.' }]
const USAGE = { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } }

function fixtureResponse(stream) {
  if (!stream) return new Response(JSON.stringify({ choices: [{ message: { content: 'Fixture answer' }, finish_reason: 'stop' }], usage: USAGE }), { headers: { 'content-type': 'application/json' } })
  const frames = [
    { choices: [{ delta: { content: 'Fixture answer' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(`${frames}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}

test('real invocation paths carry a stable authenticated usage owner without exposing the raw owner', async () => {
  const requests = []
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body)
    requests.push(request)
    return fixtureResponse(request.stream)
  }
  const options = { messages: MESSAGES, userId: null, usageOwnerId: 'invocation-cache-owner', env: ENV, fetchImpl }
  try {
    assert.equal(await callBackgroundModel(options), 'Fixture answer')
    const background = await callBackgroundModelWithTools(options)
    const streaming = await callStreamingModelWithTools(options)
    assert.equal(background.usage.cacheCreationTokens, 100)
    assert.equal(streaming.usage.cacheCreationTokens, 100)
    assert.equal(streaming.usage.uncachedInputTokens, 100)
    assert.equal(requests.length, 3)
    assert.deepEqual(requests.map((request) => request.stream), [false, false, true])
    const keys = requests.map((request) => request.prompt_cache_key)
    assert.match(keys[0], /^gugo-v1-[A-Za-z0-9_-]{43}$/u)
    assert.equal(new Set(keys).size, 1)
    assert.equal(requests.some((request) => JSON.stringify(request).includes(options.usageOwnerId)), false)
    await callBackgroundModel({ ...options, usageOwnerId: 'other-invocation-owner' })
    assert.notEqual(requests.at(-1).prompt_cache_key, keys[0])
  } finally {
    resetUsageStats({ ownerId: options.usageOwnerId })
    resetUsageStats({ ownerId: 'other-invocation-owner' })
  }
})

test('non-stream transport fallback keeps the same cache owner and real write counters', async () => {
  const requests = []
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { ...CONFIG, profileOverrides: { supportsStreaming: false } },
    messages: MESSAGES, cacheOwnerId: 'fallback-cache-owner', env: {},
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body)
      requests.push(request)
      return fixtureResponse(false)
    },
  })) events.push(event)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].stream, false)
  assert.match(requests[0].prompt_cache_key, /^gugo-v1-[A-Za-z0-9_-]{43}$/u)
  assert.equal(events.at(-1).usage.cacheCreationTokens, 100)
  assert.equal(events.at(-1).usage.uncachedInputTokens, 100)
})
