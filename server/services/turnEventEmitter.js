import { createTurnEvent } from '../../shared/turnEvents.js'
import { EventWriteBehindError, findTurnEventFenceError } from './eventWriteBehind.js'
import { publishCommittedAgentEvent } from '../core/agentEventConsumerRuntime.js'
import { logWarn } from '../utils/logger.js'

export const TURN_EVENT_PERSISTENCE_FAILURE_CODE = 'TURN_EVENT_PERSISTENCE_FAILED'
export const TURN_TERMINAL_PERSISTENCE_FAILURE_CODE = 'TURN_TERMINAL_PERSISTENCE_FAILED'

const DEFERRED_EVENT_TYPES = new Set(['assistant.delta', 'reasoning.delta'])
const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'turn.cancelled', 'turn.failed'])
const DURABLE_BOUNDARY_EVENT_TYPES = new Set([
  ...TERMINAL_EVENT_TYPES,
  'turn.paused',
  'turn.interrupted',
  'turn.blocked',
])

export function isTerminalTurnEventType(value) {
  return TERMINAL_EVENT_TYPES.has(String(value || ''))
}

export function isDurableTurnBoundaryEventType(value) {
  return DURABLE_BOUNDARY_EVENT_TYPES.has(String(value || ''))
}

export function findEventPersistenceFailure(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth += 1) {
    if (String(current?.code || '').trim().toUpperCase() === TURN_EVENT_PERSISTENCE_FAILURE_CODE) {
      return current
    }
    seen.add(current)
    current = current?.cause
  }
  return null
}

export function createTerminalPersistenceFailure(error, eventType = 'turn.failed') {
  if (String(error?.code || '').trim().toUpperCase() === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE) {
    return error
  }
  const detail = String(error?.message || error || '').trim()
  return Object.assign(
    new Error(
      `Failed to durably append ${eventType}; terminal outcome is unknown${detail ? `: ${detail}` : ''}`,
      { cause: error },
    ),
    {
      code: TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
      status: 503,
      retryable: true,
      boundaryEventType: eventType,
      terminalEventType: eventType,
    },
  )
}

function defaultClosedError() {
  return Object.assign(new Error('turn event emitter is closed'), {
    code: 'TURN_EVENT_EMITTER_CLOSED',
    status: 503,
  })
}

function defaultVerifyEventCommit({ event, storedEvent } = {}) {
  const committed = Boolean(storedEvent
    && storedEvent.id === event?.id
    && storedEvent.sessionId === event?.sessionId
    && storedEvent.turnId === event?.turnId
    && storedEvent.sequence === event?.sequence
    && storedEvent.type === event?.type)
  return {
    committed,
    receipt: committed ? {
      eventId: storedEvent.id,
      sessionId: storedEvent.sessionId,
      turnId: storedEvent.turnId,
      sequence: storedEvent.sequence,
      type: storedEvent.type,
    } : null,
  }
}

function unverifiedCommitError(event, verification) {
  return Object.assign(new Error(`turn event commit could not be verified at sequence ${event.sequence}`), {
    code: 'TURN_EVENT_COMMIT_UNVERIFIED',
    status: 503,
    retryable: true,
    verification: verification || null,
  })
}

