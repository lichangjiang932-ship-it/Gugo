const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'cancelled', 'aborted'])

function defaultListenerErrorHandler(error) {
  console.error('[jobs] listener error:', error?.stack || error)
}

export function createJobRuntimeEventHub({
  resolveJobOwner,
  onListenerError = defaultListenerErrorHandler,
} = {}) {
  if (typeof resolveJobOwner !== 'function') {
    throw new TypeError('createJobRuntimeEventHub requires resolveJobOwner')
  }
  if (typeof onListenerError !== 'function') {
    throw new TypeError('createJobRuntimeEventHub requires onListenerError to be a function')
  }

  const listeners = new Map()
  const jobOwners = new Map()

  function cacheJobOwner(jobId, userId) {
    if (typeof jobId !== 'string' || !jobId.trim()
      || typeof userId !== 'string' || !userId.trim()) {
      throw new TypeError('cacheJobOwner requires non-empty jobId and userId strings')
    }
    jobOwners.set(jobId, userId)
  }

  function resolveCachedJobOwner(jobId) {
    if (jobOwners.has(jobId)) return jobOwners.get(jobId)
    const resolvedOwner = resolveJobOwner(jobId)
    const userId = typeof resolvedOwner === 'string' && resolvedOwner.trim()
      ? resolvedOwner
      : null
    // Unknown jobs are fail-closed, but are not retained as negative cache
    // entries. A later durable create/recovery may make the owner resolvable.
    if (userId) jobOwners.set(jobId, userId)
    return userId
  }

  function reportListenerError(error) {
    try {
      onListenerError(error)
    } catch {
      // Diagnostics must never affect event delivery or owner eviction.
    }
  }

  function deliver(listener, event) {
    try {
      const outcome = listener(event)
      if (outcome && typeof outcome.then === 'function') {
        Promise.resolve(outcome).catch(reportListenerError)
      }
    } catch (error) {
      reportListenerError(error)
    }
  }

  function emit(event) {
    if (!event) return
    const jobId = event.jobId || event.job_id
    const eventOwner = jobId ? resolveCachedJobOwner(jobId) : null
    const evictOwner = jobId && TERMINAL_EVENT_TYPES.has(event.type)
    try {
      for (const [listener, listenerUserId] of listeners) {
        try {
          if (listenerUserId == null || (eventOwner && eventOwner === listenerUserId)) {
            deliver(listener, event)
          }
        } catch (error) {
          reportListenerError(error)
        }
      }
    } finally {
      // Keep the owner available while dispatching the terminal event, then
      // release it so a long-lived runtime cannot retain every completed job.
      if (evictOwner) jobOwners.delete(jobId)
    }
  }

  function subscribe(userIdOrListener, maybeListener) {
    const isGlobalSubscription = arguments.length === 1
      && typeof userIdOrListener === 'function'
    if (!isGlobalSubscription && (
      arguments.length !== 2
      || typeof userIdOrListener !== 'string'
      || !userIdOrListener.trim()
      || typeof maybeListener !== 'function'
    )) {
      throw new TypeError('subscribe requires a listener or a non-empty userId and listener')
    }
    const listener = isGlobalSubscription ? userIdOrListener : maybeListener
    const userId = isGlobalSubscription ? null : userIdOrListener
    listeners.set(listener, userId)
    return () => listeners.delete(listener)
  }

  function listenerCount() {
    return listeners.size
  }

  return Object.freeze({
    cacheJobOwner,
    emit,
    listenerCount,
    subscribe,
  })
}
