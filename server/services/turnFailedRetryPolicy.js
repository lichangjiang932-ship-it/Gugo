export const MAX_FAILED_TURN_RETRIES = 1

export function failureSupportsFailedRetry(failurePayload) {
  const failure = failurePayload?.error
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false
  return failure.retryable === true || failure.manualRetryable === true
}

export function failureAllowsFailedRetry(failurePayload, attemptPayload) {
  const failure = failurePayload?.error
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false
  return attemptPayload?.manualRetry === true
    ? failure.manualRetryable === true
    : failure.retryable === true
}

export function resetManualRetryVerificationBudget(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state || null
  const repair = state.completionGuards?.taskVerificationRepair
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) return state
  const resetFailures = (entries) => (Array.isArray(entries) ? entries.map((entry) => ({
    ...entry,
    failures: 0,
    lastFailureBatchId: '',
  })) : entries)
  return {
    ...state,
    completionGuards: {
      ...state.completionGuards,
      taskVerificationRepair: {
        ...repair,
        pending: resetFailures(repair.pending),
        consecutiveFailures: 0,
        lastFailureBatchId: '',
      },
    },
  }
}
