import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CACHE_NOISE_FLOOR_TOKENS,
  CACHE_TTL_MS,
  collectCacheMisses,
  computeCacheWaste,
  createRateResolver,
  describeCacheMiss,
  detectCacheMiss,
} from '../shared/modelCacheStats.js'

const request = (overrides = {}) => ({
  providerId: 'anthropic',
  modelName: 'claude-sonnet-5-5',
  timestamp: 1_000_000,
  usage: {
    promptTokens: 20_000,
    cacheHitTokens: 0,
    cacheCreationTokens: 0,
    ...overrides.usage,
  },
  ...overrides,
})

test('the first request has nothing to compare against and is not a miss', () => {
  assert.equal(detectCacheMiss(undefined, request({ usage: { cacheHitTokens: 0 } })), undefined)
})

test('a request that only grew is not waste — only the re-billed overlap is', () => {
  // Previous prompt was 20k; this one is 24k of which 20k came back from cache.
  const previous = { promptTokens: 20_000, modelKey: 'anthropic/claude-sonnet-5-5', timestamp: 1_000_000, reportedCache: true }
  const miss = detectCacheMiss(previous, request({
    timestamp: 1_030_000,
    usage: { promptTokens: 24_000, cacheHitTokens: 20_000, cacheCreationTokens: 4_000 },
  }))
  assert.equal(miss, undefined)
})

test('tokens that were already in the previous prompt and were re-billed are counted', () => {
  const previous = { promptTokens: 30_000, modelKey: 'anthropic/claude-sonnet-5-5', timestamp: 1_000_000, reportedCache: true }
  const miss = detectCacheMiss(previous, request({
    timestamp: 1_020_000,
    usage: { promptTokens: 30_000, cacheHitTokens: 2_000, cacheCreationTokens: 28_000 },
  }))
  assert.equal(miss.missedTokens, 28_000)
  assert.equal(miss.modelChanged, false)
  assert.equal(miss.idleMs, 20_000)
})

test('a miss at or below the breakpoint granularity floor is not reported', () => {
  const previous = { promptTokens: 10_000, modelKey: 'p/m', timestamp: 1, reportedCache: true }
  const miss = detectCacheMiss(previous, request({
    usage: { promptTokens: 10_000, cacheHitTokens: 10_000 - CACHE_NOISE_FLOOR_TOKENS },
  }))
  assert.equal(miss, undefined)
})

test('a provider that never reports caching never produces a miss', () => {
  const previous = { promptTokens: 40_000, modelKey: 'p/m', timestamp: 1, reportedCache: false }
  const miss = detectCacheMiss(previous, request({
    usage: { promptTokens: 40_000, cacheHitTokens: 0, cacheCreationTokens: 0 },
  }))
  assert.equal(miss, undefined)
})

test('a request that reported no cache usage at all is unknown, not a total miss', () => {
  const previous = { promptTokens: 40_000, modelKey: 'p/m', timestamp: 1, reportedCache: true }
  const silent = (usage) => ({ providerId: 'p', modelName: 'm', timestamp: 2, usage })
  // The answer simply did not say. Reading that silence as a hit count of zero
  // would bill the whole previous prompt as waste the reader never caused.
  assert.equal(detectCacheMiss(previous, silent({ promptTokens: 40_000 })), undefined)
  // An explicit zero is a measured full miss, and stays counted.
  const measured = detectCacheMiss(previous, silent({
    promptTokens: 40_000, cacheHitTokens: 0, cacheCreationTokens: 0,
  }))
  assert.equal(measured.missedTokens, 40_000)
})

test('cache writes do not manufacture a missing cache-read measurement', () => {
  const previous = request({ usage: { promptTokens: 10_000, cacheHitTokens: 8_000 } })
  for (const read of [undefined, null, '', {}, []]) {
    for (const write of [0, 2_000]) {
      const current = request({ usage: { promptTokens: 10_500, cacheHitTokens: read, cacheCreationTokens: write } })
      assert.deepEqual(computeCacheWaste([previous, current]), { missedTokens: 0, missedCost: 0, missCount: 0 })
    }
  }
  assert.equal(computeCacheWaste([previous, request({ usage: { promptTokens: 10_500, cacheHitTokens: 0 } })]).missCount, 1)
})

test('compaction resets the baseline — new content is not re-billed content', () => {
  const records = [
    request({ timestamp: 1_000, usage: { promptTokens: 40_000, cacheHitTokens: 0, cacheCreationTokens: 40_000 } }),
    request({ timestamp: 2_000, resetsCache: true, usage: { promptTokens: 8_000, cacheHitTokens: 0, cacheCreationTokens: 8_000 } }),
    request({ timestamp: 3_000, usage: { promptTokens: 12_000, cacheHitTokens: 12_000, cacheCreationTokens: 0 } }),
  ]
  assert.deepEqual(computeCacheWaste(records), { missedTokens: 0, missedCost: 0, missCount: 0 })
})

