import { createTurnEvent } from '../../shared/turnEvents.js'
import { EventWriteBehindError, findTurnEventFenceError } from './eventWriteBehind.js'
import { publishCommittedAgentEvent } from '../core/agentEventConsumerRuntime.js'
import { logWarn } from '../utils/logger.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'

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

const INCOMPLETE_BOUNDARY_DEFAULTS = Object.freeze({
  'turn.cancelled': {
    incompleteReason: 'turn_incomplete',
    missingRequirements: ['remaining_task_steps'],
    nextAction: 'retry_turn',
  },
  'turn.failed': {
    incompleteReason: 'turn_incomplete',
    missingRequirements: ['remaining_task_steps'],
    nextAction: 'retry_turn',
  },
  'turn.interrupted': {
    incompleteReason: 'model_call_interrupted',
    missingRequirements: ['model_response', 'remaining_task_steps'],
    nextAction: 'resume_turn',
  },
  'turn.blocked': {
    incompleteReason: 'recovery_blocked',
    missingRequirements: ['execution_environment_repair', 'explicit_recovery_retry'],
    nextAction: 'retry_recovery',
  },
  'turn.paused': {
    incompleteReason: 'turn_incomplete',
    missingRequirements: ['user_clarification'],
    nextAction: 'provide_input',
  },
})

function withoutLegacyPresentationFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const stable = { ...value }
  delete stable.message
  delete stable.hint
  delete stable.reason
  return stable
}

function normalizedBoundaryStringList(value, fallback) {
  const values = Array.isArray(value) && value.length > 0 ? value : fallback
  return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))].slice(0, 16)
}

function incompleteBoundaryPayload(type, value) {
  const defaults = INCOMPLETE_BOUNDARY_DEFAULTS[type]
  if (!defaults) return value
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const error = source.error && typeof source.error === 'object' && !Array.isArray(source.error)
    ? source.error
    : null
  const stableSource = withoutLegacyPresentationFields(source)
  if (error) stableSource.error = withoutLegacyPresentationFields(error)
  const rawIncompleteReason = String(
    source.incompleteReason || error?.incompleteReason || defaults.incompleteReason,
  ).trim().toLowerCase()
  const incompleteReason = /^[a-z][a-z0-9_]{1,95}$/u.test(rawIncompleteReason)
    ? rawIncompleteReason
    : defaults.incompleteReason
  const missingRequirements = normalizedBoundaryStringList(
    source.missingRequirements || error?.missingRequirements,
    defaults.missingRequirements,
  )
  const rawNextAction = String(
    source.nextAction || error?.nextAction || defaults.nextAction,
  ).trim().toLowerCase().slice(0, 80)
  const nextAction = /^[a-z][a-z0-9_]{0,79}$/u.test(rawNextAction)
    ? rawNextAction
    : defaults.nextAction
  return {
    ...stableSource,
    incompleteReason,
    missingRequirements,
    nextAction,
    verifiedLocalFiles: Array.isArray(source.verifiedLocalFiles)
      ? source.verifiedLocalFiles
      : Array.isArray(error?.verifiedLocalFiles) ? error.verifiedLocalFiles : [],
    retainedLocalFiles: Array.isArray(source.retainedLocalFiles)
      ? source.retainedLocalFiles
      : Array.isArray(error?.retainedLocalFiles) ? error.retainedLocalFiles : [],
  }
}

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

function publishLiveEvent(runtime, entry) {
  try {
    const delivery = runtime.publishCommittedEvent(entry)
    if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {})
  } catch {
    // Live observers are non-authoritative and cannot change persistence ACKs.
  }
}

async function journalReportedFailure(runtime, failure) {
  if (findTurnEventFenceError(failure)) return
  const batch = Array.isArray(failure?.failedEntries) ? failure.failedEntries : []
  const failedAt = Number.isInteger(failure?.failedAt) ? failure.failedAt : runtime.now()
  let journalError = null
  try {
    await runtime.recordEventWriteFailure?.({
      batch,
      error: failure?.cause || failure,
      errorMessage: String(failure?.message || failure || 'event append failed').slice(0, 2_000),
      attempts: Math.max(1, Math.floor(Number(failure?.attempts) || 1)),
      failedAt,
    })
  } catch (error) {
    journalError = error
    try { runtime.warn?.('turn.event.failure_journal', error, runtime.scope) }
    catch { /* diagnostic journal remains best-effort */ }
  }
  if (!journalError) return
  try {
    await runtime.recordEmergencyFailure?.({
      batch,
      error: failure?.cause || failure,
      errorMessage: String(failure?.message || failure || 'event append failed').slice(0, 2_000),
      attempts: Math.max(1, Math.floor(Number(failure?.attempts) || 1)),
      failedAt,
      journalError,
    })
  } catch (error) {
    try { runtime.warn?.('turn.event.emergency_failure_journal', error, runtime.scope) }
    catch { /* no further durable fallback is available */ }
  }
}

