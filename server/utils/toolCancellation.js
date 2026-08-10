const USER_CANCELLATION_CODES = new Set([
  'TURN_CANCEL_REQUESTED',
  'JOB_CANCEL_REQUESTED',
  'SUBAGENT_CANCEL_REQUESTED',
])

export function userCancellationError(code, message = 'Cancelled by user') {
  return Object.assign(new Error(message), {
    name: 'AbortError',
    code,
    userInitiated: true,
  })
}

export function isExplicitUserCancellation(signal) {
  if (!signal?.aborted) return false
  const reason = signal.reason
  return reason?.userInitiated === true || USER_CANCELLATION_CODES.has(reason?.code)
}

/**
 * Mutating tools must survive lease loss and transient transport aborts long
 * enough to persist an unambiguous checkpoint. Explicit user cancellation is
 * different: it is forwarded so cancellable subprocesses and browser waits
 * stop promptly.
 */
export function createToolAbortScope(signal, interruptBehavior) {
  if (!signal || interruptBehavior !== 'block') {
    return { signal, dispose() {} }
  }

  const controller = new AbortController()
  const forwardUserCancellation = () => {
    if (isExplicitUserCancellation(signal) && !controller.signal.aborted) {
      controller.abort(signal.reason)
    }
  }
  if (signal.aborted) forwardUserCancellation()
  else signal.addEventListener('abort', forwardUserCancellation)

  return {
    signal: controller.signal,
    dispose() {
      signal.removeEventListener('abort', forwardUserCancellation)
    },
  }
}

export const _testing = { USER_CANCELLATION_CODES }
