import {
  listEvolutionPromotionOnlineGradeBacklog,
  runEvolutionPromotionOnlineGrade,
} from './evolutionPromotionOnlineGraderService.js'
import { logger } from '../utils/logger.js'

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 8
const DEFAULT_QUEUE_LIMIT = 256
const MAX_QUEUE_LIMIT = 10_000
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const MAX_RETRY_MS = 10 * 60 * 1_000

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback
}

function normalizeTask(value = {}) {
  const task = {
    userId: String(value.userId || '').trim(),
    promotionId: String(value.promotionId || '').trim(),
    outcomeId: String(value.outcomeId || '').trim(),
  }
  if (!task.userId || !task.promotionId || !task.outcomeId) return null
  return task
}

function taskKey(task) {
  return `${task.promotionId}:${task.outcomeId}`
}

function runtimeClosingError() {
  const error = new Error('evolution online grader runtime is closing')
  error.name = 'AbortError'
  error.code = 'EVOLUTION_ONLINE_GRADER_CLOSING'
  return error
}

function isExpectedShutdownAbort(error, signal) {
  return signal.aborted && (
    error === signal.reason
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'EVOLUTION_ONLINE_GRADER_CLOSING'
  )
}

export function createEvolutionOnlineGraderRuntime({
  concurrency = process.env.EVOLUTION_ONLINE_GRADER_CONCURRENCY,
  queueLimit = process.env.EVOLUTION_ONLINE_GRADER_QUEUE_LIMIT,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  runGrade = runEvolutionPromotionOnlineGrade,
  listBacklog = listEvolutionPromotionOnlineGradeBacklog,
  onError = (error, task) => logger.warn(
    `[evolution] production online grade failed for ${task?.promotionId}:${task?.outcomeId}`,
    error?.code || error?.message || error,
  ),
} = {}) {
  const workerCount = boundedInteger(concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY)
  const pendingLimit = boundedInteger(queueLimit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT)
  const retryBase = boundedInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS, 1, MAX_RETRY_MS)
  const retryMaximum = Math.max(
    retryBase,
    boundedInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS, 1, MAX_RETRY_MS),
  )
  const pending = []
  const known = new Set()
  const active = new Map()
  const shutdownController = new AbortController()
  let started = false
  let accepting = false
  let closing = false
  let canceling = false
  let needsBackfill = false
  let refillPromise = null
  let retryTimer = null
  let retryAttempt = 0
  let startPromise = null
  let closePromise = null
  let resolveClose = null

  const schedulePump = () => queueMicrotask(pump)

  function clearRetryTimer() {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  function scheduleRetry() {
    if (closing || retryTimer || !started) return
    const delay = Math.min(retryMaximum, retryBase * (2 ** Math.min(retryAttempt, 20)))
    retryAttempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!closing) void refill()
    }, delay)
    retryTimer.unref?.()
  }

  function add(value, { internal = false } = {}) {
    const task = normalizeTask(value)
    if (!task || closing || (!internal && !accepting)) return false
    const key = taskKey(task)
    if (known.has(key)) return true
    if (pending.length >= pendingLimit) {
      needsBackfill = true
      return false
    }
    known.add(key)
    pending.push(task)
    schedulePump()
    return true
  }

  async function refill() {
    if (closing || refillPromise || !started) return refillPromise
    if (retryTimer) return null
    const available = pendingLimit - pending.length
    if (available <= 0) {
      needsBackfill = true
      return null
    }
    refillPromise = Promise.resolve()
      .then(() => listBacklog({
        limit: Math.min(MAX_QUEUE_LIMIT, available + known.size + 1),
        signal: shutdownController.signal,
      }))
      .then((rows) => {
        if (closing) return 0
        let added = 0
        for (const row of rows || []) {
          if (pending.length >= pendingLimit) break
          if (add(row, { internal: true })) added += 1
        }
        needsBackfill = (rows?.length || 0) > added
        retryAttempt = 0
        return added
      })
      .catch((error) => {
        if (!closing) {
          needsBackfill = true
          try { onError(error, null) } catch { /* diagnostics cannot break retry scheduling */ }
          scheduleRetry()
        }
        return 0
      })
      .finally(() => {
        refillPromise = null
        if (!closing) schedulePump()
      })
    return refillPromise
  }

  function maybeFinishClose() {
    if (!closing || pending.length || active.size) return
    resolveClose?.()
    resolveClose = null
  }

  function pump() {
    while (!canceling && active.size < workerCount && pending.length) {
      const task = pending.shift()
      const key = taskKey(task)
      const promise = Promise.resolve()
        .then(() => runGrade({ ...task, signal: shutdownController.signal }))
        .catch((error) => {
          if (!isExpectedShutdownAbort(error, shutdownController.signal)) onError(error, task)
        })
        .finally(() => {
          active.delete(key)
          known.delete(key)
          if (!closing && needsBackfill && pending.length < pendingLimit) void refill()
          schedulePump()
        })
      active.set(key, promise)
    }
    maybeFinishClose()
  }

  function start() {
    if (closing) return Promise.reject(new Error('evolution online grader runtime is closing'))
    if (startPromise) return startPromise
    started = true
    accepting = true
    startPromise = Promise.resolve(refill()).then(() => undefined)
    return startPromise
  }

  function enqueue(value) {
    return add(value)
  }

  function close({ signal = null } = {}) {
    if (closePromise) return closePromise
    accepting = false
    closing = true
    needsBackfill = false
    clearRetryTimer()
    // Direct callers use close() as a graceful flush boundary. Lifecycle
    // shutdown always supplies its bounded signal and must stop model work
    // immediately so a replacement runtime cannot overlap the old one.
    if (signal) {
      canceling = true
      pending.length = 0
      known.clear()
      shutdownController.abort(signal.aborted ? signal.reason : runtimeClosingError())
    }
    closePromise = new Promise((resolve) => { resolveClose = resolve })
    schedulePump()
    return closePromise
  }

  function state() {
    return {
      started,
      accepting,
      closing,
      pending: pending.length,
      active: active.size,
      needsBackfill,
      concurrency: workerCount,
      queueLimit: pendingLimit,
    }
  }

  return Object.freeze({ start, enqueue, close, state })
}

let singletonRuntime = null
let singletonClosePromise = null

export function startEvolutionOnlineGraderRuntime() {
  if (!singletonRuntime) {
    singletonClosePromise = null
    singletonRuntime = createEvolutionOnlineGraderRuntime()
  }
  return singletonRuntime.start()
}

export function enqueueEvolutionPromotionOutcomeGrade(task) {
  return singletonRuntime?.enqueue(task) || false
}

export function closeEvolutionOnlineGraderRuntime({ signal = null } = {}) {
  if (!singletonRuntime) return singletonClosePromise || Promise.resolve()
  const runtime = singletonRuntime
  singletonClosePromise ||= Promise.resolve(runtime.close({ signal })).then(() => {
    if (singletonRuntime === runtime) singletonRuntime = null
  })
  return singletonClosePromise
}

export function setEvolutionOnlineGraderRuntimeForTesting(runtime) {
  singletonRuntime = runtime
  singletonClosePromise = null
  return singletonRuntime
}
