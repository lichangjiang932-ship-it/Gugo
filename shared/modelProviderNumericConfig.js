const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER

export const MODEL_PROVIDER_NUMERIC_LIMITS = Object.freeze({
  contextWindow: Object.freeze({ min: 1024, max: MAX_SAFE_INTEGER }),
  maxOutputTokens: Object.freeze({ min: 1, max: MAX_SAFE_INTEGER }),
  firstTokenTimeoutMs: Object.freeze({ min: 1000, max: MAX_SAFE_INTEGER }),
  idleTimeoutMs: Object.freeze({ min: 1000, max: MAX_SAFE_INTEGER }),
})

function invalidResult(reason, limits) {
  return { valid: false, empty: false, value: null, reason, ...limits }
}

export function parseOptionalModelProviderInteger(value, field) {
  const limits = MODEL_PROVIDER_NUMERIC_LIMITS[field]
  if (!limits) throw new TypeError(`Unknown model Provider numeric field: ${field}`)

  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return { valid: true, empty: true, value: null, reason: '', ...limits }
  }

  let number
  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    number = Number(value.trim())
  } else {
    return invalidResult('integer', limits)
  }

  if (!Number.isSafeInteger(number)) return invalidResult('safeInteger', limits)
  if (number < limits.min) return invalidResult('min', limits)
  if (number > limits.max) return invalidResult('max', limits)
  return { valid: true, empty: false, value: number, reason: '', ...limits }
}
