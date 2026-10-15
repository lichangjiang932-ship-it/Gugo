import assert from 'node:assert/strict'
import test from 'node:test'
import * as usage from '../src/lib/contextUsage.js'

test('immutable message and tool estimates are reused without stale streaming or model-window values', () => {
  assert.equal(typeof usage.createContextUsageEstimator, 'function')
  const estimate = usage.createContextUsageEstimator()
  const messages = Array.from({ length: 1000 }, (_, index) => Object.freeze({ role: index % 2 ? 'assistant' : 'user', content: `message ${index}` }))
  const tools = Object.freeze([{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }])
  const options = { messages, tools, systemPrompt: 'A stable system prompt', contextWindow: 128000 }
  assert.deepEqual(estimate(options), usage.estimateClientContextUsage(options))
  const first = estimate.stats()
  assert.deepEqual(estimate(options), usage.estimateClientContextUsage(options))
  assert.deepEqual(estimate.stats(), first, 'a repeated snapshot does not re-parse unchanged payloads')
  const next = { ...options, messages: [...messages.slice(0, -1), { ...messages.at(-1), content: 'new streaming text' }], contextWindow: 64000, actualPromptTokens: 4000 }
  assert.deepEqual(estimate(next), usage.estimateClientContextUsage(next))
  assert.equal(estimate.stats().messagesComputed, first.messagesComputed + 1)
  assert.equal(estimate.stats().toolsComputed, first.toolsComputed)
  assert.deepEqual(estimate({ ...next, tools: [] }), usage.estimateClientContextUsage({ ...next, tools: [] }))
})
