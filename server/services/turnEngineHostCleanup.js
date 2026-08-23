function releaseNotAcknowledgedError(step) {
  const error = new Error(`${step.label} did not acknowledge release`)
  error.code = step.failureCode
  error.retryable = true
  return error
}

function completeRelease(step, result) {
  const released = result === true
    || (result === false && step.acceptAlreadyReleased === true)
  if (!released) throw releaseNotAcknowledgedError(step)
  step.onReleased?.()
}

function releaseAttempt(failures, pending) {
  return Object.freeze({
    failures: Object.freeze(failures),
    pending: Object.freeze(pending),
  })
}

export function releaseTurnEngineHostResourcesSync(steps) {
  const failures = []
  const pending = []
  for (const step of steps) {
    try {
      completeRelease(step, step.release())
    } catch (error) {
      failures.push(error)
      pending.push(step)
    }
  }
  return releaseAttempt(failures, pending)
}

export async function releaseTurnEngineHostResources(steps) {
  const failures = []
  const pending = []
  for (const step of steps) {
    try {
      completeRelease(step, await step.release())
    } catch (error) {
      failures.push(error)
      pending.push(step)
    }
  }
  return releaseAttempt(failures, pending)
}

export function throwTurnEngineHostFailures(failures, {
  primaryError = null,
  code,
  message,
} = {}) {
  const errors = primaryError ? [primaryError, ...failures] : [...failures]
  if (errors.length === 0) return
  if (errors.length === 1) {
    const [failure] = errors
    if (primaryError || !code) throw failure
    if (failure && (typeof failure === 'object' || typeof failure === 'function')) {
      try {
        failure.code = code
        failure.retryable = true
        if (failure.code === code && failure.retryable === true) throw failure
      } catch (error) {
        if (error === failure) throw error
      }
    }
    const wrapped = new Error(failure?.message || message, { cause: failure })
    wrapped.code = code
    wrapped.retryable = true
    throw wrapped
  }
  const error = new AggregateError(errors, message, {
    cause: primaryError || errors[0],
  })
  error.code = code
  error.retryable = true
  throw error
}
