export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function toolError(code, error, extra = {}) {
  return {
    ok: false,
    code,
    error,
    retryable: true,
    ...extra,
  }
}

export function safeStringify(value) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item)
      if (item instanceof Error) {
        return { name: item.name, message: item.message, code: item.code, status: item.status }
      }
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
  } catch (error) {
    return JSON.stringify(toolError(
      'tool_result_serialization_failed',
      error?.message || String(error),
      { retryable: false },
    ))
  }
}
