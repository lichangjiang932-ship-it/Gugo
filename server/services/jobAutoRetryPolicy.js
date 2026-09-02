export const DEFAULT_AUTO_RETRY_MAX_ATTEMPTS = 2
export const DEFAULT_AUTO_RETRY_BASE_DELAY_MS = 1_000

const MAX_AUTO_RETRY_ATTEMPTS = 5
const MAX_AUTO_RETRY_BASE_DELAY_MS = 60_000
const MAX_AUTO_RETRY_DELAY_MS = 5 * 60_000
const SAFE_TRANSIENT_FAILURE_CODES = new Set([
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_ERROR',
])

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function normalizeJobAutoRetryPolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  const enabled = value === true || source.enabled === true
  return {
    enabled,
    maxAttempts: enabled
      ? boundedInteger(source.maxAttempts, DEFAULT_AUTO_RETRY_MAX_ATTEMPTS, 1, MAX_AUTO_RETRY_ATTEMPTS)
      : 0,
    baseDelayMs: boundedInteger(
      source.baseDelayMs,
      DEFAULT_AUTO_RETRY_BASE_DELAY_MS,
      DEFAULT_AUTO_RETRY_BASE_DELAY_MS,
      MAX_AUTO_RETRY_BASE_DELAY_MS,
    ),
  }
}

export function nextJobAutoRetry(job, { failureCode, now = Date.now() } = {}) {
  const policy = job?.autoRetry
  if (policy?.enabled !== true || !SAFE_TRANSIENT_FAILURE_CODES.has(String(failureCode || ''))) {
    return null
  }
  const attempts = Math.max(0, Number(policy.attempts) || 0)
  const maxAttempts = Math.max(0, Number(policy.maxAttempts) || 0)
  if (attempts >= maxAttempts) return null
  const attempt = attempts + 1
  const baseDelayMs = boundedInteger(
    policy.baseDelayMs,
    DEFAULT_AUTO_RETRY_BASE_DELAY_MS,
    DEFAULT_AUTO_RETRY_BASE_DELAY_MS,
    MAX_AUTO_RETRY_BASE_DELAY_MS,
  )
  const delayMs = Math.min(baseDelayMs * (2 ** (attempt - 1)), MAX_AUTO_RETRY_DELAY_MS)
  return { attempt, maxAttempts, delayMs, wakeAt: now + delayMs }
}
