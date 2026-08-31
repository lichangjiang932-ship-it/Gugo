import { TurnEngineError } from './turnResolutionRuntime.js'
import {
  failedRetryRejectionEvidenceMessage,
  failedRetryRejectionFromMessage,
  isPermanentFailedRetryRejectionCode,
  permanentFailedRetryError,
} from './turnFailedRetryRejection.js'
import {
  failedRetryAttemptPayload,
  replayPersistedTurnEvents,
} from './turnRecoveryProjection.js'

const MAX_FAILED_TURN_RETRIES = 1

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function permanentFailedRetryRejection(error) {
  const visited = new Set()
  let current = error
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (visited.has(current)) return null
    visited.add(current)
    if (isPermanentFailedRetryRejectionCode(current.code)) return current
    current = current.cause
  }
  return null
}

function retryingTurnEvidenceMessage({
  existing,
  userId,
  sessionId,
  turnId,
  event,
}) {
  const modelContext = isRecord(existing?.modelContext) ? { ...existing.modelContext } : {}
  for (const key of ['error', 'recovery', 'turnCompletedAt', 'latency', 'paused', 'clarification']) {
    delete modelContext[key]
  }
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: String(event.payload?.assistantText || ''),
    modelContext: {
      ...modelContext,
      turnId,
      turnEvidence: true,
      evidenceState: 'retrying',
      serverLastSequence: event.sequence,
    },
    createdAt: Number.isFinite(Number(existing?.createdAt)) ? Number(existing.createdAt) : event.createdAt,
    updatedAt: event.createdAt,
  }
}

/**
 * Failed-turn retry orchestration, extracted from the TurnEngine
 * compatibility shell (KERNEL_BOUNDARY transition debt).
 *
 * The host supplies its persistence ports and private callbacks explicitly;
 * this module owns every retry decision so the engine shrinks toward an
 * adapter/context execution shell without duplicating the terminal-fence
 * semantics.
 */