async function drainEventWriter(runtime, method = 'flush') {
  const { state, eventWriteBehind } = runtime
  try {
    const result = await eventWriteBehind[method]()
    const resultSignal = failureSignal(result)
    const statsSignal = failureSignal(writerStats(eventWriteBehind))
    const currentFailureSignal = statsSignal || resultSignal
    const failureAdvanced = currentFailureSignal?.hasFailure === true
      && currentFailureSignal.key !== state.observedFailureSignal?.key
    state.observedFailureSignal = currentFailureSignal || state.observedFailureSignal
    const deferredBatch = state.deferredSinceBarrier
    state.deferredSinceBarrier = []
    if (result?.ok === false || failureAdvanced) {
      const failure = reportedBarrierFailure(result, deferredBatch, runtime.now)
      await journalReportedFailure(runtime, failure)
      throw failure
    }
    for (const entry of authoritativeDeferredEntries(result, deferredBatch)) {
      publishLiveEvent(runtime, entry)
    }
    return result
  } catch (error) {
    state.observedFailureSignal = failureSignal(writerStats(eventWriteBehind))
      || state.observedFailureSignal
    const deferredBatch = state.deferredSinceBarrier
    state.deferredSinceBarrier = []
    let persistenceFailure = findEventPersistenceFailure(error)
    if (!persistenceFailure) {
      persistenceFailure = reportedBarrierFailure({ error }, deferredBatch, runtime.now)
      await journalReportedFailure(runtime, persistenceFailure)
    }
    if (persistenceFailure
      && persistenceFailure.firstFailedSequence === null
      && deferredBatch.length > 0
      && typeof persistenceFailure.include === 'function') {
      persistenceFailure.include(deferredBatch)
    }
    const firstFailedSequence = Number(persistenceFailure?.firstFailedSequence)
    if (String(persistenceFailure?.code || '').trim().toUpperCase() === TURN_EVENT_PERSISTENCE_FAILURE_CODE
      && Number.isInteger(firstFailedSequence)
      && firstFailedSequence >= 0) {
      state.nextSequence = Math.min(state.nextSequence, firstFailedSequence)
    }
    throw persistenceFailure
  }
}

