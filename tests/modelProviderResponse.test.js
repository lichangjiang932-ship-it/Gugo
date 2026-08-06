import test from 'node:test'
import assert from 'node:assert/strict'

import { parseModelProviderResponse } from '../server/adapters/modelProxy.js'

test('parseModelProviderResponse removes complete embedded think blocks from compatible responses', () => {
  const parsed = parseModelProviderResponse({
    choices: [{
      message: {
        content: '<think>private chain of thought</think>\nFinal grounded answer.',
        tool_calls: [],
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })

  assert.equal(parsed.content, 'Final grounded answer.')
  assert.equal(parsed.content.includes('private chain of thought'), false)
  assert.equal(parsed.content.includes('<think>'), false)
  assert.equal(parsed.content.includes('</think>'), false)
  assert.equal(parsed.finishReason, 'stop')
  assert.equal(parsed.usage.totalTokens, 14)
})

test('parseModelProviderResponse removes orphaned closing think traces from native responses', () => {
  const parsed = parseModelProviderResponse({
    content: [{
      type: 'text',
      text: 'stale internal transcript\n</think>\nPublic answer from the model.',
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 5 },
  }, { kind: 'anthropic' })

  assert.equal(parsed.content, 'Public answer from the model.')
  assert.equal(parsed.content.includes('stale internal transcript'), false)
  assert.equal(parsed.content.includes('<think>'), false)
  assert.equal(parsed.content.includes('</think>'), false)
  assert.equal(parsed.finishReason, 'stop')
  assert.equal(parsed.usage.totalTokens, 13)
})
