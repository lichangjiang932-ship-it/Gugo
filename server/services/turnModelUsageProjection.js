import { normalizeModelUsage } from '../../shared/modelUsage.js'

const SUMMABLE_MODEL_USAGE_KEYS = Object.freeze([
  'cacheHitTokens',
  'cacheMissTokens',
  'cacheCreationTokens',
  'uncachedInputTokens',
])

function modelUsageTotal(usage) {
  if (Object.hasOwn(usage, 'totalTokens')) return usage.totalTokens
  return usage.promptTokens + (usage.completionTokens || 0)
}

export function addTurnModelUsage(total, value) {
  const current = normalizeModelUsage(value)
  const previous = normalizeModelUsage(total)
  if (!current) return previous

  const aggregate = {
    promptTokens: (previous?.promptTokens || 0) + current.promptTokens,
    completionTokens: (previous?.completionTokens || 0) + (current.completionTokens || 0),
    totalTokens: (previous ? modelUsageTotal(previous) : 0) + modelUsageTotal(current),
  }
  for (const key of SUMMABLE_MODEL_USAGE_KEYS) {
    if (!Object.hasOwn(previous || {}, key) && !Object.hasOwn(current, key)) continue
    aggregate[key] = (previous?.[key] || 0) + (current[key] || 0)
  }
  const previousCostMeasured = !previous || Object.hasOwn(previous, 'costUsd')
  if (previousCostMeasured && Object.hasOwn(current, 'costUsd')) {
    aggregate.costUsd = (previous?.costUsd || 0) + (current.costUsd || 0)
  }
  return normalizeModelUsage(aggregate)
}

export function normalizePromptTokenEstimate(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null
}