async function appendTurnEvent(runtime, type, payload, options) {
  const { state } = runtime
  const { beforeAppend, afterAppend, checkpointState = null, commitEvent = null } = options
  const event = createTurnEvent({
    id: runtime.idFactory(),
    sessionId: runtime.scope.sessionId,
    turnId: runtime.scope.turnId,
    sequence: state.nextSequence,
    type,
    payload: incompleteBoundaryPayload(type, payload),
    createdAt: runtime.now(),
  })
  await beforeAppend?.(event)
  let stored
  if (DEFERRED_EVENT_TYPES.has(type) && checkpointState === null && !commitEvent) {
    const entry = { userId: runtime.scope.userId, event, checkpointState, executionLease: state.executionLease }
    const queued = runtime.eventWriteBehind.enqueue(entry)
    state.deferredSinceBarrier.push(queued?.event ? queued : entry)
    stored = queued?.event || event
  } else {
    await drainEventWriter(runtime, 'flush')
    try {
      stored = commitEvent
        ? await commitEvent({ userId: runtime.scope.userId, event, checkpointState })
        : await runtime.appendEvent({
            userId: runtime.scope.userId,
            event,
            checkpointState,
            executionLease: state.executionLease,
          })
      if (isDurableTurnBoundaryEventType(type)) {
        const verification = await runtime.verifyEventCommit({
          userId: runtime.scope.userId,
          event,
          storedEvent: stored,
        })
        if (verification?.committed !== true || !verification?.receipt) {
          throw unverifiedCommitError(event, verification)
        }
      }
    } catch (error) {
      const fenceError = findTurnEventFenceError(error)
      if (fenceError) throw fenceError
      const failedAt = runtime.now()
      const failedEntry = {
        userId: runtime.scope.userId,
        event,
        checkpointState,
        executionLease: state.executionLease,
      }
      let journalError = null
      try {
        await runtime.recordEventWriteFailure?.({
          batch: [failedEntry], error,
          errorMessage: String(error?.message || error || 'event append failed').slice(0, 2_000),
          attempts: 1, failedAt,
        })
      } catch (writeFailureJournalError) {
        journalError = writeFailureJournalError
        try {
          runtime.warn?.('turn.event.failure_journal', writeFailureJournalError, {
            ...runtime.scope, eventType: type, eventSequence: event.sequence,
          })
        } catch { /* diagnostic journal remains best-effort */ }
      }
      if (journalError) {
        try {
          await runtime.recordEmergencyFailure?.({
            batch: [failedEntry], error,
            errorMessage: String(error?.message || error || 'event append failed').slice(0, 2_000),
            attempts: 1, failedAt, journalError,
          })
        } catch (emergencyError) {
          try {
            runtime.warn?.('turn.event.emergency_failure_journal', emergencyError, {
              ...runtime.scope, eventType: type, eventSequence: event.sequence,
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
      throw new EventWriteBehindError({ batch: [failedEntry], cause: error, attempts: 1, failedAt })
    }
  }
  if (!(DEFERRED_EVENT_TYPES.has(type) && checkpointState === null && !commitEvent)) {
    await afterAppend?.(stored, event)
    publishLiveEvent(runtime, { userId: runtime.scope.userId, event: stored })
  }
  state.nextSequence += 1
  return stored
}

function emitTurnEvent(runtime, type, payload = {}, options = {}) {
  const { state } = runtime
  if (state.closed) return Promise.reject(runtime.createClosedError())
  if (type === 'turn.completed' && !isSuccessfulTurnCompletedEvent({ type, payload })) {
    return Promise.reject(Object.assign(
      new Error('turn.completed payload contains incomplete terminal evidence'),
      { code: 'TURN_COMPLETION_INVALID', status: 409, retryable: false },
    ))
  }
  if (options.commitEvent !== null && options.commitEvent !== undefined
    && typeof options.commitEvent !== 'function') {
    return Promise.reject(new TypeError('commitEvent must be a function or null'))
  }
  if (options.commitEvent && options.beforeAppend) {
    return Promise.reject(new TypeError('commitEvent and beforeAppend are mutually exclusive'))
  }
  if (options.afterAppend !== undefined && options.afterAppend !== null
    && typeof options.afterAppend !== 'function') {
    return Promise.reject(new TypeError('afterAppend must be a function when provided'))
  }
  const pending = state.appendQueue.then(() => appendTurnEvent(runtime, type, payload, options))
  state.appendQueue = pending.catch(() => {})
  return pending
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

  const state = {
    nextSequence: sequence,
    appendQueue: Promise.resolve(),
    closed: false,
    closePromise: null,
    deferredSinceBarrier: [],
    executionLease: null,
    observedFailureSignal: null,
  }
  const eventWriteBehind = createEventWriteBehind()
  if (!eventWriteBehind
    || typeof eventWriteBehind.enqueue !== 'function'
    || typeof eventWriteBehind.flush !== 'function') {
    throw new TypeError('eventWriteBehindFactory must return an event write-behind queue')
  }
  onWriterOpen?.(eventWriteBehind)
  state.observedFailureSignal = failureSignal(writerStats(eventWriteBehind))
  const runtime = {
    scope: { userId, sessionId, turnId },
    state,
    idFactory,
    now,
    appendEvent,
    verifyEventCommit,
    eventWriteBehind,
    recordEventWriteFailure,
    recordEmergencyFailure,
    createClosedError,
    publishCommittedEvent,
    warn,
  }
  const emit = (type, payload = {}, options = {}) => emitTurnEvent(
    runtime,
    type,
    payload,
    options,
  )
  emit.close = () => {
    if (state.closePromise) return state.closePromise
    state.closed = true
    state.closePromise = (async () => {
      await state.appendQueue
      await drainEventWriter(
        runtime,
        typeof eventWriteBehind.close === 'function' ? 'close' : 'flush',
      )
      onWriterClose?.(eventWriteBehind)
    })()
    return state.closePromise
  }
  emit.bindExecutionLease = (proof) => {
    const ownerId = String(proof?.ownerId || '').trim()
    const fencingToken = Number(proof?.fencingToken)
    if (!ownerId || !Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      throw new TypeError('a valid execution lease proof is required')
    }
    if (state.executionLease
      && (state.executionLease.ownerId !== ownerId
        || state.executionLease.fencingToken !== fencingToken)) {
      throw new Error('turn event emitter execution lease is already bound')
    }
    state.executionLease = Object.freeze({ ownerId, fencingToken })
    return state.executionLease
  }
  emit.writer = eventWriteBehind
  return emit
}