export function createTurnFailedRetryRuntime({
  deps,
  claimLegacySession,
  recoverTurn,
  createEmitter,
}) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('Turn failed-retry runtime requires the engine deps object')
  }
  if (typeof recoverTurn !== 'function' || typeof createEmitter !== 'function') {
    throw new TypeError('Turn failed-retry runtime requires recoverTurn and createEmitter callbacks')
  }

  async function findExistingAssistantMessage(scope) {
    return ((await deps.readMessages({
      userId: scope.userId,
      sessionId: scope.sessionId,
      limit: 500,
      recent: true,
    })).find((message) => message?.id === `${scope.turnId}:assistant`)) || null
  }

  async function retryFailedTurn({
    userId,
    sessionId,
    turnId,
    retryRecovery = false,
    resolution = null,
    authMode = null,
  } = {}) {
    if (retryRecovery === true || resolution !== null) {
      throw new TurnEngineError(
        'TURN_FAILED_RETRY_REQUEST_INVALID',
        'retryFailed cannot be combined with recovery or resolution controls',
        400,
      )
    }
    if (!await deps.readSession({ userId, sessionId }) && authMode === 'local'
      && typeof claimLegacySession === 'function') {
      await claimLegacySession({ userId, sessionId, authMode })
    }
    const scope = { userId, sessionId, turnId }
    const started = await deps.lastEvent({ ...scope, type: 'turn.started' })
    if (!started) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
    const last = await deps.lastEvent(scope)
    const persistedEvents = await replayPersistedTurnEvents(deps.replayEvents, scope)
    if (last?.type === 'turn.attempt' && last.payload?.reason === 'failed_retry') {
      const outcome = await recoverTurn({ ...scope, authMode })
      return outcome.turn
    }
    if (last?.type !== 'turn.failed') {
      const latestFailedRetry = persistedEvents
        .filter((event) => event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry')
        .at(-1)
      const laterFailure = latestFailedRetry && persistedEvents.some((event) => (
        event.type === 'turn.failed' && event.sequence > latestFailedRetry.sequence
      ))
      const retryRequiresExplicitControl = ['turn.blocked', 'turn.interrupted', 'turn.paused']
        .includes(last?.type)
      if (latestFailedRetry && !laterFailure && !retryRequiresExplicitControl) {
        const outcome = await recoverTurn({ ...scope, authMode })
        return outcome.turn
      }
      throw new TurnEngineError(
        'TURN_FAILED_RETRY_CONFLICT',
        'the Turn is no longer at a failed terminal boundary',
        409,
      )
    }
    const existingMessage = await findExistingAssistantMessage(scope)
    const persistedRejection = failedRetryRejectionFromMessage(existingMessage, last)
    if (persistedRejection) throw permanentFailedRetryError(persistedRejection)

    const rejectFailedRetry = async (sourceError) => {
      const rejectionError = permanentFailedRetryError(sourceError)
      const message = failedRetryRejectionEvidenceMessage({
        existing: existingMessage,
        userId,
        sessionId,
        turnId,
        failureEvent: last,
        error: rejectionError,
        writtenAt: deps.now(),
      })
      if (typeof deps.commitTurnFailedRetryRejection === 'function') {
        try {
          await deps.commitTurnFailedRetryRejection({
            userId,
            failureEvent: last,
            message,
          })
        } catch (error) {
          if (error?.code !== 'TURN_FAILED_RETRY_REJECTION_CONFLICT') throw error
          const currentMessage = await findExistingAssistantMessage(scope)
          const concurrentRejection = failedRetryRejectionFromMessage(currentMessage, last)
          if (concurrentRejection) throw permanentFailedRetryError(concurrentRejection)
          return (await recoverTurn({ ...scope, authMode })).turn
        }
      } else {
        // Legacy/custom adapters may not expose the atomic rejection helper.
        // Recheck the terminal fence before writing the durable projection so
        // an already-started concurrent retry is never overwritten.
        const latest = await deps.lastEvent(scope)
        if (latest?.id !== last.id
          || latest?.sequence !== last.sequence
          || latest?.type !== 'turn.failed') {
          return (await recoverTurn({ ...scope, authMode })).turn
        }
        await deps.writeMessage(message)
      }
      throw rejectionError
    }
    const failedRetryCount = persistedEvents.filter((event) => (
      event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry'
    )).length
    if (failedRetryCount >= MAX_FAILED_TURN_RETRIES) {
      throw permanentFailedRetryError({
        code: 'TURN_FAILED_RETRY_LIMIT_REACHED',
        status: 409,
      })
    }
    if (last.payload?.error?.retryable !== true
      && last.payload?.error?.manualRetryable !== true) {
      throw new TurnEngineError(
        'TURN_FAILED_RETRY_NOT_ALLOWED',
        'the failed Turn is not explicitly retryable or manually recoverable',
        409,
      )
    }
    if (typeof deps.commitTurnFailedRetry !== 'function') {
      return rejectFailedRetry(new TurnEngineError(
        'TURN_FAILED_RETRY_UNSUPPORTED',
        'the configured Turn persistence adapter does not support atomic failed retries',
        501,
      ))
    }
    const checkpoint = await deps.runtimeCore.checkpoint.load(scope)
    if (!checkpoint?.state || !Number.isInteger(checkpoint.eventSequence)) {
      return rejectFailedRetry(new TurnEngineError(
        'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
        'a durable Turn checkpoint is required before retrying a failed Turn',
        409,
      ))
    }
    const attemptPayload = failedRetryAttemptPayload(persistedEvents, last, checkpoint)
    if (!attemptPayload) {
      return rejectFailedRetry(new TurnEngineError(
        'TURN_FAILED_RETRY_EVENT_INVALID',
        'failed Turn retry metadata could not be reconstructed',
        409,
      ))
    }
    const emitter = createEmitter({
      userId,
      sessionId,
      turnId,
      sequence: last.sequence + 1,
    })
    let commitError = null
    try {
      await emitter('turn.attempt', attemptPayload, {
        commitEvent: ({ event }) => deps.commitTurnFailedRetry({
          userId,
          event,
          message: retryingTurnEvidenceMessage({
            existing: existingMessage,
            userId,
            sessionId,
            turnId,
            event,
          }),
        }),
      })
    } catch (error) {
      commitError = error
    } finally {
      await emitter.close()
    }
    if (commitError) {
      const permanentRejection = permanentFailedRetryRejection(commitError)
      if (permanentRejection) {
        return rejectFailedRetry(permanentRejection)
      }
      throw commitError
    }
    await deps.clearRecoveryState(scope)
    const outcome = await recoverTurn({ ...scope, authMode })
    return outcome.turn
  }

  return { retryFailedTurn }
}
