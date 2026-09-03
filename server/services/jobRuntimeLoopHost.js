import { createJobRuntimeScheduler } from './jobRuntimeScheduler.js'
import { runJobRuntimeTick } from './jobRuntimeTick.js'
import { DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES } from './jobRuntimeTickDependencies.js'

export function createJobRuntimeLoopHost({
  runtime,
  tickMs = 250,
  maxConcurrency = process.env.JOB_RUNTIME_CONCURRENCY,
  runTick = () => runJobRuntimeTick.call(runtime, DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES),
  onError = (error) => console.error('[jobs] tick failed:', error?.stack || error),
} = {}) {
  const activeTicks = new Set()
  let shutdownRequested = false
  let shutdownPromise = null

  const host = {
    activeTicks,
    get shutdownRequested() {
      return shutdownRequested
    },
    get shutdownPromise() {
      return shutdownPromise
    },
    start() {
      if (shutdownRequested) return false
      return scheduler.start()
    },
    stop() {
      scheduler.stop()
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise
      shutdownRequested = true
      shutdownPromise = scheduler.shutdown().then(() => Promise.allSettled([...activeTicks]))
      return shutdownPromise
    },
    runOneTick() {
      if (shutdownRequested) return Promise.resolve(false)
      let tick
      tick = (async () => runTick())().finally(() => activeTicks.delete(tick))
      activeTicks.add(tick)
      return tick
    },
    async drain({ maxTicks = 1000 } = {}) {
      for (let index = 0; index < maxTicks; index += 1) {
        const didWork = await host.runOneTick()
        if (!didWork) return
      }
      throw new Error('job runtime drain exceeded max ticks')
    },
  }
  const scheduler = createJobRuntimeScheduler({
    tickMs,
    maxConcurrency,
    runOneTick: () => host.runOneTick(),
    onError,
  })

  return Object.freeze(host)
}
