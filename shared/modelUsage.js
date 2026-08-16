const TOKEN_USAGE_KEYS = Object.freeze([
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cacheHitTokens',
  'cacheMissTokens',
  'cacheCreationTokens',
  'uncachedInputTokens',
])

export function normalizeOptionalUsageNumber(value) {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) return null

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function normalizeModelUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  if (!Object.hasOwn(value, 'promptTokens')) return null
  const promptTokens = normalizeOptionalUsageNumber(value.promptTokens)
  if (promptTokens === null) return null

  const normalized = { promptTokens: Math.floor(promptTokens) }
  for (const key of TOKEN_USAGE_KEYS) {
    if (key === 'promptTokens') continue
    if (!Object.hasOwn(value, key)) continue
    const count = normalizeOptionalUsageNumber(value[key])
    if (count !== null) normalized[key] = Math.floor(count)
  }

  const costUsd = normalizeOptionalUsageNumber(value.costUsd)
  if (costUsd !== null) normalized.costUsd = costUsd
  return normalized
}

export function promptTokensFromUsage(value) {
  return normalizeModelUsage(value)?.promptTokens ?? null
}
