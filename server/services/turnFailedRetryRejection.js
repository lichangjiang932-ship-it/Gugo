import { TurnEngineError } from './turnResolutionRuntime.js'
import {
  normalizeArtifactIds,
  normalizeTaskVerificationDetails,
  normalizeTurnFailure,
  publicIncompleteText,
} from './turnTerminalProjection.js'
import {
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from './turnRecoveryProjection.js'

const PERMANENT_REJECTION_CODES = new Set([
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

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isPermanentFailedRetryRejectionCode(value) {
  return PERMANENT_REJECTION_CODES.has(String(value || '').trim())
}

function uniqueStrings(values, limit = 64) {
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean))].slice(0, limit)
}

function nestedEvidenceSources(values) {
  const sources = []
  const queue = values.filter(isRecord).map((value) => ({ value, depth: 0 }))
  const visited = new Set()
  while (queue.length > 0 && sources.length < 64) {
    const { value, depth } = queue.shift()
    if (visited.has(value)) continue
    visited.add(value)
    sources.push(value)
    if (depth >= 8) continue
    for (const nested of [value.error, value.cause]) {
      if (isRecord(nested) && !visited.has(nested)) {
        queue.push({ value: nested, depth: depth + 1 })
      }
    }
  }
  return sources
}

/**
 * Merge public delivery evidence without allowing an empty wrapper/error to
 * erase durable evidence read from the terminal event or assistant message.
 */
export function mergeFailedRetryEvidence(...values) {
  const sources = nestedEvidenceSources(values)
  const owns = (key) => sources.some((source) => Object.hasOwn(source, key))
  const partialText = sources
    .flatMap((source) => [source.partialText, source.text])
    .map((value) => publicIncompleteText(value, ''))
    .find(Boolean) || ''
  const mergedIds = (key) => uniqueStrings(sources.flatMap((source) => (
    normalizeArtifactIds(source[key])
  )), 64)
  const artifactIds = mergedIds('artifactIds')
  const deliveryArtifactIds = mergedIds('deliveryArtifactIds')
  const verifiedLocalFiles = mergeLocalFileReceipts(
    ...sources.map((source) => source.verifiedLocalFiles),
  )
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(...sources.map((source) => source.retainedLocalFiles)),
    verifiedLocalFiles,
  )
  const iterations = sources
    .map((source) => Number(source.iterations))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .reduce((highest, value) => Math.max(highest, value), -1)
  const incompleteReason = sources
    .map((source) => String(source.incompleteReason || '').trim())
    .find(Boolean) || ''
  const nextAction = sources
    .map((source) => String(source.nextAction || '').trim().toLowerCase().slice(0, 80))
    .find((value) => /^[a-z][a-z0-9_]{0,79}$/u.test(value)) || ''
  const missingRequirements = uniqueStrings(sources.flatMap((source) => (
    Array.isArray(source.missingRequirements) ? source.missingRequirements : []
  )), 16)
  const taskVerification = sources
    .map((source) => normalizeTaskVerificationDetails(source.taskVerification))
    .find(Boolean) || null
  return {
    ...(partialText ? { partialText } : {}),
    ...(owns('artifactIds') ? { artifactIds } : {}),
    ...(owns('deliveryArtifactIds') ? { deliveryArtifactIds } : {}),
    ...(owns('verifiedLocalFiles') ? { verifiedLocalFiles } : {}),
    ...(owns('retainedLocalFiles') ? { retainedLocalFiles } : {}),
    ...(iterations >= 0 ? { iterations } : {}),
    ...(incompleteReason ? { incompleteReason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
    ...(taskVerification ? { taskVerification } : {}),
  }
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
  return {
    ...failure,
    ...mergeFailedRetryEvidence(
      failureEvent?.payload,
      failureEvent?.payload?.error,
      context,
      context?.error,
      { partialText: message?.content },
    ),
  }
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
  const evidence = mergeFailedRetryEvidence(
    failureEvent?.payload,
    failureEvent?.payload?.error,
    modelContext,
    modelContext.error,
    { partialText: existing?.content },
    error,
  )
  const failure = normalizeTurnFailure({
    ...previousFailure,
    ...evidence,
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
    content: String(evidence.partialText || ''),
    modelContext: {
      ...modelContext,
      ...evidence,
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

export function permanentFailedRetryError(error, ...evidenceSources) {
  const code = String(error?.code || 'TURN_FAILED_RETRY_NOT_ALLOWED').trim()
  const wrapped = new TurnEngineError(
    code,
    code,
    Number.isInteger(error?.status) ? error.status : 409,
  )
  wrapped.retryable = false
  if (typeof error?.manualRetryable === 'boolean') wrapped.manualRetryable = error.manualRetryable
  const evidence = mergeFailedRetryEvidence(...evidenceSources, error)
  Object.assign(wrapped, evidence)
  const incompleteReason = String(evidence.incompleteReason || error?.incompleteReason || '').trim()
  if (incompleteReason) wrapped.incompleteReason = incompleteReason
  const missingRequirements = [...new Set((Array.isArray(evidence.missingRequirements)
    ? evidence.missingRequirements
    : Array.isArray(error?.missingRequirements)
      ? error.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  if (missingRequirements.length > 0) wrapped.missingRequirements = missingRequirements
  if (isRecord(evidence.taskVerification)) wrapped.taskVerification = evidence.taskVerification
  if (Number.isInteger(error?.attempts) && error.attempts > 0) wrapped.attempts = error.attempts
  return wrapped
}
