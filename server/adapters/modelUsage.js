import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { isLocalEndpoint } from '../utils/endpointProfile.js'

const INTERNAL_USAGE_OWNER = Symbol('internal-model-usage')
const usageTotalsByOwner = new Map()

function usageOwnerKey(ownerId) {
  const normalized = typeof ownerId === 'string' ? ownerId.trim() : ''
  return normalized || INTERNAL_USAGE_OWNER
}

function emptyUsageTotals() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    byModel: new Map(),
  }
}

function usageTotalsFor(ownerId, { create = false } = {}) {
  const key = usageOwnerKey(ownerId)
  let totals = usageTotalsByOwner.get(key)
  if (!totals && create) {
    totals = emptyUsageTotals()
    usageTotalsByOwner.set(key, totals)
  }
  return totals || emptyUsageTotals()
}

export function recordUsage(modelName, usage, { ownerId } = {}) {
  if (!usage) return
  const usageTotals = usageTotalsFor(ownerId, { create: true })
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

export function getUsageStats({ ownerId } = {}) {
  const usageTotals = usageTotalsFor(ownerId)
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

export function resetUsageStats({ ownerId } = {}) {
  if (ownerId === undefined) {
    usageTotalsByOwner.clear()
    return
  }
  usageTotalsByOwner.delete(usageOwnerKey(ownerId))
}

// Optional dollar-denominated Provider cost is local, read-only telemetry.
// It never changes request execution, permissions, evolution, promotion,
// rollback, account access, or any user-facing balance.
export function calculateModelCostUsd({
  providerId,
  modelName,
  baseUrl,
  endpointProfile,
  usage,
  env = process.env,
}) {
  const isLocal = typeof endpointProfile?.isLocal === 'boolean'
    ? endpointProfile.isLocal
    : isLocalEndpoint(baseUrl)
  let rates
  try {
    rates = JSON.parse(String(env.MODEL_USD_RATES || '{}'))
  } catch {
    return null
  }
  const provider = String(providerId || '').trim()
  const model = String(modelName || '').trim()
  // Provider-specific entries take precedence so identical model names can
  // have different upstream rates. The model-only key remains a compatible
  // default for single-provider installations.
  const rate = (provider ? rates?.providers?.[provider]?.[model] : null)
    ?? (provider ? rates?.[`${provider}:${model}`] : null)
    ?? rates?.[model]
  // A genuinely local model has no upstream Provider charge by default, but
  // loopback/private URLs are also commonly used for paid LiteLLM or similar
  // proxies. An explicitly matched rate therefore overrides the local default.
  // Malformed matched entries remain unknown instead of inventing a free or
  // paid value. This estimate is never an execution gate.
  if (rate === null || rate === undefined) return isLocal ? 0 : null
  if (typeof rate !== 'object' || Array.isArray(rate)) return null
  const inputRate = normalizeOptionalUsageNumber(rate.input)
  const outputRate = normalizeOptionalUsageNumber(rate.output)
  const promptTokens = normalizeOptionalUsageNumber(usage?.promptTokens)
  const completionTokens = normalizeOptionalUsageNumber(usage?.completionTokens)
  if (inputRate === null || outputRate === null
    || promptTokens === null || completionTokens === null) return null
  return (promptTokens * inputRate + completionTokens * outputRate) / 1_000_000
}