test('a model switch is counted, and named as the cause', () => {
  const records = [
    request({ timestamp: 1_000, usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
    request({ timestamp: 2_000, modelName: 'claude-opus-5-5', usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
  ]
  const { totals, misses } = (() => {
    const waste = computeCacheWaste(records)
    return { totals: waste, misses: collectCacheMisses(records) }
  })()
  assert.equal(totals.missCount, 1)
  const described = describeCacheMiss([...misses.values()][0])
  assert.equal(described.modelChanged, true)
  assert.equal(described.cause, 'modelChanged')
})

test('expiry is only a possibility when the effective cache TTL is known', () => {
  const records = [
    request({ timestamp: 1_000, usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
    request({ timestamp: 1_000 + CACHE_TTL_MS + 1, usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
  ]
  const miss = [...collectCacheMisses(records).values()][0]
  assert.equal(describeCacheMiss(miss).cause, 'unknown')
  assert.equal(describeCacheMiss(miss, { cacheTtlMs: CACHE_TTL_MS }).cause, 'possibleExpiry')
  assert.equal(describeCacheMiss(miss, { cacheTtlMs: 60 * 60 * 1000 }).cause, 'unknown')
})

test('a miss alone cannot prove that content changed', () => {
  const records = [
    request({ timestamp: 1_000, usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
    request({ timestamp: 2_000, usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } }),
  ]
  const miss = [...collectCacheMisses(records).values()][0]
  assert.equal(describeCacheMiss(miss).cause, 'unknown')
  assert.equal(describeCacheMiss(miss, { prefixChanged: true }).cause, 'prefixChanged')
})

test('cost needs a cache-read rate; without one the token count still stands', () => {
  const previous = { promptTokens: 30_000, modelKey: 'anthropic/claude-sonnet-5-5', timestamp: 1, reportedCache: true }
  const record = request({ usage: { promptTokens: 30_000, cacheHitTokens: 0, cacheCreationTokens: 30_000 } })

  assert.equal(detectCacheMiss(previous, record).missedCost, null)
  assert.equal(detectCacheMiss(previous, record, { resolvePrice: () => ({ input: 3, cacheRead: null }) }).missedCost, null)
  const priced = detectCacheMiss(previous, record, {
    resolvePrice: () => ({ input: 3, cacheRead: 0.3 }),
  })
  // 30k tokens × (3 - 0.3) per million
  assert.ok(Math.abs(priced.missedCost - (30_000 * 2.7) / 1_000_000) < 1e-12)
})

test('the rate resolver reads the same table cost estimation already uses', () => {
  const env = { MODEL_USD_RATES: JSON.stringify({ providers: { anthropic: { 'claude-sonnet-5-5': { input: 3, cacheRead: 0.3 } } } }) }
  const resolve = createRateResolver(env)
  assert.equal(resolve({ providerId: 'anthropic', modelName: 'claude-sonnet-5-5' }).cacheRead, 0.3)
  assert.equal(resolve({ providerId: 'anthropic', modelName: 'nope' }), null)
  assert.equal(createRateResolver({ MODEL_USD_RATES: '{not json' })({ providerId: 'a', modelName: 'b' }), null)
})

test('session totals add up across several misses', () => {
  const records = [
    request({ timestamp: 1_000, usage: { promptTokens: 40_000, cacheHitTokens: 0, cacheCreationTokens: 40_000 } }),
    request({ timestamp: 2_000, usage: { promptTokens: 40_000, cacheHitTokens: 0, cacheCreationTokens: 40_000 } }),
    request({ timestamp: 3_000, usage: { promptTokens: 44_000, cacheHitTokens: 40_000, cacheCreationTokens: 4_000 } }),
    request({ timestamp: 4_000, usage: { promptTokens: 44_000, cacheHitTokens: 0, cacheCreationTokens: 44_000 } }),
  ]
  const totals = computeCacheWaste(records)
  assert.equal(totals.missCount, 2)
  assert.equal(totals.missedTokens, 40_000 + 44_000)
})

test('a prompt that came back smaller was rewritten, not re-billed', () => {
  // 40k → 12k is compaction dropping messages. Charging the overlap as waste
  // would blame the app for a rewrite it had to make.
  const previous = { promptTokens: 40_000, modelKey: 'p/m', timestamp: 1, reportedCache: true }
  assert.equal(detectCacheMiss(previous, request({
    usage: { promptTokens: 12_000, cacheHitTokens: 0, cacheCreationTokens: 12_000 },
  })), undefined)
})

test('a small shrink is ordinary drift, and still counts', () => {
  const previous = { promptTokens: 40_000, modelKey: 'p/m', timestamp: 1, reportedCache: true }
  const miss = detectCacheMiss(previous, request({
    usage: { promptTokens: 38_000, cacheHitTokens: 0, cacheCreationTokens: 38_000 },
  }))
  assert.equal(miss.missedTokens, 38_000)
})

test('a malformed record is skipped rather than counted as a total loss', () => {
  const records = [null, { usage: {} }, request({ timestamp: 5_000, usage: { promptTokens: 30_000, cacheHitTokens: 30_000 } })]
  assert.deepEqual(computeCacheWaste(records), { missedTokens: 0, missedCost: 0, missCount: 0 })
})
