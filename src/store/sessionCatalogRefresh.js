export const SESSION_CATALOG_REFRESH_DEBOUNCE_MS = 200
export const SESSION_CATALOG_REFRESH_COOLDOWN_MS = 5_000
export const SESSION_CATALOG_REFRESH_INTERVAL_MS = 30_000

export function isSessionCatalogRefreshVisible(documentTarget = globalThis.document) {
  return !documentTarget || documentTarget.visibilityState !== 'hidden'
}

export function createSessionCatalogRefreshScheduler({
  task,
  canRun = () => true,
  debounceMs = SESSION_CATALOG_REFRESH_DEBOUNCE_MS,
  cooldownMs = SESSION_CATALOG_REFRESH_COOLDOWN_MS,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onError = (error) => console.warn('[AppContext] session catalog refresh failed:', error?.code || error?.message || error),
}) {
  let stopped = false
  let timer = null
  let inFlight = null
  let queued = false
  let lastStartedAt = Number.NEGATIVE_INFINITY

  const clearScheduled = () => {
    if (timer == null) return
    clearTimeoutFn(timer)
    timer = null
  }

  const run = async () => {
    if (stopped || !canRun()) return null
    if (inFlight) {
      queued = true
      return inFlight
    }

    clearScheduled()
    lastStartedAt = now()
    const current = Promise.resolve().then(task)
    inFlight = current
    try {
      return await current
    } catch (error) {
      onError(error)
      return null
    } finally {
      if (inFlight === current) inFlight = null
      if (queued && !stopped) {
        queued = false
        schedule()
      }
    }
  }

  function schedule() {
    if (stopped || !canRun()) return
    if (inFlight) {
      queued = true
      return
    }
    const elapsed = now() - lastStartedAt
    const delay = Math.max(debounceMs, cooldownMs - elapsed)
    clearScheduled()
    timer = setTimeoutFn(() => {
      timer = null
      void run()
    }, Math.max(0, delay))
  }

  return {
    run,
    schedule,
    stop() {
      stopped = true
      queued = false
      clearScheduled()
    },
  }
}

export function attachSessionCatalogRefreshLifecycle({
  scheduler,
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  intervalMs = SESSION_CATALOG_REFRESH_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const scheduleWhenVisible = () => {
    if (isSessionCatalogRefreshVisible(documentTarget)) scheduler.schedule()
  }
  windowTarget?.addEventListener?.('focus', scheduleWhenVisible)
  documentTarget?.addEventListener?.('visibilitychange', scheduleWhenVisible)
  const interval = setIntervalFn(scheduleWhenVisible, intervalMs)

  return () => {
    windowTarget?.removeEventListener?.('focus', scheduleWhenVisible)
    documentTarget?.removeEventListener?.('visibilitychange', scheduleWhenVisible)
    clearIntervalFn(interval)
    scheduler.stop()
  }
}
