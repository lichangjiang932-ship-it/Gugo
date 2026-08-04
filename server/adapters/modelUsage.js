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

// Dollar-denominated provider cost is used only by optional job/subagent hard budgets.
// It never changes account access or charges a user-facing balance.
export function calculateModelCostUsd({ modelName, usage, env = process.env }) {
  let rates
  try {
    rates = JSON.parse(String(env.MODEL_USD_RATES || '{}'))
  } catch {
    return 0
  }
  const rate = rates?.[modelName]
  if (!rate || typeof rate !== 'object') return 0
  const inputRate = Math.max(0, Number(rate.input) || 0)
  const outputRate = Math.max(0, Number(rate.output) || 0)
  const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
  return (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000
}
