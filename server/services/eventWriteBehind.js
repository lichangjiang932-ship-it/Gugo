export const DEFAULT_EVENT_WRITE_MAX_DELAY_MS = 50
export const DEFAULT_EVENT_WRITE_MAX_QUEUE_SIZE = 1_000
export const DEFAULT_EVENT_WRITE_MAX_ATTEMPTS = 3

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min) return fallback
  return Math.min(max, parsed)
}

function cloneForQueue(value, clone) {
  if (typeof clone === 'function') return clone(value)
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function errorMessage(error) {
  return String(error?.message || error || 'event write failed').slice(0, 2_000)
}

/**
 * Bounded write-behind queue for high-frequency, replayable events.
 *
 * enqueue() only accepts an immutable snapshot and never exposes the queued
 * object again. flush() is the durability barrier used before checkpoints,
 * tools, and terminal events. Exhausted background writes are reported through
 * recordFailure without rejecting the producer.
 */
export function createEventWriteBehind({
  writeBatch,
  writeBatchSync = null,
  recordFailure = null,
  logger = console,
  clone = null,
  maxDelayMs = DEFAULT_EVENT_WRITE_MAX_DELAY_MS,
  maxQueueSize = DEFAULT_EVENT_WRITE_MAX_QUEUE_SIZE,
  maxAttempts = DEFAULT_EVENT_WRITE_MAX_ATTEMPTS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof writeBatch !== 'function') throw new TypeError('writeBatch is required')
  const safeDelayMs = boundedInteger(maxDelayMs, DEFAULT_EVENT_WRITE_MAX_DELAY_MS, { min: 0, max: 60_000 })
  const safeMaxQueueSize = boundedInteger(
    maxQueueSize,
    DEFAULT_EVENT_WRITE_MAX_QUEUE_SIZE,
    { min: 1, max: 1_000_000 },
  )
  const safeMaxAttempts = boundedInteger(
    maxAttempts,
    DEFAULT_EVENT_WRITE_MAX_ATTEMPTS,
    { min: 1, max: 20 },
  )
  let pending = []
  let timer = null
  let tail = Promise.resolve()
  let closed = false
  const stats = {
    enqueued: 0,
    written: 0,
    batches: 0,
    retries: 0,
    failedEvents: 0,
    failedBatches: 0,
    overflowFlushes: 0,
    lastFailureAt: null,
    lastError: null,
  }

  const snapshotStats = () => ({ ...stats, pending: pending.length })

  const clearScheduledFlush = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const reportFailure = async (batch, error) => {
    const failedAt = Math.max(0, Math.floor(Number(now()) || Date.now()))
    stats.failedEvents += batch.length
    stats.failedBatches += 1
    stats.lastFailureAt = failedAt
    stats.lastError = errorMessage(error)
    try {
      await recordFailure?.({
        batch,
        error,
        errorMessage: stats.lastError,
        attempts: safeMaxAttempts,
        failedAt,
      })
    } catch (recordError) {
      logger?.error?.('[event-write-behind] failed to persist write failure:', errorMessage(recordError))
    }
    logger?.error?.(
      `[event-write-behind] dropped ${batch.length} event(s) after ${safeMaxAttempts} attempts:`,
      stats.lastError,
    )
  }

  const writeWithRetry = async (batch, writer = writeBatch) => {
    let lastError = null
    for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
      try {
        const result = await writer(batch)
        stats.batches += 1
        stats.written += batch.length
        return { ok: true, result, attempts: attempt }
      } catch (error) {
        lastError = error
        if (attempt < safeMaxAttempts) stats.retries += 1
      }
    }
    await reportFailure(batch, lastError)
    return { ok: false, error: lastError, attempts: safeMaxAttempts }
  }

  const queueBatch = (batch) => {
    const operation = tail.then(() => writeWithRetry(batch))
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  const takePending = () => {
    if (pending.length === 0) return []
    const batch = pending
    pending = []
    return batch
  }

  const drainPending = () => {
    clearScheduledFlush()
    const batch = takePending()
    return batch.length > 0 ? queueBatch(batch) : tail
  }

  const scheduleFlush = () => {
    if (timer !== null || pending.length === 0) return
    timer = setTimer(() => {
      timer = null
      drainPending().catch(() => {})
    }, safeDelayMs)
    timer?.unref?.()
  }

  const writeOverflowSynchronously = (batch) => {
    const writer = typeof writeBatchSync === 'function' ? writeBatchSync : writeBatch
    // The production writer is better-sqlite3 and therefore completes before
    // this call returns. Promise-based injected writers still remain ordered by
    // the returned tail, which keeps tests and alternate stores deterministic.
    const operation = writeWithRetry(batch, writer)
    tail = Promise.all([tail, operation]).then(() => undefined, () => undefined)
  }

  return Object.freeze({
    enqueue(value) {
      if (closed) throw new Error('event write-behind is closed')
      const queued = cloneForQueue(value, clone)
      pending.push(queued)
      stats.enqueued += 1
      if (pending.length > safeMaxQueueSize) {
        clearScheduledFlush()
        stats.overflowFlushes += 1
        writeOverflowSynchronously(takePending())
      } else {
        scheduleFlush()
      }
      return queued
    },

    async flush() {
      clearScheduledFlush()
      while (pending.length > 0) {
        drainPending()
        await tail
      }
      await tail
      return snapshotStats()
    },

    async close() {
      if (closed) return snapshotStats()
      await this.flush()
      closed = true
      return snapshotStats()
    },

    getStats: snapshotStats,
  })
}
