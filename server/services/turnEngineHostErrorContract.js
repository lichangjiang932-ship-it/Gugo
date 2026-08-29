const HOST_CONFIGURATION_MESSAGES = new Map([
  [
    'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
    'turn runtime is not ready because persistence is not configured',
  ],
  [
    'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
    'turn runtime is not ready because compaction storage is not configured',
  ],
])

const HOST_TRANSIENT_MESSAGES = new Map([
  [
    'TURN_SESSION_ACTIVITY_CHECK_FAILED',
    'turn activity could not be verified; retry shortly',
  ],
])

const HOST_RESTARTING_ERROR_CODES = new Set([
  'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
  'TURN_ENGINE_SHUTTING_DOWN',
  'TURN_ENGINE_SHUTDOWN',
])

const HOST_CLEANUP_ERROR_CODES = new Set([
  'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_CLEANUP_FAILED',
])

const HOST_UNAVAILABLE_ERROR_CODES = new Set([
  ...HOST_CONFIGURATION_MESSAGES.keys(),
  ...HOST_TRANSIENT_MESSAGES.keys(),
  ...HOST_RESTARTING_ERROR_CODES,
  ...HOST_CLEANUP_ERROR_CODES,
])

function errorCode(error) {
  return String(error?.code || '').trim()
}

export function isTurnEngineHostUnavailableError(error) {
  return HOST_UNAVAILABLE_ERROR_CODES.has(errorCode(error))
}

/**
 * Stable transport-facing description for failures that mean the process host
 * cannot currently provide a TurnEngine. Unknown application errors return
 * null so callers do not accidentally turn arbitrary failures into retryable
 * 503 responses.
 */
export function describeTurnEngineHostUnavailableError(error) {
  const code = errorCode(error)
  if (!HOST_UNAVAILABLE_ERROR_CODES.has(code)) return null

  const configurationMessage = HOST_CONFIGURATION_MESSAGES.get(code)
  const transientMessage = HOST_TRANSIENT_MESSAGES.get(code)
  const message = configurationMessage
    || transientMessage
    || (HOST_RESTARTING_ERROR_CODES.has(code)
      ? 'turn runtime is restarting; retry shortly'
      : 'turn runtime cleanup is incomplete; retry shortly')

  return {
    statusCode: 503,
    error: {
      code,
      message,
      action: configurationMessage ? 'restart_runtime' : 'retry',
    },
  }
}
