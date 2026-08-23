const DEFAULT_CODE = 'APP_STARTUP_ABORTED'

/**
 * Process-host startup fence. A shutdown signal may arrive while asynchronous
 * capability discovery is still running; once requested, later continuations
 * must never bootstrap a fresh lifecycle behind the completed shutdown path.
 */
export function createStartupAbortGuard({
  code = DEFAULT_CODE,
  message = 'application startup was aborted because shutdown was requested',
} = {}) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new TypeError('startup abort code must be a non-empty string')
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('startup abort message must be a non-empty string')
  }

  let requested = false
  let reason = null
  return Object.freeze({
    request(nextReason = 'shutdown_requested') {
      if (requested) return false
      requested = true
      reason = typeof nextReason === 'string' && nextReason.trim()
        ? nextReason.trim().slice(0, 80)
        : 'shutdown_requested'
      return true
    },
    isRequested() {
      return requested
    },
    assertNotRequested() {
      if (!requested) return
      const error = new Error(message)
      error.code = code.trim()
      error.reason = reason
      error.retryable = false
      throw error
    },
  })
}
