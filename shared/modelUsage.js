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
  const kind = typeof value
  if (
    (kind !== 'number' && kind !== 'string')
    || (kind === 'string' && value.trim() === '')
  ) return null

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Unknown cache reads are not zero hits. Only complete a measured partition. */
export function normalizeCacheReadUsage({ promptTokens, cacheHitTokens, cacheMissTokens } = {}) {
  const prompt = normalizeOptionalUsageNumber(promptTokens)
  const hit = normalizeOptionalUsageNumber(cacheHitTokens)
  const miss = normalizeOptionalUsageNumber(cacheMissTokens)
  if (prompt === null || (hit === null && miss === null)) return {}
  const total = Math.floor(prompt)
  const measuredHit = hit === null ? null : Math.floor(hit)
  const measuredMiss = miss === null ? null : Math.floor(miss)
  const read = measuredHit ?? total - measuredMiss
  const unread = measuredMiss ?? total - measuredHit
  if (read < 0 || unread < 0 || read + unread !== total) return {}
  return { cacheHitTokens: read, cacheMissTokens: unread }
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
