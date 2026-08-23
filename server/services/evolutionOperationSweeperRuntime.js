import { logger } from '../utils/logger.js'
import { sweepExpiredEvolutionOperations } from './evolutionOperationService.js'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 1_000
const DEFAULT_BATCH_SIZE = 64
const MAX_INTERVAL_MS = 10 * 60_000
const MAX_BATCH_SIZE = 1_000
const MAX_ERROR_CODE_LENGTH = 200
const MAX_ERROR_MESSAGE_LENGTH = 1_000

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback
}

function ownString(error, key, maximum) {
  if ((!error || typeof error !== 'object') && typeof error !== 'function') return ''
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value.trim().slice(0, maximum)
      : ''
  } catch {
    return ''
  }
}

function isBusyError(error) {
  const code = ownString(error, 'code', MAX_ERROR_CODE_LENGTH)
  return code.startsWith('SQLITE_BUSY') || code === 'EVOLUTION_OPERATION_SWEEP_BUSY'
}

function sanitizeErrorDiagnostic(error) {
  const code = ownString(error, 'code', MAX_ERROR_CODE_LENGTH)
  const message = ownString(error, 'message', MAX_ERROR_MESSAGE_LENGTH)
  return Object.freeze({
    ...(code ? { code } : {}),
    message: message || 'evolution operation sweep failed',
  })
}

export function createEvolutionOperationSweeperRuntime({
  intervalMs = DEFAULT_INTERVAL_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  sweep = sweepExpiredEvolutionOperations,
  now = Date.now,
  monotonicNow,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = (error) => logger.warn(
    '[evolution-operation-sweeper] scan failed:',
    error.code || error.message,
  ),
} = {}) {
  const interval = boundedInteger(intervalMs, DEFAULT_INTERVAL_MS, 1, MAX_INTERVAL_MS)
  const retryDelay = boundedInteger(
    retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    1,
    MAX_INTERVAL_MS,
  )
  const limit = boundedInteger(batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)
  let started = false
  let closed = false
  let timer = null
  let scanPromise = null
  let closePromise = null
  let scanCount = 0
  let lastResult = null
  let lastError = null
  let retryPending = false

  function clearScheduledScan() {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  function schedule(delayMs) {
    if (!started || closed || timer !== null) return
    timer = setTimer(() => {
      timer = null
      void scan()
    }, delayMs)
    timer?.unref?.()
  }

  function scan() {
    if (closed) return Promise.resolve(null)
    if (scanPromise) return scanPromise
    clearScheduledScan()
    scanPromise = Promise.resolve()
      .then(() => sweep({
        limit,
        now: now(),
        ...(typeof monotonicNow === 'function' ? { monotonicNow } : {}),
      }))
      .then((result) => {
        scanCount += 1
        lastResult = result || null
        lastError = null
        retryPending = false
        return result
      })
      .catch((error) => {
        retryPending = isBusyError(error)
        lastResult = null
        lastError = sanitizeErrorDiagnostic(error)
        try { onError(lastError) } catch { /* diagnostics must not break scheduling */ }
        return null
      })
      .finally(() => {
        const retry = retryPending
        retryPending = false
        scanPromise = null
        if (!closed) schedule(retry ? retryDelay : (lastResult?.hasMore ? 0 : interval))
      })
    return scanPromise
  }

  function start() {
    if (started || closed) return runtime
    started = true
    void scan()
    return runtime
  }

  function stop() {
    if (closePromise) return closePromise
    closed = true
    clearScheduledScan()
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
      retryDelayMs: retryDelay,
      batchSize: limit,
    })
  }

  const runtime = Object.freeze({ start, scan, stop, state })
  return runtime
}

let singletonRuntime = null
let singletonClosePromise = null

export function startEvolutionOperationSweeperRuntime() {
  if (!singletonRuntime) {
    singletonClosePromise = null
    singletonRuntime = createEvolutionOperationSweeperRuntime()
  }
  return singletonRuntime.start()
}

export function closeEvolutionOperationSweeperRuntime() {
  if (!singletonRuntime) return singletonClosePromise || Promise.resolve()
  const runtime = singletonRuntime
  singletonClosePromise ||= Promise.resolve(runtime.stop()).then(() => {
    if (singletonRuntime === runtime) singletonRuntime = null
  })
  return singletonClosePromise
}

export function setEvolutionOperationSweeperRuntimeForTesting(runtime) {
  singletonRuntime = runtime
  singletonClosePromise = null
  return singletonRuntime
}
