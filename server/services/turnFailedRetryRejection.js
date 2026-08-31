import { TurnEngineError } from './turnResolutionRuntime.js'
import { normalizeTurnFailure } from './turnTerminalProjection.js'

const PERMANENT_REJECTION_CODES = new Set([
  'TURN_FAILED_RETRY_NOT_ALLOWED',
  'TURN_FAILED_RETRY_LIMIT_REACHED',
  'TURN_FAILED_RETRY_UNSUPPORTED',
  'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
  'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
  'TURN_FAILED_RETRY_EVENT_INVALID',
  'TURN_FAILED_RETRY_ATTEMPT_INVALID',
  'TURN_FAILED_RETRY_PROJECTION_INVALID',
])

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isPermanentFailedRetryRejectionCode(value) {
  return PERMANENT_REJECTION_CODES.has(String(value || '').trim())
}

export function failedRetryRejectionFromMessage(message, failureEvent) {
  const context = isRecord(message?.modelContext) ? message.modelContext : null
  const rejection = isRecord(context?.failedRetryRejection)
    ? context.failedRetryRejection
    : null
  const failure = isRecord(context?.error) ? context.error : null
  if (message?.id !== `${failureEvent?.turnId}:assistant`
    || context?.turnEvidence !== true
    || context?.evidenceState !== 'failed'
    || context?.serverLastSequence !== failureEvent?.sequence
    || rejection?.failureSequence !== failureEvent?.sequence
    || rejection?.code !== failure?.code
    || !isPermanentFailedRetryRejectionCode(rejection?.code)
    || failure?.retryable !== false) return null
  return failure
}

export function failedRetryRejectionEvidenceMessage({
  existing,
  userId,
  sessionId,
  turnId,
  failureEvent,
  error,
  writtenAt,
}) {
  const modelContext = isRecord(existing?.modelContext) ? { ...existing.modelContext } : {}
  const previousFailure = isRecord(failureEvent?.payload?.error)
    ? failureEvent.payload.error
    : isRecord(modelContext.error) ? modelContext.error : {}
  const failure = normalizeTurnFailure({
    ...previousFailure,
    code: String(error?.code || 'TURN_FAILED_RETRY_NOT_ALLOWED'),
    retryable: false,
    manualRetryable: false,
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  }, { code: 'TURN_FAILED_RETRY_NOT_ALLOWED', retryable: false })
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: String(
      existing?.content
      || failureEvent?.payload?.partialText
      || failureEvent?.payload?.text
      || '',
    ),
    modelContext: {
      ...modelContext,
      turnId,
      turnEvidence: true,
      evidenceState: 'failed',
      serverLastSequence: failureEvent.sequence,
      error: failure,
      failedRetryRejection: {
        code: failure.code,
        failureSequence: failureEvent.sequence,
      },
    },
    createdAt: Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : failureEvent.createdAt,
    updatedAt: writtenAt,
  }
}

export function permanentFailedRetryError(error) {
  const code = String(error?.code || 'TURN_FAILED_RETRY_NOT_ALLOWED').trim()
  const wrapped = new TurnEngineError(
    code,
    code,
    Number.isInteger(error?.status) ? error.status : 409,
  )
  wrapped.retryable = false
  if (typeof error?.manualRetryable === 'boolean') wrapped.manualRetryable = error.manualRetryable
  const incompleteReason = String(error?.incompleteReason || '').trim()
  if (incompleteReason) wrapped.incompleteReason = incompleteReason
  const missingRequirements = [...new Set((Array.isArray(error?.missingRequirements)
    ? error.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  if (missingRequirements.length > 0) wrapped.missingRequirements = missingRequirements
  if (isRecord(error?.taskVerification)) wrapped.taskVerification = error.taskVerification
  if (Number.isInteger(error?.attempts) && error.attempts > 0) wrapped.attempts = error.attempts
  return wrapped
}
