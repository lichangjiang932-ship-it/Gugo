export function configReloadError(code, message, statusCode = 409, retryable = false) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = retryable
  return error
}

export function stableConfigReloadErrorCode(error, fallback = 'PLUGIN_CONFIG_RELOAD_FAILED') {
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, 'code')
    if (descriptor && Object.hasOwn(descriptor, 'value')
      && typeof descriptor.value === 'string'
      && /^[A-Z][A-Z0-9_]{0,127}$/u.test(descriptor.value)) {
      return descriptor.value
    }
  } catch {
    // Hostile plugin errors never cross the reload audit boundary.
  }
  return fallback
}

function stableConfigReloadStatusCode(error) {
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, 'statusCode')
    const value = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : null
    return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
      ? value
      : null
  } catch {
    // Accessors, inherited values, and hostile proxies are never evaluated.
    return null
  }
}

export function normalizeConfigReloadFailure(error) {
  const code = stableConfigReloadErrorCode(error)
  if (code === 'PLUGIN_CONFIG_VALIDATION_FAILED'
    || code === 'PLUGIN_CONFIG_LAYERS_INVALID'
    || code === 'PLUGIN_CONFIG_FILE_INVALID') {
    try {
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        Object.defineProperty(error, 'statusCode', {
          value: 400,
          writable: true,
          configurable: true,
        })
      }
    } catch { /* use a safe replacement below */ }
    if (stableConfigReloadStatusCode(error) === 400) return error
    return configReloadError(code, 'runtime plugin configuration is invalid', 400)
  }
  if (stableConfigReloadStatusCode(error) !== null) return error
  return configReloadError(code, 'runtime plugin configuration reload failed', 500)
}
