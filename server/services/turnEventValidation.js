import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { failureAllowsFailedRetry } from './turnFailedRetryPolicy.js'

export function failureAllowsAttempt(payloadJson, attemptPayload) {
  try {
    return failureAllowsFailedRetry(JSON.parse(payloadJson), attemptPayload)
  } catch { return false }
}

export function turnCompletionInvalid() {
  return Object.assign(new Error('turn.completed payload contains incomplete terminal evidence'), {
    code: 'TURN_COMPLETION_INVALID',
    status: 409,
    retryable: false,
  })
}

export function storedTurnEventIsTerminal(row) {
  if (row?.type === 'turn.cancelled' || row?.type === 'turn.failed') return true
  if (row?.type !== 'turn.completed') return false
  try {
    return isSuccessfulTurnCompletedEvent({
      type: row.type,
      payload: JSON.parse(row.payload_json),
    })
  } catch {
    // A corrupt terminal row must be repaired explicitly rather than extended.
    return true
  }
}

export function canonicalCheckpointState(value) {
  try {
    const normalized = JSON.parse(JSON.stringify(value))
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new TypeError()
    return normalized
  } catch {
    throw new TypeError('checkpoint state must be JSON-compatible')
  }
}
