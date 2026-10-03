// @ts-check

/**
 * The turn failure-code contract shared by the HTTP/WebSocket host layer and
 * the client flow guards. Both sides used to keep private copies and drifted:
 * the client offered a retry for `TURN_FAILED_RETRY_CONFLICT`, which the server
 * permanently rejects with 409, and it did not recognize
 * `TURN_SESSION_ACTIVITY_CHECK_FAILED` as a retryable host failure.
 *
 * The groups are split along the lines each side reasons about, so a consumer
 * composes the groups it needs instead of re-listing codes. Every export is a
 * `Set` and is read-only by convention.
 */

/** Emitted by the HTTP surface and the turn WebSocket, not by the TurnEngine. */
export const TURN_RUNTIME_NOT_READY_FAILURE_CODES = new Set([
  'RUNTIME_NOT_READY',
])

export const TURN_HOST_CONFIGURATION_FAILURE_CODES = new Set([
  'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
  'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
])

export const TURN_HOST_TRANSIENT_FAILURE_CODES = new Set([
  'TURN_SESSION_ACTIVITY_CHECK_FAILED',
])

export const TURN_ENGINE_CLEANUP_FAILURE_CODES = new Set([
  'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_CLEANUP_FAILED',
])

export const TURN_ENGINE_RESTARTING_FAILURE_CODES = new Set([
  'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
  'TURN_ENGINE_SHUTTING_DOWN',
])

/**
 * Kept apart from the restarting pair: the client shows an interruption notice
 * when the turn had already started executing and a runtime-unavailable notice
 * when it had not.
 */
export const TURN_ENGINE_SHUTDOWN_FAILURE_CODES = new Set([
  'TURN_ENGINE_SHUTDOWN',
])

/** Every code the client reports as a runtime that is not usable yet. */
export const TURN_HOST_PRE_EXECUTION_FAILURE_CODES = new Set([
  ...TURN_RUNTIME_NOT_READY_FAILURE_CODES,
  ...TURN_HOST_CONFIGURATION_FAILURE_CODES,
  ...TURN_HOST_TRANSIENT_FAILURE_CODES,
  ...TURN_ENGINE_RESTARTING_FAILURE_CODES,
  ...TURN_ENGINE_CLEANUP_FAILURE_CODES,
])

/** Every code for which the host answers 503 with a retry action. */
export const TURN_HOST_UNAVAILABLE_FAILURE_CODES = new Set([
  ...TURN_HOST_CONFIGURATION_FAILURE_CODES,
  ...TURN_HOST_TRANSIENT_FAILURE_CODES,
  ...TURN_ENGINE_RESTARTING_FAILURE_CODES,
  ...TURN_ENGINE_SHUTDOWN_FAILURE_CODES,
  ...TURN_ENGINE_CLEANUP_FAILURE_CODES,
])

/**
 * Failures a failed-turn retry can never recover from. Offering a retry for one
 * of these only produces another rejection, so the client must hide the action.
 */
export const PERMANENT_FAILED_RETRY_REJECTION_CODES = new Set([
  'TURN_FAILED_RETRY_NOT_ALLOWED',
  'TURN_FAILED_RETRY_LIMIT_REACHED',
  'TURN_FAILED_RETRY_UNSUPPORTED',
  'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
  'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
  'TURN_FAILED_RETRY_EVENT_INVALID',
  'TURN_FAILED_RETRY_ATTEMPT_INVALID',
  'TURN_FAILED_RETRY_PROJECTION_INVALID',
  'TURN_FAILED_RETRY_CONFLICT',
])
