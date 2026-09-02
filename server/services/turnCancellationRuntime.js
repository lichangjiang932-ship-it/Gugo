import { normalizeModelUsage } from '../../shared/modelUsage.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import {
  buildAssistantModelContext,
  extractRetainedLocalFiles,
  extractVerifiedLocalFiles,
} from './turnMessageContext.js'
import {
  checkpointMessagesForTurn,
  excludeVerifiedLocalFiles,
  latestRetainedLocalFiles,
  latestVerifiedLocalFiles,
  mergeLocalFileReceipts,
  replayPersistedTurnEvents,
  storedCheckpointEvent,
} from './turnRecoveryProjection.js'
import { isTerminalTurnEventType } from './turnEventEmitter.js'
import {
  normalizeArtifactIds,
  optionalDeliveryArtifactIds,
  publicIncompleteText,
} from './turnTerminalProjection.js'
import { normalizePromptTokenEstimate } from './turnModelUsageProjection.js'
import { TurnEngineError } from './turnResolutionRuntime.js'

function requirePort(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`)
  return value
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cancellationAbortError() {
  return Object.assign(new Error('Cancelled by user'), {
    name: 'AbortError',
    code: 'TURN_CANCEL_REQUESTED',
  })
}

function replayedAssistantText(events) {
  let text = ''
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn.attempt' && event.payload?.resetStreaming === true) {
      text = String(event.payload.assistantText || '')
    } else if (event?.type === 'assistant.delta') {
      text += String(event.payload?.text || '')
    }
  }
  return text
}

function checkpointAssistantText(state, messages) {
  const finalText = String(state?.final?.text || '').trim()
  if (finalText) return finalText
  return [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === 'assistant' && String(message.content || '').trim())
    ?.content || ''
}

const SETTLED_TURN_STATUS_BY_EVENT = Object.freeze({
  'turn.completed': 'completed',
  'turn.cancelled': 'cancelled',
  'turn.failed': 'failed',
})

function settledTurnStatus(event) {
  if (!isTerminalTurnEventType(event?.type)) return null
  if (event.type === 'turn.completed' && !isSuccessfulTurnCompletedEvent(event)) return null
  return SETTLED_TURN_STATUS_BY_EVENT[event.type] || null
}

async function cancellingProjection(getTurn, scope) {
  const turn = await getTurn(scope)
  const lastEvent = turn?.lastEvent
  const settledStatus = settledTurnStatus(lastEvent)
  return settledStatus ? { ...turn, status: settledStatus } : { ...turn, status: 'cancelling' }
}

/**
 * Own the complete cancellation transition for a durable turn.
 *
 * The host exposes only narrow coordination and persistence ports. This keeps
 * lease fencing, checkpoint evidence recovery, and the terminal boundary in a
 * single testable runtime without giving it access to the TurnEngine object.
 */
export function createTurnCancellationRuntime({
  readSession,
  claimLegacySession,
  readActiveTurn,
  getTurn,
  requestCancellation,
  abortActiveTurn,
  releaseApproval,
  lastEvent,
  acquireLease,
  closeSteeringInbox,
  replayEvents,
  loadCheckpoint,
  now,
  createEmitter,
  commitTurnBoundary = null,
  writeMessage,
} = {}) {
  const ports = {
    readSession: requirePort('readSession', readSession),
    claimLegacySession: requirePort('claimLegacySession', claimLegacySession),
    readActiveTurn: requirePort('readActiveTurn', readActiveTurn),
    getTurn: requirePort('getTurn', getTurn),
    requestCancellation: requirePort('requestCancellation', requestCancellation),
    abortActiveTurn: requirePort('abortActiveTurn', abortActiveTurn),
    releaseApproval: requirePort('releaseApproval', releaseApproval),
    lastEvent: requirePort('lastEvent', lastEvent),
    acquireLease: requirePort('acquireLease', acquireLease),
    closeSteeringInbox: requirePort('closeSteeringInbox', closeSteeringInbox),
    replayEvents: requirePort('replayEvents', replayEvents),
    loadCheckpoint: requirePort('loadCheckpoint', loadCheckpoint),
    now: requirePort('now', now),
    createEmitter: requirePort('createEmitter', createEmitter),
    commitTurnBoundary: typeof commitTurnBoundary === 'function' ? commitTurnBoundary : null,
    writeMessage: requirePort('writeMessage', writeMessage),
  }

  return Object.freeze({
    async cancel({ userId, sessionId, turnId, authMode = null }) {
      const scope = { userId, sessionId, turnId }
      if (!await ports.readSession({ userId, sessionId }) && authMode === 'local') {
        await ports.claimLegacySession({ userId, sessionId, authMode })
      }

      const running = ports.readActiveTurn(scope)
      if (running) {
        try { await ports.requestCancellation(scope) } catch { /* local abort still applies */ }
        ports.abortActiveTurn(running, cancellationAbortError())
        ports.releaseApproval(scope)
        return cancellingProjection(ports.getTurn, scope)
      }

      const last = await ports.lastEvent(scope)
      if (!last) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
      if (isTerminalTurnEventType(last.type)) return await ports.getTurn(scope)

      let cancellationRequested = false
      try { cancellationRequested = await ports.requestCancellation(scope) } catch { /* fall through */ }
      if (cancellationRequested) {
        ports.releaseApproval(scope)
        return cancellingProjection(ports.getTurn, scope)
      }

      const cancellationLease = await ports.acquireLease(scope)
      if (!cancellationLease) {
        let recoveryCancellationRequested = false
        try {
          recoveryCancellationRequested = await ports.requestCancellation(scope)
        } catch { /* terminal state is checked below */ }
        if (recoveryCancellationRequested) {
          ports.releaseApproval(scope)
          return cancellingProjection(ports.getTurn, scope)
        }
        const latest = await ports.lastEvent(scope)
        if (settledTurnStatus(latest)) return await ports.getTurn(scope)
        const error = new TurnEngineError(
          'TURN_CANCELLATION_CONFLICT',
          'turn cancellation could not acquire the execution fence',
          409,
        )
        error.retryable = true
        throw error
      }

      try {
        try { await ports.requestCancellation(scope) } catch { /* lease ownership is authoritative */ }
        try { await ports.closeSteeringInbox(scope) } catch { /* terminal fence remains authoritative */ }
        ports.releaseApproval(scope)
        const fencedLast = await ports.lastEvent(scope)
        if (!fencedLast) throw new TurnEngineError('TURN_NOT_FOUND', 'turn not found', 404)
        if (settledTurnStatus(fencedLast)) return await ports.getTurn(scope)

        const replayedEvents = await replayPersistedTurnEvents(ports.replayEvents, scope)
        const checkpoint = storedCheckpointEvent(await ports.loadCheckpoint(scope))
          || replayedEvents
            .filter((event) => event.type === 'turn.checkpoint' && isRecord(event.payload?.state))
            .at(-1)
          || null
        const checkpointState = isRecord(checkpoint?.payload?.state) ? checkpoint.payload.state : null
        const started = replayedEvents.find((event) => event.type === 'turn.started') || null
        const checkpointMessages = checkpointMessagesForTurn(checkpointState, {
          content: started?.payload?.content,
        })
        const partialText = publicIncompleteText(
          replayedAssistantText(replayedEvents)
            || checkpointAssistantText(checkpointState, checkpointMessages),
          '',
        )
        const baselineToolCallIds = new Set()
        const cancelledAt = ports.now()
        const checkpointVerifiedLocalFiles = extractVerifiedLocalFiles(checkpointMessages, {
          userId,
          baselineToolCallIds,
          verifiedAt: cancelledAt,
        })
        const verifiedLocalFiles = mergeLocalFileReceipts(
          checkpointVerifiedLocalFiles,
          await latestVerifiedLocalFiles(ports.replayEvents, scope),
        )
        const checkpointRetainedLocalFiles = extractRetainedLocalFiles(checkpointMessages, {
          userId,
          baselineToolCallIds,
          retainedAt: cancelledAt,
        })
        const retainedLocalFiles = excludeVerifiedLocalFiles(mergeLocalFileReceipts(
          checkpointRetainedLocalFiles,
          await latestRetainedLocalFiles(ports.replayEvents, scope),
        ), verifiedLocalFiles)
        const artifactIds = normalizeArtifactIds(checkpointState?.artifactIds)
        const deliveryArtifactIds = optionalDeliveryArtifactIds(checkpointState, [])
        const iterations = Math.max(0, Number(checkpointState?.iterations) || 0)
        const startedAt = started?.createdAt
        const latestModelUsage = normalizeModelUsage(checkpointState?.latestModelUsage)
        const turnModelUsage = normalizeModelUsage(checkpointState?.turnModelUsage) || latestModelUsage
        const latestEstimatedPromptTokens = normalizePromptTokenEstimate(
          checkpointState?.latestEstimatedPromptTokens,
        )
        const cancellationMessage = {
          id: `${turnId}:assistant`,
          userId,
          sessionId,
          role: 'assistant',
          // Cancellation status is carried by the terminal event/context.
          // Assistant content remains reserved for model-authored output.
          content: partialText,
          modelContext: {
            ...buildAssistantModelContext({
              turnId,
              checkpointMessages,
              baselineToolCallIds,
              userId,
              verifiedLocalFiles,
              retainedLocalFiles,
              artifactIds,
              deliveryArtifactIds,
              iterations,
              compactionRecovery: checkpointState?.recovery || null,
              usage: latestModelUsage,
              turnModelUsage,
              estimatedPromptTokens: latestEstimatedPromptTokens,
              turnStartedAt: startedAt,
              turnCompletedAt: cancelledAt,
            }),
            turnEvidence: true,
            evidenceState: 'cancelled',
          },
          createdAt: cancelledAt,
          updatedAt: cancelledAt,
        }
        const atomicTurnBoundary = !!ports.commitTurnBoundary
        const emit = ports.createEmitter({
          userId,
          sessionId,
          turnId,
          sequence: fencedLast.sequence + 1,
        })
        if (cancellationLease.executionLease) {
          emit.bindExecutionLease?.(cancellationLease.executionLease)
        }
        try {
          await emit('turn.cancelled', {
            code: 'TURN_CANCELLED',
            partialText,
            artifactIds,
            deliveryArtifactIds,
            verifiedLocalFiles,
            retainedLocalFiles,
            iterations,
            ...(latestModelUsage ? { usage: latestModelUsage } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(latestEstimatedPromptTokens !== null
              ? { estimatedPromptTokens: latestEstimatedPromptTokens }
              : {}),
          }, {
            commitEvent: atomicTurnBoundary
              ? ({ event }) => ports.commitTurnBoundary({
                  userId,
                  event,
                  message: cancellationMessage,
                  executionLease: cancellationLease.executionLease,
                })
              : null,
            afterAppend: atomicTurnBoundary
              ? null
              : async () => {
                  try {
                    await ports.writeMessage(cancellationMessage)
                  } catch {
                    // The terminal event remains authoritative and snapshot recovery
                    // can reconstruct the evidence message from its payload.
                  }
                },
          })
        } finally {
          await emit.close()
        }
      } finally {
        await cancellationLease.release()
      }
      return await ports.getTurn(scope)
    },
  })
}
