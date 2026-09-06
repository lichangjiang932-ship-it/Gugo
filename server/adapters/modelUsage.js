import { normalizeCacheReadUsage, normalizeModelUsage, normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'
import { isLocalEndpoint } from '../utils/endpointProfile.js'

const INTERNAL_USAGE_OWNER = Symbol('internal-model-usage')
const usageTotalsByOwner = new Map()

function usageOwnerKey(ownerId) {
  const normalized = typeof ownerId === 'string' ? ownerId.trim() : ''
  return normalized || INTERNAL_USAGE_OWNER
}

function emptyUsageCounters() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheUsageReportedRequests: 0,
    cacheUsageUnknownRequests: 0,
    cacheReportedPromptTokens: 0,
    cacheCreationTokens: 0,
    cacheCreationReportedRequests: 0,
    uncachedInputTokens: 0,
    uncachedInputReportedRequests: 0,
  }
}

function emptyUsageTotals() {
  return { ...emptyUsageCounters(), byModel: new Map() }
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

function accumulateUsage(totals, usage) {
  totals.requests += 1
  totals.promptTokens += usage.promptTokens
  totals.completionTokens += usage.completionTokens || 0
  const measured = normalizeCacheReadUsage(usage)
  if (measured.cacheHitTokens !== undefined) {
    totals.cacheUsageReportedRequests += 1
    totals.cacheReportedPromptTokens += usage.promptTokens
    totals.cacheHitTokens += measured.cacheHitTokens
    totals.cacheMissTokens += measured.cacheMissTokens
  } else totals.cacheUsageUnknownRequests += 1
  for (const [field, samples] of [
    ['cacheCreationTokens', 'cacheCreationReportedRequests'],
    ['uncachedInputTokens', 'uncachedInputReportedRequests'],
  ]) {
    if (usage[field] === undefined || usage[field] > usage.promptTokens) continue
    totals[field] += usage[field]
    totals[samples] += 1
  }
}

export function recordUsage(modelName, usage, { ownerId } = {}) {
  const normalized = normalizeModelUsage(usage)
  if (!normalized) return
  const usageTotals = usageTotalsFor(ownerId, { create: true })
  accumulateUsage(usageTotals, normalized)
  const key = String(modelName || 'unknown')
  const model = usageTotals.byModel.get(key) || emptyUsageCounters()
  accumulateUsage(model, normalized)
  usageTotals.byModel.set(key, model)
}

function hitRate(hit, total) {
  return total > 0 ? Number(((hit / total) * 100).toFixed(2)) : null
}

export function getUsageStats({ ownerId } = {}) {
  const usageTotals = usageTotalsFor(ownerId)
  const rates = (totals) => ({
    cacheHitRatePercent: hitRate(totals.cacheHitTokens, totals.cacheReportedPromptTokens),
    cacheUsageCoveragePercent: hitRate(totals.cacheUsageReportedRequests, totals.requests),
  })
  const { byModel, ...totals } = usageTotals
  return {
    ...totals,
    ...rates(totals),
    byModel: Object.fromEntries(
      [...byModel.entries()].map(([name, model]) => [
        name,
        {
          ...model,
          ...rates(model),
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
