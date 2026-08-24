import { logger } from '../utils/logger.js'
import { scanEvolutionAutoLoops } from './evolutionAutoLoopService.js'
import { getSession } from './sessionStore.js'

const DEFAULT_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 60 * 60_000

function boundedInterval(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1_000 && number <= MAX_INTERVAL_MS
    ? number
    : DEFAULT_INTERVAL_MS
}

function safeDiagnostic(error) {
  const code = typeof error?.code === 'string' ? error.code.trim().slice(0, 160) : ''
  const message = typeof error?.message === 'string'
    ? error.message.trim().slice(0, 1_000)
    : 'automatic evolution scan failed'
  return Object.freeze({ ...(code ? { code } : {}), message })
}

export function createEvolutionAutoLoopRuntime({
  intervalMs = DEFAULT_INTERVAL_MS,
  env = process.env,
  scan = scanEvolutionAutoLoops,
  readSession = (scope) => getSession(scope),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => logger.warn('[evolution-auto-loop] scan failed:', error.code || error.message),
} = {}) {
  const interval = boundedInterval(intervalMs)
  let started = false
  let closed = false
  let timer = null
  let scanPromise = null
  let controller = null
  let closePromise = null
  let scanCount = 0
  let lastResult = null
  let lastError = null

  function clearScheduledScan() {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  function schedule() {
    if (!started || closed || timer !== null) return
    timer = setTimer(() => {
      timer = null
      void runScan()
    }, interval)
    timer?.unref?.()
  }

  function runScan() {
    if (closed) return Promise.resolve(null)
    if (scanPromise) return scanPromise
    clearScheduledScan()
    controller = new AbortController()
    scanPromise = Promise.resolve().then(() => scan({
      readSession,
      env,
      now: now(),
      signal: controller.signal,
    })).then((result) => {
      scanCount += 1
      lastResult = result || null
      lastError = null
      return result
    }).catch((error) => {
      if (closed && controller?.signal.aborted) return null
      lastResult = null
      lastError = safeDiagnostic(error)
      try { onError(lastError) } catch { /* diagnostics cannot stop the scheduler */ }
      return null
    }).finally(() => {
      scanPromise = null
      controller = null
      if (!closed) schedule()
    })
    return scanPromise
  }

  function start() {
    if (started || closed) return runtime
    started = true
    void runScan()
    return runtime
  }

  function stop() {
    if (closePromise) return closePromise
    closed = true
    clearScheduledScan()
    controller?.abort()
    closePromise = Promise.resolve(scanPromise).then(() => undefined)
    return closePromise
  }

  function state() {
    return Object.freeze({
      started,
      closed,
      scanning: scanPromise !== null,
      scheduled: timer !== null,
      scanCount,
      lastResult,
      lastError,
      intervalMs: interval,
    })
  }

  const runtime = Object.freeze({ start, scan: runScan, stop, state })
  return runtime
}

let singletonRuntime = null
let singletonClosePromise = null

export function startEvolutionAutoLoopRuntime(options = {}) {
  if (!singletonRuntime) {
    singletonClosePromise = null
    singletonRuntime = createEvolutionAutoLoopRuntime(options)
  }
  return singletonRuntime.start()
}

export function closeEvolutionAutoLoopRuntime() {
  if (!singletonRuntime) return singletonClosePromise || Promise.resolve()
  const runtime = singletonRuntime
  singletonClosePromise ||= Promise.resolve(runtime.stop()).then(() => {
    if (singletonRuntime === runtime) singletonRuntime = null
  })
  return singletonClosePromise
}

export function setEvolutionAutoLoopRuntimeForTesting(runtime) {
  singletonRuntime = runtime
  singletonClosePromise = null
  return singletonRuntime
}
