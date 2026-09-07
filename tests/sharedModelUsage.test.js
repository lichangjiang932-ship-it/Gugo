import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeModelUsage, normalizeOptionalUsageNumber, promptTokensFromUsage } from '../shared/modelUsage.js'

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

test('usage numbers accept only finite numbers or non-empty numeric strings without object coercion', () => {
  let coercions = 0
  const values = [
    [], [0], {}, Object(0), new Date(0), true, false, 0n, Symbol('usage'), () => 0,
    { valueOf() { coercions += 1; return 0 } },
    { [Symbol.toPrimitive]() { coercions += 1; return '0' } },
    null, undefined, '', '  ', NaN, Infinity, -1, 'NaN', 'Infinity', '-1', 'not numeric',
  ]
  for (const [index, value] of values.entries()) {
    assert.equal(normalizeOptionalUsageNumber(value), null, `case ${index}`)
    assert.equal(normalizeModelUsage({ promptTokens: value }), null, `prompt case ${index}`)
    assert.deepEqual(normalizeModelUsage({ promptTokens: 100, cacheHitTokens: value, cacheCreationTokens: value, costUsd: value }), { promptTokens: 100 })
  }
  assert.equal(coercions, 0, 'untrusted objects must never execute conversion methods')
  for (const [value, expected] of [[0, 0], ['0', 0], [' 0 ', 0], [7.9, 7.9], ['7.9', 7.9], ['1e3', 1000]]) {
    assert.equal(normalizeOptionalUsageNumber(value), expected)
  }
})
