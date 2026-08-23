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

function authoritativeCommittedEntries(batch, result) {
  if (!Array.isArray(result) || result.length !== batch.length) return []
  const entries = []
  for (let index = 0; index < batch.length; index += 1) {
    const requested = batch[index]
    const requestedEvent = requested?.event
    const storedEvent = result[index]
    if (!requested || typeof requested !== 'object'
      || !requestedEvent || typeof requestedEvent !== 'object'
      || !storedEvent || typeof storedEvent !== 'object'
      || storedEvent.sessionId !== requestedEvent.sessionId
      || storedEvent.turnId !== requestedEvent.turnId
      || storedEvent.sequence !== requestedEvent.sequence
      || storedEvent.type !== requestedEvent.type) {
      // A custom adapter without an exact per-entry receipt cannot safely feed
      // live observers. Persistence still succeeds; observability degrades.
      return []
    }
    entries.push({
      userId: requested.userId,
      event: storedEvent,
      checkpointState: requested.checkpointState ?? null,
    })
  }
  return entries
}

function terminalFenceError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    if (String(current?.code || '').trim().toUpperCase() === 'TURN_ALREADY_TERMINAL') return current
    seen.add(current)
    current = current?.cause
  }
  return null
}

function batchFailureMetadata(batch) {
  const entries = Array.isArray(batch) ? batch : []
  const sequences = entries
    .map((item) => item?.event?.sequence)
    .filter(Number.isInteger)
  return {
    count: entries.length,
    eventTypes: [...new Set(entries
      .map((item) => String(item?.event?.type || '').trim())
      .filter(Boolean))].slice(0, 32),
    firstSequence: sequences.length > 0 ? Math.min(...sequences) : null,
    lastSequence: sequences.length > 0 ? Math.max(...sequences) : null,
  }
}

/**
 * A durability barrier failure. The failed batch has already exhausted its
 * retries and, when configured, has been copied to the write-failure journal.
 * Callers must treat this as a failed Turn boundary rather than continuing to
 * a checkpoint or successful terminal event.
 */
export class EventWriteBehindError extends Error {
  constructor({ batch = [], cause = null, attempts = 1, failedAt = Date.now() } = {}) {
    const metadata = batchFailureMetadata(batch)
    const causeDetail = cause ? errorMessage(cause) : ''
    super(`Failed to persist ${metadata.count} turn event(s) after ${attempts} attempt(s)${causeDetail ? `: ${causeDetail}` : ''}`, {
      ...(cause ? { cause } : {}),
    })
    this.name = 'EventWriteBehindError'
    this.code = 'TURN_EVENT_PERSISTENCE_FAILED'
    this.status = 503
    this.retryable = true
    this.attempts = Math.max(1, Math.floor(Number(attempts) || 1))
    this.failedAt = Math.max(0, Math.floor(Number(failedAt) || Date.now()))
    this.failedEventCount = metadata.count
    this.blockedEventCount = 0
    this.failedEventTypes = metadata.eventTypes
    this.firstFailedSequence = metadata.firstSequence
    this.lastFailedSequence = metadata.lastSequence
    this.failedEntries = [...(Array.isArray(batch) ? batch : [])]
  }

  include(batch, { blocked = false } = {}) {
    const metadata = batchFailureMetadata(batch)
    this.failedEntries.push(...(Array.isArray(batch) ? batch : []))
    this.failedEventCount += metadata.count
    if (blocked) this.blockedEventCount += metadata.count
    this.failedEventTypes = [...new Set([...this.failedEventTypes, ...metadata.eventTypes])].slice(0, 32)
    if (metadata.firstSequence !== null) {
      this.firstFailedSequence = this.firstFailedSequence === null
        ? metadata.firstSequence
        : Math.min(this.firstFailedSequence, metadata.firstSequence)
      this.lastFailedSequence = this.lastFailedSequence === null
        ? metadata.lastSequence
        : Math.max(this.lastFailedSequence, metadata.lastSequence)
    }
    return this
  }
}

/**
 * Bounded write-behind queue for high-frequency, replayable events.
 *
 * enqueue() only accepts an immutable snapshot and never exposes the queued
 * object again. flush() is the durability barrier used before checkpoints,
 * tools, and terminal events. Exhausted background writes are reported through
 * recordFailure and make the next durability barrier reject. A barrier observes
 * all failures accumulated before it; later writes may then start a new ordered
 * generation, which lets the caller persist a structured failed terminal event.
 */
