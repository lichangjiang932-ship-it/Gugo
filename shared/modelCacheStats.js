/**
 * Potential prompt-cache waste, estimated per model request.
 *
 * Request-size overlap is a heuristic, not proof of identical prefixes, cache
 * eligibility or billing. Samples without a measured cache read are excluded.
 *
 * The estimated input overlap, a rate-based cost estimate, the idle gap and
 * model changes are diagnostic clues. They do not establish why the provider
 * missed its cache; the caller must retain that distinction when presenting them.
 *
 * Modelled on pi's `packages/coding-agent/src/core/cache-stats.ts`; the shape and
 * the thresholds are theirs, adapted to this project's usage records. The point
 * of copying it rather than inventing one is that the numbers have to be
 * comparable between the two, and theirs have already been thought about.
 */

import { normalizeOptionalUsageNumber } from './modelUsage.js'

/** Anthropic's short TTL, for callers with explicit policy knowledge; never a cross-provider default. */
export const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Whether the answer itself stated a cache reading, rather than staying silent.
 *
 * An absent field and an explicit zero are not the same claim, and only one of
 * them is a measurement. `normalizeOptionalUsageNumber` is the project's own
 * reading of that difference; reuse it rather than re-deciding what counts.
 */
function reportsCacheUsage(usage) {
  // A measured write says nothing about whether cache reads were reported.
  return normalizeOptionalUsageNumber(usage?.cacheHitTokens) !== null
}

/**
 * A miss at or below this is cache-breakpoint granularity, not waste: the
 * provider caches in whole blocks, so a few hundred tokens of drift is normal
 * at every turn boundary and counting it would drown the signal.
 */
export const CACHE_NOISE_FLOOR_TOKENS = 1024

function tokenCount(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/** A record may carry its usage flat or nested under `usage`. */
function usageOf(record) {
  return record?.usage && typeof record.usage === 'object' ? record.usage : record
}

function modelKey(record) {
  return `${record?.providerId || record?.provider || ''}/${record?.modelName || record?.model || ''}`
}

function priceFor(record, resolvePrice) {
  if (typeof resolvePrice !== 'function') return null
  try {
    return resolvePrice(record) || null
  } catch {
    return null
  }
}

/**
 * The waste on one request relative to the previous one.
 *
 * `missedTokens` estimates the overlap of input counts not covered by reported
 * reads. Growing input is not itself waste; neither this count nor the rate-based
 * cost estimate establishes that the provider could or should have cached it.
 */
/**
 * A prompt that came back noticeably smaller was rewritten, not drifted: context
 * compaction drops messages, and the request that follows is new content rather
 * than old content billed twice. pi resets its baseline on a compaction entry;
 * this project's usage feed carries no such marker, so the shrink itself is the
 * marker. Without this, every compaction is reported as waste the app caused,
 * which is both wrong and the loudest thing in the report.
 */
export const CONTEXT_REWRITE_SHRINK_RATIO = 0.9

function isContextRewrite(previous, promptTokens) {
  if (!previous || previous.promptTokens <= 0) return false
  return promptTokens < previous.promptTokens * CONTEXT_REWRITE_SHRINK_RATIO
}

export function detectCacheMiss(previous, record, { resolvePrice } = {}) {
  const usage = usageOf(record)
  const promptTokens = tokenCount(usage.promptTokens)
  const cacheRead = tokenCount(usage.cacheHitTokens)
  const cacheWrite = tokenCount(usage.cacheCreationTokens)
  if (!previous || promptTokens <= 0) return undefined
  if (isContextRewrite(previous, promptTokens)) return undefined
  // A record that states no cache reading is unknown, not a miss. Counting its
  // silence as a hit count of zero would bill the entire previous prompt as
  // waste — the loudest possible number, from the least information.
  if (!reportsCacheUsage(usage)) return undefined
  // Nothing read *and* nothing written only counts as a miss when this session
  // has reported cache activity before. On a provider that never reports caching
  // a zero here means nothing at all.
  if (cacheRead + cacheWrite === 0 && !previous.reportedCache) return undefined

  const missedTokens = Math.min(previous.promptTokens, promptTokens) - cacheRead
  if (missedTokens <= CACHE_NOISE_FLOOR_TOKENS) return undefined

  // Only the difference between what was paid and what a cache read would have
  // cost. Both rates come from the deployment's own price table; when it names
  // no cache-read rate the cost is reported as unknown (null) rather than guessed,
  // and the token count still stands on its own.
  const price = priceFor(record, resolvePrice)
  const paidRate = normalizeOptionalUsageNumber(price?.input)
  const readRate = normalizeOptionalUsageNumber(price?.cacheRead)
  const missedCost = paidRate !== null && readRate !== null
    ? (missedTokens * Math.max(0, paidRate - readRate)) / 1_000_000
    : null

  const timestamp = Number(record?.timestamp) || 0
  const previousTimestamp = Number(previous.timestamp) || 0
  return {
    missedTokens,
    missedCost,
    idleMs: timestamp && previousTimestamp ? Math.max(0, timestamp - previousTimestamp) : 0,
    modelChanged: modelKey(record) !== previous.modelKey,
  }
}

function asPrevious(record, reportedCache) {
  const usage = usageOf(record)
  const promptTokens = tokenCount(usage.promptTokens)
  if (promptTokens <= 0) return undefined
  return {
    promptTokens,
    modelKey: modelKey(record),
    timestamp: Number(record?.timestamp) || 0,
    reportedCache: reportedCache
      || tokenCount(usage.cacheHitTokens) + tokenCount(usage.cacheCreationTokens) > 0,
  }
}

function scan(records, { resolvePrice } = {}) {
  let previous
  const totals = { missedTokens: 0, missedCost: 0, missCount: 0 }
  const misses = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue
    // Compaction rewrites the prompt for real reasons, so the next request is
    // new content rather than content being re-billed. A model switch is *not*
    // exempt: it re-bills the whole prompt and belongs in the count.
    if (record.resetsCache === true) {
      previous = undefined
      continue
    }
    const miss = detectCacheMiss(previous, record, { resolvePrice })
    if (miss) {
      totals.missedTokens += miss.missedTokens
      totals.missedCost = totals.missedCost === null || miss.missedCost === null ? null : totals.missedCost + miss.missedCost
      totals.missCount += 1
      misses.set(record, miss)
    }
    previous = asPrevious(record, previous?.reportedCache ?? false) ?? previous
  }
  return { totals, misses }
}

