import { normalizeCacheReadUsage, normalizeOptionalUsageNumber } from './modelUsage.js'

export function createUsageCoverage() {
  return { requests: 0, readReported: 0, writeReported: 0, reportedPromptTokens: 0,
    measuredPromptTokens: 0, cacheHitTokens: 0, cacheCreationTokens: 0 }
}

/** Count each model response once; missing observations never become zero readings. */
export function observeUsageCoverage(target, usage) {
  target.requests += 1
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
  const prompt = normalizeOptionalUsageNumber(usage.promptTokens)
  if (prompt !== null) target.reportedPromptTokens += Math.floor(prompt)
  const partition = normalizeCacheReadUsage(usage)
  if (partition.cacheHitTokens !== undefined) {
    target.readReported += 1
    target.measuredPromptTokens += Math.floor(prompt)
    target.cacheHitTokens += partition.cacheHitTokens
  }
  const write = normalizeOptionalUsageNumber(usage.cacheCreationTokens)
  if (write !== null && (prompt === null || write <= prompt)) {
    target.writeReported += 1
    target.cacheCreationTokens += Math.floor(write)
  }
}

export function summarizeUsageCoverage(target) {
  return {
    ...target,
    readUnknown: target.requests - target.readReported,
    writeUnknown: target.requests - target.writeReported,
    cacheHitTokens: target.readReported > 0 ? target.cacheHitTokens : null,
    cacheCreationTokens: target.writeReported > 0 ? target.cacheCreationTokens : null,
    readCoveragePercent: target.requests > 0 ? Math.round(target.readReported / target.requests * 10000) / 100 : null,
    hitRatePercent: target.measuredPromptTokens > 0 ? Math.round(target.cacheHitTokens / target.measuredPromptTokens * 10000) / 100 : null,
  }
}
