function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasValidToolArguments(value) {
  if (value == null || value === '') return true
  if (isPlainObject(value)) {
    try {
      JSON.stringify(value)
      return true
    } catch {
      return false
    }
  }
  if (typeof value !== 'string') return false
  try {
    return isPlainObject(JSON.parse(value.trim() || '{}'))
  } catch {
    return false
  }
}

function isValidToolCall(call) {
  if (!isPlainObject(call)) return false
  if (call.function != null && !isPlainObject(call.function)) return false
  const fn = isPlainObject(call.function) ? call.function : call
  const name = typeof fn.name === 'string' ? fn.name.trim() : ''
  if (!name) return false
  return hasValidToolArguments(
    fn.arguments ?? call.argumentsText ?? call.arguments ?? call.args,
  )
}

/**
 * Validate a response that an operator claims was completed by the provider.
 * This utility is intentionally pure so Turn and Job recovery cannot drift.
 */
export function assertValidCompletedModelResponse(value) {
  if (!isPlainObject(value)
    || (value.content != null && typeof value.content !== 'string')
    || (value.toolCalls != null && !Array.isArray(value.toolCalls))) {
    throw new TypeError('response must be a valid model response object')
  }

  const content = typeof value.content === 'string' ? value.content.trim() : ''
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : []
  if ((!content && toolCalls.length === 0)
    || toolCalls.some((call) => !isValidToolCall(call))) {
    throw new TypeError('response must contain non-empty content or valid tool calls')
  }
  return value
}
