const INVALID_COERCED_PATH_LITERAL = /^(?:undefined|null|nan|[+-]?infinity|\[object (?:object|array)\])$/i

function invalidRuntimeStoragePath(key, value) {
  const rendered = String(value).trim()
  const error = new Error(`${key} contains an invalid filesystem path literal: ${rendered || '<blank>'}`)
  error.code = 'RUNTIME_STORAGE_PATH_INVALID'
  error.retryable = false
  error.key = key
  error.value = rendered
  return error
}

/**
 * Reject values commonly produced by accidentally assigning nullish or other
 * non-path JavaScript values to process.env. Node stringifies those values,
 * which would otherwise make SQLite create files such as "undefined".
 */
export function validateRuntimeStoragePath(value, { key = 'storage path' } = {}) {
  if (value === undefined || value === null || value === '') return null
  const rendered = String(value)
  const normalized = rendered.trim()
  if (
    normalized === ''
    || normalized.includes('\0')
    || INVALID_COERCED_PATH_LITERAL.test(normalized)
  ) {
    throw invalidRuntimeStoragePath(key, value)
  }
  return rendered
}
