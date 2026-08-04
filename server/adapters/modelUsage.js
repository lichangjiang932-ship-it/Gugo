const usageTotals = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  byModel: new Map(),
}

export function recordUsage(modelName, usage) {
  if (!usage) return
  usageTotals.requests += 1
  usageTotals.promptTokens += usage.promptTokens || 0
  usageTotals.completionTokens += usage.completionTokens || 0
  usageTotals.cacheHitTokens += usage.cacheHitTokens || 0
  usageTotals.cacheMissTokens += usage.cacheMissTokens || 0
  const key = String(modelName || 'unknown')
  const model = usageTotals.byModel.get(key) || {
    requests: 0,
    promptTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  }
  model.requests += 1
  model.promptTokens += usage.promptTokens || 0
  model.cacheHitTokens += usage.cacheHitTokens || 0
  model.cacheMissTokens += usage.cacheMissTokens || 0
  usageTotals.byModel.set(key, model)
}

function hitRate(hit, total) {
  return total > 0 ? Number(((hit / total) * 100).toFixed(2)) : null
}

export function getUsageStats() {
  const cacheable = usageTotals.cacheHitTokens + usageTotals.cacheMissTokens
  return {
    requests: usageTotals.requests,
    promptTokens: usageTotals.promptTokens,
    completionTokens: usageTotals.completionTokens,
    cacheHitTokens: usageTotals.cacheHitTokens,
    cacheMissTokens: usageTotals.cacheMissTokens,
    cacheHitRatePercent: hitRate(usageTotals.cacheHitTokens, cacheable),
    byModel: Object.fromEntries(
      [...usageTotals.byModel.entries()].map(([name, model]) => [
        name,
        {
          ...model,
          cacheHitRatePercent: hitRate(model.cacheHitTokens, model.cacheHitTokens + model.cacheMissTokens),
        },
      ]),
    ),
  }
}

export function resetUsageStats() {
  usageTotals.requests = 0
  usageTotals.promptTokens = 0
  usageTotals.completionTokens = 0
  usageTotals.cacheHitTokens = 0
  usageTotals.cacheMissTokens = 0
  usageTotals.byModel.clear()
}
