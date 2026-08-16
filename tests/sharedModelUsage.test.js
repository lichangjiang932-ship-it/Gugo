import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeModelUsage, promptTokensFromUsage } from '../shared/modelUsage.js'

test('model usage requires a non-empty prompt token value', () => {
  for (const promptTokens of [null, undefined, '', '   ', false]) {
    assert.equal(normalizeModelUsage({ promptTokens }), null)
    assert.equal(promptTokensFromUsage({ promptTokens }), null)
  }
})

test('model usage preserves a real zero and normalizes optional counters', () => {
  assert.deepEqual(normalizeModelUsage({
    promptTokens: 0,
    completionTokens: '12.9',
    totalTokens: null,
    cacheHitTokens: '',
    cacheCreationTokens: '7.9',
    uncachedInputTokens: 3,
    costUsd: '0.25',
  }), {
    promptTokens: 0,
    completionTokens: 12,
    cacheCreationTokens: 7,
    uncachedInputTokens: 3,
    costUsd: 0.25,
  })
  assert.equal(promptTokensFromUsage({ promptTokens: 0 }), 0)
})