export function createEventWriteBehind({
  writeBatch,
  writeBatchSync = null,
  recordFailure = null,
  recordEmergencyFailure = null,
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
  let activeFlush = null
  let closePromise = null
  let barrierFailure = null
  let committedSinceBarrier = []
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

  const reportFailure = async (batch, error, { attempts = safeMaxAttempts, blocked = false } = {}) => {
    const failedAt = Math.max(0, Math.floor(Number(now()) || Date.now()))
    const underlyingError = error?.cause || error
    stats.failedEvents += batch.length
    stats.failedBatches += 1
    stats.lastFailureAt = failedAt
    stats.lastError = errorMessage(underlyingError)
    if (barrierFailure) {
      barrierFailure.include(batch, { blocked })
    } else {
      barrierFailure = new EventWriteBehindError({
        batch,
        cause: underlyingError,
        attempts: Math.max(1, attempts),
        failedAt,
      })
      if (blocked) barrierFailure.blockedEventCount += batch.length
    }
    try {
      await recordFailure?.({
        batch,
        error: underlyingError,
        errorMessage: stats.lastError,
        attempts: Math.max(1, attempts),
        failedAt,
        blocked,
      })
    } catch (recordError) {
      logger?.error?.('[event-write-behind] failed to persist write failure:', errorMessage(recordError))
      try {
        await recordEmergencyFailure?.({
          batch,
          error: underlyingError,
          errorMessage: stats.lastError,
          attempts: Math.max(1, attempts),
          failedAt,
          blocked,
          journalError: recordError,
        })
      } catch (emergencyError) {
        logger?.error?.(
          '[event-write-behind] failed to persist emergency failure journal:',
          errorMessage(emergencyError),
        )
      }
    }
    logger?.error?.(
      `[event-write-behind] ${blocked ? 'blocked' : 'failed to persist'} ${batch.length} event(s) after ${Math.max(0, attempts)} attempt(s):`,
      stats.lastError,
    )
    return barrierFailure
  }

  const writeWithRetry = async (batch, writer = writeBatch) => {
    // Once an earlier ordered batch is missing, later batches in the same
    // generation must not leapfrog it. The next explicit flush observes and
    // clears the generation failure before any new generation can be written.
    if (barrierFailure) {
      if (terminalFenceError(barrierFailure)) {
        barrierFailure.include(batch, { blocked: true })
        return { ok: false, error: barrierFailure, attempts: 0, blocked: true }
      }
      const failure = await reportFailure(batch, barrierFailure, { attempts: 0, blocked: true })
      return { ok: false, error: failure, attempts: 0, blocked: true }
    }
    let lastError = null
    for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
      try {
        const result = await writer(batch)
        stats.batches += 1
        stats.written += batch.length
        committedSinceBarrier.push(...authoritativeCommittedEntries(batch, result))
        return { ok: true, result, attempts: attempt }
      } catch (error) {
        lastError = error
        const fence = terminalFenceError(error)
        if (fence) {
          const failedAt = Math.max(0, Math.floor(Number(now()) || Date.now()))
          stats.failedEvents += batch.length
          stats.failedBatches += 1
          stats.lastFailureAt = failedAt
          stats.lastError = errorMessage(fence)
          barrierFailure = new EventWriteBehindError({
            batch,
            cause: fence,
            attempts: attempt,
            failedAt,
          })
          barrierFailure.retryable = false
          return { ok: false, error: barrierFailure, attempts: attempt }
        }
        if (attempt < safeMaxAttempts) stats.retries += 1
      }
    }
    const failure = await reportFailure(batch, lastError)
    return { ok: false, error: failure, attempts: safeMaxAttempts }
  }

  const queueBatch = (batch, writer = writeBatch) => {
    const operation = tail.then(() => writeWithRetry(batch, writer))
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

  const queueOverflowBatch = (batch) => {
    const writer = typeof writeBatchSync === 'function' ? writeBatchSync : writeBatch
    // Even an explicitly synchronous writer goes through the same tail. This
    // prevents an overflow batch from overtaking a timer-triggered async batch
    // in alternate stores while still keeping the in-memory pending list bounded.
    queueBatch(batch, writer).catch(() => {})
  }

  const runFlush = async () => {
    clearScheduledFlush()
    while (pending.length > 0) {
      drainPending()
      await tail
    }
    await tail
    if (barrierFailure) {
      const failure = barrierFailure
      barrierFailure = null
      // A failed ordered generation is not a safe live-delivery boundary,
      // even if an earlier sub-batch happened to reach storage.
      committedSinceBarrier = []
      failure.stats = snapshotStats()
      throw failure
    }
    const committedEntries = committedSinceBarrier
    committedSinceBarrier = []
    return { ...snapshotStats(), committedEntries }
  }

  const flush = () => {
    // All callers waiting on the same in-progress durability boundary must
    // observe the same outcome. In particular, one caller must not consume a
    // failure while another concurrent caller reports success.
    if (activeFlush) return activeFlush
    const operation = runFlush()
    activeFlush = operation
    operation.then(
      () => { if (activeFlush === operation) activeFlush = null },
      () => { if (activeFlush === operation) activeFlush = null },
    )
    return operation
  }

  const close = () => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      // If close races an already active flush, await that boundary and then
      // execute one final boundary. Setting closed first guarantees that the
      // second boundary cannot miss a concurrent enqueue.
      if (activeFlush) await activeFlush
      return flush()
    })()
    return closePromise
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
        queueOverflowBatch(takePending())
      } else {
        scheduleFlush()
      }
      return queued
    },

    flush,

    close,

    getStats: snapshotStats,
  })
}
