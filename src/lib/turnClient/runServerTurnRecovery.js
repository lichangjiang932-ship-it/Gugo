export const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 15_000
export const DEFAULT_UNCONFIRMED_RECOVERY_MAX_ATTEMPTS = 3
export const DEFAULT_CANCEL_RETRY_DELAY_MS = 750
export const DEFAULT_CANCEL_RETRY_MAX_DELAY_MS = 5_000

const DEFINITELY_REJECTED_INITIAL_REQUEST_CODES = new Set([
  'RUNTIME_NOT_READY',
  'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
  'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
  'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
  'TURN_ENGINE_SHUTTING_DOWN',
  'TURN_ENGINE_SHUTDOWN',
  'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_CLEANUP_FAILED',
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_NOT_FOUND',
  'MODEL_PROVIDER_DISABLED',
  'MODEL_PROVIDER_MODEL_INVALID',
  'MODEL_PROVIDER_UNVERIFIED',
  'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_PROVIDER_CONFIG_CHANGED',
  'MODEL_PROVIDER_BINDING_MISSING',
  'MODEL_PROVIDER_AMBIGUOUS',
])

export function finiteDelay(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback
}

function inheritTurnFailureContext(target, source) {
  if (!target || !source || typeof source !== 'object') return target
  for (const field of [
    'serverFailure',
    'action',
    'status',
    'expectedSequence',
    'actualSequence',
    'recovery',
    'retryable',
    'manualRetryable',
    'retryAfter',
    'incompleteReason',
    'nextAction',
    'missingRequirements',
    'taskVerification',
    'attempts',
    'partialText',
    'artifactIds',
    'deliveryArtifactIds',
    'verifiedLocalFiles',
    'retainedLocalFiles',
    'iterations',
  ]) {
    if (source[field] !== undefined) target[field] = source[field]
  }
  return target
}

export function incompleteInitialTurnError(turnId) {
  const error = new Error(`Turn ${turnId} was accepted but its response ended before the turn could be read`)
  error.code = 'TURN_INITIAL_RESPONSE_INCOMPLETE'
  return error
}

export function hasTurnIdentity(turn) {
  return Boolean(String(turn?.turnId || '').trim())
}

export function isAmbiguousInitialRequestError(error) {
  if (DEFINITELY_REJECTED_INITIAL_REQUEST_CODES.has(String(error?.code || '').trim())) {
    return false
  }
  const status = Number(error?.status)
  if (!Number.isInteger(status)) return true
  return status >= 500 || [408, 409, 425, 429].includes(status)
}

export function confirmsExistingTurn(error) {
  return Number(error?.status) === 409 && error?.code === 'TURN_EXISTS'
}

export function unconfirmedInitialTurnError(turnId, attempts, cause) {
  const error = new Error(`The server did not confirm starting this task after ${attempts} attempts. Please send it again.`)
  error.code = 'TURN_REQUEST_UNCONFIRMED'
  error.retryable = true
  error.turnId = turnId
  error.attempts = attempts
  if (cause) error.cause = cause
  return inheritTurnFailureContext(error, cause)
}

export function requiresRuntimeRestart(error) {
  return String(error?.action || '').trim() === 'restart_runtime'
}

export function isApprovalPresentationClosed(error) {
  return error?.localTurnConsumerAbort === true
    && error?.code === 'APPROVAL_PRESENTATION_CLOSED'
}

export function recoveryDeadLetterError(turn) {
  const recovery = turn?.recovery
  if (recovery?.status !== 'dead_letter') return null
  const causeCode = String(
    recovery.error?.code || recovery.errorCode || 'TURN_RECOVERY_DEAD_LETTER',
  ).trim().toUpperCase() || 'TURN_RECOVERY_DEAD_LETTER'
  const attemptCount = Number(recovery.attemptCount)
  const sourceFailure = recovery.error && typeof recovery.error === 'object'
    ? recovery.error
    : turn?.lastEvent?.payload?.error && typeof turn.lastEvent.payload.error === 'object'
      ? turn.lastEvent.payload.error
      : {}
  const fallbackRequirements = ['MODEL_REQUEST_OUTCOME_UNKNOWN', 'SIDE_EFFECT_OUTCOME_UNKNOWN']
    .includes(causeCode)
    ? ['operation_outcome_verification', 'explicit_recovery_retry']
    : causeCode.startsWith('MODEL_')
      ? ['model_service_available', 'explicit_recovery_retry']
      : ['execution_environment_repair', 'explicit_recovery_retry']
  const missingRequirements = [...new Set([
    ...(Array.isArray(sourceFailure.missingRequirements) ? sourceFailure.missingRequirements : []),
    ...fallbackRequirements,
  ])]
  const error = new Error(
    recovery.error?.message || 'Automatic turn recovery stopped after repeated failures',
  )
  error.code = causeCode
  error.retryable = false
  error.recovery = recovery
  error.serverFailure = {
    ...sourceFailure,
    code: causeCode,
    retryable: false,
    manualRetryable: recovery.manualRetryable !== false,
    incompleteReason: sourceFailure.incompleteReason || 'recovery_attempts_exhausted',
    missingRequirements,
    ...(Number.isInteger(attemptCount) && attemptCount > 0 ? { attempts: attemptCount } : {}),
  }
  return inheritTurnFailureContext(error, turn?.lastEvent?.payload)
}

export function isRecoveryDeadLetterError(error) {
  return error?.code === 'TURN_RECOVERY_DEAD_LETTER'
    || error?.recovery?.status === 'dead_letter'
    || error?.retryable === false && error?.recovery
}

export function turnEventSequenceGapError({ turnId, expectedSequence, actualSequence }) {
  const error = new Error(`Turn ${turnId} event sequence gap: expected ${expectedSequence}, received ${actualSequence}`)
  error.name = 'TurnEventSequenceGapError'
  error.code = 'TURN_EVENT_SEQUENCE_GAP'
  error.retryable = true
  error.expectedSequence = expectedSequence
  error.actualSequence = actualSequence
  return error
}

export function isTurnEventSequenceGapError(error) {
  return error?.code === 'TURN_EVENT_SEQUENCE_GAP'
}
