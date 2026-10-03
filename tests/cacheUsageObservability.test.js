import assert from 'node:assert/strict'
import test from 'node:test'
import { extractUsage } from '../server/adapters/modelProviderResponse.js'
import { extractNativeProviderUsage } from '../server/adapters/nativeModelProviders.js'
import { getUsageStats, recordUsage, resetUsageStats } from '../server/adapters/modelUsage.js'

test('unknown cache reads remain absent while an explicitly reported zero remains measurable', () => {
  const unknown = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 5 } })
  assert.equal(Object.hasOwn(unknown, 'cacheHitTokens'), false)
  assert.equal(Object.hasOwn(unknown, 'cacheMissTokens'), false)
  const zero = extractUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } } })
  assert.equal(zero.cacheHitTokens, 0)
  assert.equal(zero.cacheMissTokens, 100)
  for (const cached of [-1, 'bad', null, true, 101]) {
    const invalid = extractUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: cached } } })
    assert.equal(Object.hasOwn(invalid, 'cacheHitTokens'), false, String(cached))
  }
})

test('array and object cache counters stay unknown in every provider and diagnostics path', () => {
  const ownerId = 'invalid-cache-counter-owner'
  let coercions = 0
  const counters = [[], [0], {}, Object(0), { valueOf() { coercions += 1; return 0 } }]
  resetUsageStats({ ownerId })
  try {
    for (const counter of counters) {
      const usages = [
        extractUsage({ usage: { input_tokens: 100, input_tokens_details: { cached_tokens: counter, cache_write_tokens: counter } } }),
        extractNativeProviderUsage({ usage: { input_tokens: 100, cache_read_input_tokens: counter, cache_creation_input_tokens: counter } }, 'anthropic'),
        extractNativeProviderUsage({ usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: counter } }, 'gemini'),
      ]
      for (const usage of usages) {
        for (const field of ['cacheHitTokens', 'cacheMissTokens', 'cacheCreationTokens']) {
          assert.equal(Object.hasOwn(usage, field), false, field)
        }
        recordUsage('invalid-counter-model', usage, { ownerId })
      }
    }
    const stats = getUsageStats({ ownerId })
    assert.equal(stats.cacheUsageReportedRequests, 0)
    assert.equal(stats.cacheUsageUnknownRequests, counters.length * 3)
    assert.equal(stats.cacheCreationReportedRequests, 0)
    assert.equal(stats.cacheHitRatePercent, null)
    assert.equal(stats.cacheUsageCoveragePercent, 0)
    assert.equal(coercions, 0)
  } finally {
    resetUsageStats({ ownerId })
  }
})

test('OpenAI Responses and Chat usage retain separate read, write and ordinary input counts', () => {
  for (const usage of [
    { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } },
    { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } },
  ]) {
    const expected = { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cacheHitTokens: 800, cacheMissTokens: 200, cacheCreationTokens: 100, uncachedInputTokens: 100 }
    assert.deepEqual(extractUsage({ usage }), expected)
    assert.deepEqual(extractUsage({ response: { usage } }), expected)
  }
  const withoutWrite = extractUsage({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 } } })
  assert.equal(Object.hasOwn(withoutWrite, 'cacheCreationTokens'), false)
  assert.equal(Object.hasOwn(withoutWrite, 'uncachedInputTokens'), false)
  const writeOnly = extractUsage({ usage: { input_tokens: 1000, input_tokens_details: { cache_write_tokens: 100 } } })
  assert.equal(writeOnly.cacheCreationTokens, 100)
  assert.equal(Object.hasOwn(writeOnly, 'cacheHitTokens'), false)
})

test('native provider usage distinguishes unreported cache reads and preserves Anthropic accounting', () => {
  const anthropic = extractNativeProviderUsage({ usage: { input_tokens: 100, output_tokens: 10 } }, 'anthropic')
  const gemini = extractNativeProviderUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }, 'gemini')
  for (const usage of [anthropic, gemini]) {
    assert.equal(usage.promptTokens, 100)
    assert.equal(Object.hasOwn(usage, 'cacheHitTokens'), false)
    assert.equal(Object.hasOwn(usage, 'cacheMissTokens'), false)
  }
  assert.equal(anthropic.uncachedInputTokens, 100)
  assert.equal(Object.hasOwn(anthropic, 'cacheCreationTokens'), false)
  assert.deepEqual(extractNativeProviderUsage({ usage: {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 100,
  } }, 'anthropic'), {
    promptTokens: 1000, completionTokens: 10, totalTokens: 1010,
    cacheHitTokens: 800, cacheMissTokens: 200, cacheCreationTokens: 100, uncachedInputTokens: 100,
  })
})

test('cache diagnostics report measured sample coverage instead of treating unknown reads as misses', () => {
  const ownerId = 'cache-observation-owner'
  resetUsageStats({ ownerId })
  const before = getUsageStats({ ownerId })
  assert.equal(before.cacheHitRatePercent, null)
  assert.equal(before.cacheUsageCoveragePercent, null)
  recordUsage('test-model', extractUsage({ usage: { input_tokens: 1000 } }), { ownerId })
  const unknown = getUsageStats({ ownerId })
  assert.equal(unknown.cacheHitRatePercent, null)
  assert.equal(unknown.cacheUsageReportedRequests, 0)
  assert.equal(unknown.cacheUsageUnknownRequests, 1)
  assert.equal(unknown.cacheUsageCoveragePercent, 0)
  recordUsage('test-model', extractUsage({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 } } }), { ownerId })
  assert.equal(getUsageStats({ ownerId }).cacheHitRatePercent, 0)
  recordUsage('test-model', extractUsage({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } } }), { ownerId })
  const stats = getUsageStats({ ownerId })
  assert.equal(stats.promptTokens, 3000)
  assert.equal(stats.cacheReportedPromptTokens, 2000)
  assert.equal(stats.cacheUsageReportedRequests, 2)
  assert.equal(stats.cacheUsageUnknownRequests, 1)
  assert.equal(stats.cacheUsageCoveragePercent, 66.67)
  assert.equal(stats.cacheHitRatePercent, 40)
  assert.equal(stats.cacheCreationTokens, 100)
  assert.equal(stats.cacheCreationReportedRequests, 1)
  assert.equal(stats.uncachedInputTokens, 100)
  assert.equal(stats.uncachedInputReportedRequests, 1)
  assert.equal(stats.byModel['test-model'].cacheHitRatePercent, 40)
  assert.equal(stats.byModel['test-model'].cacheUsageCoveragePercent, 66.67)
  assert.equal(getUsageStats({ ownerId: 'another-cache-owner' }).requests, 0)
  resetUsageStats({ ownerId })
})
