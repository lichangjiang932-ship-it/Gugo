import { createTurnEvent } from '../../shared/turnEvents.js'
import { EventWriteBehindError } from './eventWriteBehind.js'
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

  let nextSequence = sequence
  let appendQueue = Promise.resolve()
  let closed = false
  let closePromise = null
  const eventWriteBehind = createEventWriteBehind()
  if (!eventWriteBehind
    || typeof eventWriteBehind.enqueue !== 'function'
    || typeof eventWriteBehind.flush !== 'function') {
    throw new TypeError('eventWriteBehindFactory must return an event write-behind queue')
  }
  onWriterOpen?.(eventWriteBehind)

  const drainWriter = async (method = 'flush') => {
    try {
      return await eventWriteBehind[method]()
    } catch (error) {
      const firstFailedSequence = Number(error?.firstFailedSequence)
      if (String(error?.code || '').trim().toUpperCase() === TURN_EVENT_PERSISTENCE_FAILURE_CODE
        && Number.isInteger(firstFailedSequence)
        && firstFailedSequence >= 0) {
        // The queued event was never durable. Reuse its sequence for the
        // structured failed terminal so the log remains contiguous.
        nextSequence = Math.min(nextSequence, firstFailedSequence)
      }
      throw error
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
        const queued = eventWriteBehind.enqueue({ userId, event, checkpointState })
        stored = queued?.event || event
      } else {
        await drainWriter('flush')
        try {
          stored = commitEvent
            ? await commitEvent({ userId, event, checkpointState })
            : await appendEvent({ userId, event, checkpointState })
          if (isDurableTurnBoundaryEventType(type)) {
            const verification = await verifyEventCommit({ userId, event, storedEvent: stored })
            if (verification?.committed !== true || !verification?.receipt) {
              throw unverifiedCommitError(event, verification)
            }
          }
        } catch (error) {
          const failedAt = now()
          const failedEntry = { userId, event, checkpointState }
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
  emit.writer = eventWriteBehind
  return emit
}
