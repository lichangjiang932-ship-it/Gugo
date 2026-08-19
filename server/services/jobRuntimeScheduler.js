export function createJobRuntimeScheduler({
  runOneTick,
  tickMs = 250,
  maxConcurrency = process.env.JOB_RUNTIME_CONCURRENCY,
  onError = () => {},
} = {}) {
  const parsedConcurrency = Number(maxConcurrency)
  const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
    ? Math.min(32, Math.max(1, Math.floor(parsedConcurrency)))
    : 4
  const inFlight = new Set()
  const idleWaiters = new Set()
  let timer = null
  let shutdownRequested = false
  let shutdownPromise = null

  const notifyIdle = () => {
    if (inFlight.size > 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const dispatchAvailable = () => {
    if (shutdownRequested) return
    const available = Math.max(0, concurrency - inFlight.size)
    for (let index = 0; index < available; index += 1) {
      const task = Promise.resolve()
        .then(() => runOneTick())
        .catch((error) => {
          onError(error)
          return false
        })
        .finally(() => {
          inFlight.delete(task)
          notifyIdle()
        })
      inFlight.add(task)
    }
  }

  const tick = () => {
    if (shutdownRequested) return
    dispatchAvailable()
    if (!timer) return
    timer = setTimeout(tick, tickMs)
    timer.unref?.()
  }

  return {
    start() {
      if (timer || shutdownRequested) return false
      timer = setTimeout(tick, tickMs)
      timer.unref?.()
      return true
    },
    stop() {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    },
    waitForIdle() {
      if (inFlight.size === 0) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.add(resolve))
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      shutdownRequested = true
      this.stop()
      shutdownPromise = this.waitForIdle()
      return shutdownPromise
    },
  }
}
