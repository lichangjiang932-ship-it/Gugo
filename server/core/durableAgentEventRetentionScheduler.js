import { types as utilTypes } from 'node:util'

/** Runs best-effort outbox retention without coupling it to delivery failures. */
export function createDurableAgentEventRetentionScheduler({
  truncate,
  now,
  schedule,
  cancelSchedule,
  intervalMs,
  onError,
}) {
  let active = false
  let timer = null
  let runPromise = null

  const report = (error) => {
    try {
      onError(error)
    } catch {
      // Maintenance observability cannot change lifecycle correctness.
    }
  }

  const scheduleNext = () => {
    if (!active || timer !== null) return false
    try {
      timer = schedule(() => {
        timer = null
        run()
      }, intervalMs)
      return true
    } catch (error) {
      report(error)
      return false
    }
  }

  const run = () => {
    if (!active || runPromise) return false
    let result
    try {
      result = truncate({ now: now() })
    } catch (error) {
      report(error)
      scheduleNext()
      return false
    }
    const completion = utilTypes.isPromise(result)
      ? Promise.prototype.then.call(result, () => true, (error) => {
        report(error)
        return false
      })
      : Promise.resolve(true)
    const tracked = completion.finally(() => {
      if (runPromise === tracked) runPromise = null
      scheduleNext()
    })
    runPromise = tracked
    return true
  }

  return Object.freeze({
    start() {
      if (active) return false
      active = true
      run()
      return true
    },
    stop() {
      if (!active && timer === null) return false
      active = false
      if (timer === null) return true
      const pending = timer
      timer = null
      try {
        cancelSchedule(pending)
      } catch (error) {
        report(error)
      }
      return true
    },
  })
}
