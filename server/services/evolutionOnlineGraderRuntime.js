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

function onlineGraderLimits({ concurrency, queueLimit, retryBaseMs, retryMaxMs }) {
  const workerCount = boundedInteger(concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY)
  const pendingLimit = boundedInteger(queueLimit, DEFAULT_QUEUE_LIMIT, 1, MAX_QUEUE_LIMIT)
  const retryBase = boundedInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS, 1, MAX_RETRY_MS)
  const retryMaximum = Math.max(
    retryBase,
    boundedInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS, 1, MAX_RETRY_MS),
  )
  return { workerCount, pendingLimit, retryBase, retryMaximum }
}

function schedulePump(runtime) {
  queueMicrotask(() => pump(runtime))
}

function clearRetryTimer(runtime) {
  if (!runtime.retryTimer) return
  clearTimeout(runtime.retryTimer)
  runtime.retryTimer = null
}

function scheduleRetry(runtime) {
  if (runtime.closing || runtime.retryTimer || !runtime.started) return
  const delay = Math.min(
    runtime.retryMaximum,
    runtime.retryBase * (2 ** Math.min(runtime.retryAttempt, 20)),
  )
  runtime.retryAttempt += 1
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null
    if (!runtime.closing) void refill(runtime)
  }, delay)
  runtime.retryTimer.unref?.()
}

function add(runtime, value, { internal = false } = {}) {
  const task = normalizeTask(value)
  if (!task || runtime.closing || (!internal && !runtime.accepting)) return false
  const key = taskKey(task)
  if (runtime.known.has(key)) return true
  if (runtime.pending.length >= runtime.pendingLimit) {
    runtime.needsBackfill = true
    return false
  }
  runtime.known.add(key)
  runtime.pending.push(task)
  schedulePump(runtime)
  return true
}

async function refill(runtime) {
  if (runtime.closing || runtime.refillPromise || !runtime.started) return runtime.refillPromise
  if (runtime.retryTimer) return null
  const available = runtime.pendingLimit - runtime.pending.length
  if (available <= 0) {
    runtime.needsBackfill = true
    return null
  }
  runtime.refillPromise = Promise.resolve()
    .then(() => runtime.listBacklog({
      limit: Math.min(MAX_QUEUE_LIMIT, available + runtime.known.size + 1),
      signal: runtime.shutdownController.signal,
    }))
    .then((rows) => {
      if (runtime.closing) return 0
      let added = 0
      for (const row of rows || []) {
        if (runtime.pending.length >= runtime.pendingLimit) break
        if (add(runtime, row, { internal: true })) added += 1
      }
      runtime.needsBackfill = (rows?.length || 0) > added
      runtime.retryAttempt = 0
      return added
    })
    .catch((error) => {
      if (!runtime.closing) {
        runtime.needsBackfill = true
        try { runtime.onError(error, null) } catch { /* diagnostics cannot break retry scheduling */ }
        scheduleRetry(runtime)
      }
      return 0
    })
    .finally(() => {
      runtime.refillPromise = null
      if (!runtime.closing) schedulePump(runtime)
    })
  return runtime.refillPromise
}

function maybeFinishClose(runtime) {
  if (!runtime.closing || runtime.pending.length || runtime.active.size) return
  runtime.resolveClose?.()
  runtime.resolveClose = null
}

function pump(runtime) {
  while (!runtime.canceling
    && runtime.active.size < runtime.workerCount
    && runtime.pending.length) {
    const task = runtime.pending.shift()
    const key = taskKey(task)
    const promise = Promise.resolve()
      .then(() => runtime.runGrade({ ...task, signal: runtime.shutdownController.signal }))
      .catch((error) => {
        if (!isExpectedShutdownAbort(error, runtime.shutdownController.signal)) {
          runtime.onError(error, task)
        }
      })
      .finally(() => {
        runtime.active.delete(key)
        runtime.known.delete(key)
        if (!runtime.closing && runtime.needsBackfill
          && runtime.pending.length < runtime.pendingLimit) void refill(runtime)
        schedulePump(runtime)
      })
    runtime.active.set(key, promise)
  }
  maybeFinishClose(runtime)
}

function startRuntime(runtime) {
  if (runtime.closing) return Promise.reject(new Error('evolution online grader runtime is closing'))
  if (runtime.startPromise) return runtime.startPromise
  runtime.started = true
  runtime.accepting = true
  runtime.startPromise = Promise.resolve(refill(runtime)).then(() => undefined)
  return runtime.startPromise
}

function closeRuntime(runtime, { signal = null } = {}) {
  if (runtime.closePromise) return runtime.closePromise
  runtime.accepting = false
  runtime.closing = true
  runtime.needsBackfill = false
  clearRetryTimer(runtime)
  // Lifecycle shutdown supplies a bounded signal and cancels immediately;
  // direct close remains a graceful queue flush boundary.
  if (signal) {
    runtime.canceling = true
    runtime.pending.length = 0
    runtime.known.clear()
    runtime.shutdownController.abort(signal.aborted ? signal.reason : runtimeClosingError())
  }
  runtime.closePromise = new Promise((resolve) => { runtime.resolveClose = resolve })
  schedulePump(runtime)
  return runtime.closePromise
}

function runtimeState(runtime) {
  return {
    started: runtime.started,
    accepting: runtime.accepting,
    closing: runtime.closing,
    pending: runtime.pending.length,
    active: runtime.active.size,
    needsBackfill: runtime.needsBackfill,
    concurrency: runtime.workerCount,
    queueLimit: runtime.pendingLimit,
  }
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
  const limits = onlineGraderLimits({ concurrency, queueLimit, retryBaseMs, retryMaxMs })
  const runtime = {
    ...limits,
    runGrade,
    listBacklog,
    onError,
    pending: [],
    known: new Set(),
    active: new Map(),
    shutdownController: new AbortController(),
    started: false,
    accepting: false,
    closing: false,
    canceling: false,
    needsBackfill: false,
    refillPromise: null,
    retryTimer: null,
    retryAttempt: 0,
    startPromise: null,
    closePromise: null,
    resolveClose: null,
  }
  return Object.freeze({
    start: () => startRuntime(runtime),
    enqueue: (value) => add(runtime, value),
    close: (options) => closeRuntime(runtime, options),
    state: () => runtimeState(runtime),
  })
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