function failureCount(value) {
  const parsed = Number(value?.failedEvents)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function failureSignal(value) {
  if (!value || typeof value !== 'object') return null
  const failedEvents = failureCount(value)
  const parsedBatches = Number(value.failedBatches)
  const failedBatches = Number.isInteger(parsedBatches) && parsedBatches >= 0
    ? parsedBatches
    : null
  if (failedEvents === null && failedBatches === null) return null
  return {
    hasFailure: (failedEvents || 0) > 0 || (failedBatches || 0) > 0,
    key: JSON.stringify([
      failedEvents,
      failedBatches,
      value.lastFailureAt ?? null,
      String(value.lastError || ''),
    ]),
  }
}

function writerStats(writer) {
  try {
    return typeof writer?.getStats === 'function' ? writer.getStats() : null
  } catch {
    return null
  }
}

function reportedBarrierFailure(result, fallbackBatch, now) {
  const explicitBatch = Array.isArray(result?.failedEntries)
    ? result.failedEntries
    : Array.isArray(result?.batch) ? result.batch : null
  const batch = explicitBatch?.length ? explicitBatch : fallbackBatch
  const cause = result?.error instanceof Error
    ? result.error
    : new Error(String(result?.lastError || 'event writer reported a failed durability barrier'))
  const existing = findEventPersistenceFailure(cause)
  if (existing) {
    if (existing.firstFailedSequence === null
      && batch.length > 0
      && typeof existing.include === 'function') {
      existing.include(batch)
    }
    return existing
  }
  return new EventWriteBehindError({
    batch,
    cause,
    attempts: Math.max(1, Math.floor(Number(result?.attempts) || 1)),
    failedAt: now(),
  })
}

function authoritativeDeferredEntries(result, requestedBatch) {
  const committed = Array.isArray(result?.committedEntries) ? result.committedEntries : []
  if (committed.length !== requestedBatch.length) return []
  for (let index = 0; index < committed.length; index += 1) {
    const requested = requestedBatch[index]
    const stored = committed[index]
    if (stored?.userId !== requested?.userId
      || stored?.event?.sessionId !== requested?.event?.sessionId
      || stored?.event?.turnId !== requested?.event?.turnId
      || stored?.event?.sequence !== requested?.event?.sequence
      || stored?.event?.type !== requested?.event?.type) return []
  }
  return committed
}

/**
 * Ordered Session Log writer for one Turn.
 *
 * High-frequency replayable deltas may be buffered, while checkpoints,
 * lifecycle transitions, and terminal events always cross a durability
 * barrier first. All persistence mechanisms are injected so the Turn runtime
 * is not coupled to SQLite or to a particular Session Log implementation.
 */
export function createTurnEventEmitter({
  userId,
  sessionId,
  turnId,
  sequence = 0,
  idFactory,
  now = Date.now,
  appendEvent,
  verifyEventCommit = defaultVerifyEventCommit,
  createEventWriteBehind,
  recordEventWriteFailure = null,
  recordEmergencyFailure = null,
  createClosedError = defaultClosedError,
  onWriterOpen = null,
  onWriterClose = null,
  publishCommittedEvent = publishCommittedAgentEvent,
  warn = logWarn,
} = {}) {
  if (!userId) throw new TypeError('userId is required')
  if (!sessionId) throw new TypeError('sessionId is required')
  if (!turnId) throw new TypeError('turnId is required')
  if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError('sequence must be a non-negative integer')
  if (typeof idFactory !== 'function') throw new TypeError('idFactory is required')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (typeof appendEvent !== 'function') throw new TypeError('appendEvent is required')
  if (typeof verifyEventCommit !== 'function') throw new TypeError('verifyEventCommit is required')
  if (typeof createEventWriteBehind !== 'function') throw new TypeError('createEventWriteBehind is required')
  if (typeof publishCommittedEvent !== 'function') throw new TypeError('publishCommittedEvent must be a function')

  let nextSequence = sequence
  let appendQueue = Promise.resolve()
  let closed = false
  let closePromise = null
  let deferredSinceBarrier = []
  let executionLease = null
  const eventWriteBehind = createEventWriteBehind()
  if (!eventWriteBehind
    || typeof eventWriteBehind.enqueue !== 'function'
    || typeof eventWriteBehind.flush !== 'function') {
    throw new TypeError('eventWriteBehindFactory must return an event write-behind queue')
  }
  onWriterOpen?.(eventWriteBehind)
  let observedFailureSignal = failureSignal(writerStats(eventWriteBehind))

  const publishLiveEvent = (entry) => {
    try {
      const delivery = publishCommittedEvent(entry)
      if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {})
    } catch {
      // Live observers are non-authoritative and cannot change persistence ACKs.
    }
  }

  const journalReportedFailure = async (failure) => {
    if (findTurnEventFenceError(failure)) return
    const batch = Array.isArray(failure?.failedEntries) ? failure.failedEntries : []
    const failedAt = Number.isInteger(failure?.failedAt) ? failure.failedAt : now()
    let journalError = null
    try {
      await recordEventWriteFailure?.({
        batch,
        error: failure?.cause || failure,
        errorMessage: String(failure?.message || failure || 'event append failed').slice(0, 2_000),
        attempts: Math.max(1, Math.floor(Number(failure?.attempts) || 1)),
        failedAt,
      })
    } catch (error) {
      journalError = error
      try {
        warn?.('turn.event.failure_journal', error, { userId, sessionId, turnId })
      } catch { /* diagnostic journal remains best-effort */ }
    }
    if (!journalError) return
    try {
      await recordEmergencyFailure?.({
        batch,
        error: failure?.cause || failure,
        errorMessage: String(failure?.message || failure || 'event append failed').slice(0, 2_000),
        attempts: Math.max(1, Math.floor(Number(failure?.attempts) || 1)),
        failedAt,
        journalError,
      })
    } catch (error) {
      try {
        warn?.('turn.event.emergency_failure_journal', error, { userId, sessionId, turnId })
      } catch { /* no further durable fallback is available */ }
    }
  }

  const drainWriter = async (method = 'flush') => {
    try {
      const result = await eventWriteBehind[method]()
      const resultSignal = failureSignal(result)
      const statsSignal = failureSignal(writerStats(eventWriteBehind))
      // A writer that exposes getStats() owns the canonical counter shape.
      // Mixing its reduced snapshot with a richer flush result (for example a
      // lastError field) would make the same historical failure look new at
      // every later barrier.
      const currentFailureSignal = statsSignal || resultSignal
      const failureAdvanced = currentFailureSignal?.hasFailure === true
        && currentFailureSignal.key !== observedFailureSignal?.key
      observedFailureSignal = currentFailureSignal || observedFailureSignal
      const deferredBatch = deferredSinceBarrier
      deferredSinceBarrier = []
      if (result?.ok === false || failureAdvanced) {
        const failure = reportedBarrierFailure(result, deferredBatch, now)
        await journalReportedFailure(failure)
        throw failure
      }
      for (const entry of authoritativeDeferredEntries(result, deferredBatch)) {
        publishLiveEvent(entry)
      }
      return result
    } catch (error) {
      observedFailureSignal = failureSignal(writerStats(eventWriteBehind)) || observedFailureSignal
      const deferredBatch = deferredSinceBarrier
      deferredSinceBarrier = []
      let persistenceFailure = findEventPersistenceFailure(error)
      if (!persistenceFailure) {
        // Custom writer implementations are allowed at this seam and do not
        // necessarily throw EventWriteBehindError themselves. Normalize every
        // rejected durability barrier so callers cannot continue with a raw
        // error, skip the missing sequence, and append a contradictory later
        // terminal event.
        persistenceFailure = reportedBarrierFailure({ error }, deferredBatch, now)
        await journalReportedFailure(persistenceFailure)
      }
      if (persistenceFailure
        && persistenceFailure.firstFailedSequence === null
        && deferredBatch.length > 0
        && typeof persistenceFailure.include === 'function') {
        persistenceFailure.include(deferredBatch)
      }
      const sequenceFailure = persistenceFailure
      const firstFailedSequence = Number(sequenceFailure?.firstFailedSequence)
      if (String(sequenceFailure?.code || '').trim().toUpperCase() === TURN_EVENT_PERSISTENCE_FAILURE_CODE
        && Number.isInteger(firstFailedSequence)
        && firstFailedSequence >= 0) {
        // The queued event was never durable. Reuse its sequence for the
        // structured failed terminal so the log remains contiguous.
        nextSequence = Math.min(nextSequence, firstFailedSequence)
      }
      throw persistenceFailure
    }
  }

  const emit = (type, payload = {}, {
    beforeAppend,
    checkpointState = null,
    commitEvent = null,
  } = {}) => {
    if (closed) return Promise.reject(createClosedError())
    if (commitEvent !== null && typeof commitEvent !== 'function') {
      return Promise.reject(new TypeError('commitEvent must be a function or null'))
    }
    if (commitEvent && beforeAppend) {
      return Promise.reject(new TypeError('commitEvent and beforeAppend are mutually exclusive'))
    }
    const pending = appendQueue.then(async () => {
      const event = createTurnEvent({
        id: idFactory(),
        sessionId,
        turnId,
        sequence: nextSequence,
        type,
        payload,
        createdAt: now(),
      })
      await beforeAppend?.(event)
      let stored
      if (DEFERRED_EVENT_TYPES.has(type) && checkpointState === null && !commitEvent) {
        const entry = { userId, event, checkpointState, executionLease }
        const queued = eventWriteBehind.enqueue(entry)
        deferredSinceBarrier.push(queued?.event ? queued : entry)
        stored = queued?.event || event
      } else {
        await drainWriter('flush')
        try {
          stored = commitEvent
            ? await commitEvent({ userId, event, checkpointState })
            : await appendEvent({ userId, event, checkpointState, executionLease })
          if (isDurableTurnBoundaryEventType(type)) {
            const verification = await verifyEventCommit({ userId, event, storedEvent: stored })
            if (verification?.committed !== true || !verification?.receipt) {
              throw unverifiedCommitError(event, verification)
            }
          }
        } catch (error) {
          const fenceError = findTurnEventFenceError(error)
          if (fenceError) throw fenceError
          const failedAt = now()
          const failedEntry = { userId, event, checkpointState, executionLease }
          let journalError = null
          try {
            await recordEventWriteFailure?.({
              batch: [failedEntry],
              error,
              errorMessage: String(error?.message || error || 'event append failed').slice(0, 2_000),
              attempts: 1,
              failedAt,
            })
          } catch (writeFailureJournalError) {
            journalError = writeFailureJournalError
            try {
              warn?.('turn.event.failure_journal', writeFailureJournalError, {
                userId,
                sessionId,
                turnId,
                eventType: type,
                eventSequence: event.sequence,
              })
            } catch { /* diagnostic journal remains best-effort */ }
          }
          if (journalError) {
            try {
              await recordEmergencyFailure?.({
                batch: [failedEntry],
                error,
                errorMessage: String(error?.message || error || 'event append failed').slice(0, 2_000),
                attempts: 1,
                failedAt,
                journalError,
              })
            } catch (emergencyError) {
              try {
                warn?.('turn.event.emergency_failure_journal', emergencyError, {
                  userId,
                  sessionId,
                  turnId,
                  eventType: type,
                  eventSequence: event.sequence,
                })
              } catch { /* no further durable fallback is available */ }
            }
          }
          if (isDurableTurnBoundaryEventType(type)) {
            const failure = createTerminalPersistenceFailure(error, type)
            failure.eventId = event.id
            failure.eventSequence = event.sequence
            failure.failedAt = failedAt
            throw failure
          }
          throw new EventWriteBehindError({
            batch: [failedEntry],
            cause: error,
            attempts: 1,
            failedAt,
          })
        }
      }
      if (!(DEFERRED_EVENT_TYPES.has(type) && checkpointState === null && !commitEvent)) {
        // A transaction helper may coalesce a concurrent/idempotent request
        // onto an event that was committed by another writer. Publish the
        // authoritative persistence result, never the losing request event.
        publishLiveEvent({ userId, event: stored })
      }
      nextSequence += 1
      return stored
    })
    // One rejected append must not poison the queue used to persist a later
    // structured failure terminal.
    appendQueue = pending.catch(() => {})
    return pending
  }

  emit.close = () => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      await appendQueue
      await drainWriter(typeof eventWriteBehind.close === 'function' ? 'close' : 'flush')
      onWriterClose?.(eventWriteBehind)
    })()
    return closePromise
  }
  emit.bindExecutionLease = (proof) => {
    const ownerId = String(proof?.ownerId || '').trim()
    const fencingToken = Number(proof?.fencingToken)
    if (!ownerId || !Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      throw new TypeError('a valid execution lease proof is required')
    }
    if (executionLease
      && (executionLease.ownerId !== ownerId || executionLease.fencingToken !== fencingToken)) {
      throw new Error('turn event emitter execution lease is already bound')
    }
    executionLease = Object.freeze({ ownerId, fencingToken })
    return executionLease
  }
  emit.writer = eventWriteBehind
  return emit
}