/** Session totals of potentially repeated input, not provider billing facts. */
export function computeCacheWaste(records, options) {
  return scan(records, options).totals
}

/** Each counted miss, keyed by the record that paid for it. */
export function collectCacheMisses(records, options) {
  return scan(records, options).misses
}

/**
 * Misses worth telling the reader about in a transcript: a long idle gap (the
 * cache expired on its own) or a model switch is not something they did wrong,
 * but content that moved is, and the two are indistinguishable without saying so.
 */
export function describeCacheMiss(miss, { cacheTtlMs = null, prefixChanged = null } = {}) {
  if (!miss) return null
  const ttl = normalizeOptionalUsageNumber(cacheTtlMs)
  const cause = miss.modelChanged ? 'modelChanged'
    : prefixChanged === true ? 'prefixChanged'
      : ttl !== null && ttl > 0 && miss.idleMs > ttl ? 'possibleExpiry' : 'unknown'
  return { ...miss, cause }
}

/**
 * Adapts this project's `MODEL_USD_RATES` into the resolver the scan expects.
 * The table is the same one cost estimation already reads; `cacheRead` is an
 * addition, and entries that omit it report no miss cost rather than a wrong one.
 *
 * The environment is an argument rather than a default because this module is
 * shared with the browser, which has no `process` to reach for.
 */
export function createRateResolver(env) {
  let rates = {}
  try {
    rates = JSON.parse(String(env?.MODEL_USD_RATES || '{}')) || {}
  } catch {
    rates = {}
  }
  return (record) => {
    const provider = String(record?.providerId || record?.provider || '').trim()
    const model = String(record?.modelName || record?.model || '').trim()
    const rate = (provider ? rates?.providers?.[provider]?.[model] : null)
      ?? (provider ? rates?.[`${provider}:${model}`] : null)
      ?? rates?.[model]
    return rate && typeof rate === 'object' && !Array.isArray(rate) ? rate : null
  }
}
