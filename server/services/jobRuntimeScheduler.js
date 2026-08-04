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
  let timer = null

  const dispatchAvailable = () => {
    const available = Math.max(0, concurrency - inFlight.size)
    for (let index = 0; index < available; index += 1) {
      const task = Promise.resolve()
        .then(() => runOneTick())
        .catch((error) => {
          onError(error)
          return false
        })
        .finally(() => inFlight.delete(task))
      inFlight.add(task)
    }
  }

  const tick = () => {
    dispatchAvailable()
    if (!timer) return
    timer = setTimeout(tick, tickMs)
    timer.unref?.()
  }

  return {
    start() {
      if (timer) return
      timer = setTimeout(tick, tickMs)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearTimeout(timer)
      timer = null
    },
  }
}
