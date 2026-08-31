import {
  extractRetainedLocalFiles,
  extractVerifiedLocalFiles,
} from './turnMessageContext.js'
import {
  createTerminalPersistenceFailure,
  findEventPersistenceFailure,
  TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
} from './turnEventEmitter.js'
import { recoveryCandidateVersion } from './turnEnginePolicy.js'
import { createTurnEvidenceMessage } from './turnEvidenceMessageProjection.js'
import { normalizeTurnOptionalId as normalizeOptionalId } from './turnStartRuntime.js'
import {
  deliveryArtifactFields,
  missingRequirementsForIncompleteReason,
  normalizeArtifactIds,
  normalizeTurnFailure,
  optionalDeliveryArtifactIds,
  publicIncompleteText,
} from './turnTerminalProjection.js'
import { logWarn } from '../utils/logger.js'

function requirePort(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`)
  return value
}

function usageFields(state) {
  return {
    ...(state.latestModelUsage ? { usage: state.latestModelUsage } : {}),
    ...(state.turnModelUsage ? { turnModelUsage: state.turnModelUsage } : {}),
    ...(state.latestEstimatedPromptTokens !== null
      ? { estimatedPromptTokens: state.latestEstimatedPromptTokens }
      : {}),
  }
}

/**
 * Own terminal evidence projection and its durability boundary for one Turn.
 *
 * Mutable loop state is read through an explicit snapshot port. The runtime
 * never receives the TurnEngine instance and cannot reach unrelated engine
 * lifecycle state.
 */
export function createTurnTerminalEvidenceRuntime({
  scope,
  emitter,
  executionLease = null,
  now,
  writeMessage,
  writeRecoveryFailure,
  commitTurnBoundary = null,
  recordCanaryTerminal,
  readState,
} = {}) {
  const { userId, sessionId, turnId } = scope || {}
  if (!userId || !sessionId || !turnId) {
    throw new TypeError('turnTerminalEvidenceRuntime requires a complete scope')
  }
  const ports = {
    emitter: requirePort('emitter', emitter),
    now: requirePort('now', now),
    writeMessage: requirePort('writeMessage', writeMessage),
    writeRecoveryFailure: requirePort('writeRecoveryFailure', writeRecoveryFailure),
    commitTurnBoundary: typeof commitTurnBoundary === 'function' ? commitTurnBoundary : null,
    recordCanaryTerminal: requirePort('recordCanaryTerminal', recordCanaryTerminal),
    readState: requirePort('readState', readState),
  }
  const atomicTurnBoundary = !!ports.commitTurnBoundary

  function stateSnapshot() {
    const state = ports.readState()
    return state && typeof state === 'object' ? state : {}
  }

  function verifiedLocalFilesAt(verifiedAt = ports.now()) {
    const state = stateSnapshot()
    return extractVerifiedLocalFiles(state.checkpointMessages, {
      userId,
      baselineToolCallIds: state.baselineToolCallIds,
      verifiedAt,
    })
  }

  function retainedLocalFilesAt(retainedAt = ports.now(), verifiedLocalFiles = []) {
    const state = stateSnapshot()
    const verifiedIds = new Set((Array.isArray(verifiedLocalFiles) ? verifiedLocalFiles : [])
      .map((file) => String(file?.id || '').trim())
      .filter(Boolean))
    return extractRetainedLocalFiles(state.checkpointMessages, {
      userId,
      baselineToolCallIds: state.baselineToolCallIds,
      retainedAt,
    }).filter((file) => !verifiedIds.has(String(file?.id || '').trim()))
  }

  function projectEvidence(options = {}) {
    const state = stateSnapshot()
    const writtenAt = options.writtenAt ?? ports.now()
    const verifiedLocalFiles = Array.isArray(options.verifiedLocalFiles)
      ? options.verifiedLocalFiles
      : verifiedLocalFilesAt(writtenAt)
    const retainedLocalFiles = Array.isArray(options.retainedLocalFiles)
      ? options.retainedLocalFiles
      : retainedLocalFilesAt(writtenAt, verifiedLocalFiles)
    return createTurnEvidenceMessage({
      ...options,
      writtenAt,
      verifiedLocalFiles,
      retainedLocalFiles,
    }, {
      userId,
      sessionId,
      turnId,
      checkpointMessages: state.checkpointMessages,
      baselineToolCallIds: state.baselineToolCallIds,
      pluginPromptBlockIds: state.promptContextSnapshot?.pluginPromptBlockIds,
      checkpointRecovery: state.checkpointRecovery,
      latestModelUsage: state.latestModelUsage,
      turnModelUsage: state.turnModelUsage,
      latestEstimatedPromptTokens: state.latestEstimatedPromptTokens,
      effectiveTurnStartedAt: state.effectiveTurnStartedAt,
    })
  }

  async function persistEvidence(options) {
    const message = projectEvidence(options)
    await ports.writeMessage(message)
    return message.content
  }

  function commitBoundaryEvent({ event, message }) {
    return ports.commitTurnBoundary({
      userId,
      event,
      message,
      executionLease,
    })
  }

  function boundaryOptions(options, { legacyBeforeAppend = false } = {}) {
    if (atomicTurnBoundary) {
      return {
        commitEvent: ({ event }) => commitBoundaryEvent({
          event,
          message: projectEvidence({
            ...options,
            serverLastSequence: event.sequence,
          }),
        }),
      }
    }
    if (legacyBeforeAppend) {
      return {
        beforeAppend: (event) => persistEvidence({
          ...options,
          serverLastSequence: event.sequence,
        }),
      }
    }
    return {}
  }

  async function emitFailed(sourceError) {
    const state = stateSnapshot()
    const originalError = sourceError
    const artifactIds = normalizeArtifactIds(
      originalError?.artifactIds ?? state.checkpointArtifactIds,
    )
    const deliveryArtifactIds = optionalDeliveryArtifactIds(originalError, [])
    const iterations = Math.max(0, Number(originalError?.iterations) || state.checkpointIterations)
    const failedAt = ports.now()
    const verifiedLocalFiles = verifiedLocalFilesAt(failedAt)
    const retainedLocalFiles = retainedLocalFilesAt(failedAt, verifiedLocalFiles)
    let activeError = findEventPersistenceFailure(sourceError) || sourceError

    // A deferred delta failure is discovered before the first terminal append,
    // so exactly one retry is safe. A direct terminal append has unknown outcome
    // and must never be retried blindly.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = normalizeTurnFailure(activeError)
      const partialText = publicIncompleteText(
        originalError?.partialText || state.streamedAssistantText,
        '',
      )
      const evidenceOptions = {
        state: 'failed',
        text: partialText,
        artifactIds,
        deliveryArtifactIds,
        iterations,
        error: failure,
        verifiedLocalFiles,
        retainedLocalFiles,
        writtenAt: failedAt,
      }
      try {
        await ports.emitter('turn.failed', {
          code: failure.code,
          error: failure,
          ...(failure.incompleteReason ? { incompleteReason: failure.incompleteReason } : {}),
          ...(Array.isArray(failure.missingRequirements)
            ? { missingRequirements: failure.missingRequirements }
            : {}),
          ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
          partialText,
          artifactIds,
          ...deliveryArtifactFields(deliveryArtifactIds),
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations,
          ...usageFields(state),
        }, boundaryOptions(evidenceOptions))
        if (!atomicTurnBoundary) {
          try {
            await persistEvidence(evidenceOptions)
          } catch (error) {
            logWarn('turn.legacy_evidence_projection', error, {
              userId, sessionId, turnId, state: 'failed',
            })
          }
        }
        await ports.recordCanaryTerminal('failed', failure.code, failedAt, partialText)
        return
      } catch (terminalError) {
        const deferredFailure = findEventPersistenceFailure(terminalError)
        const terminalOutcomeUnknown = String(terminalError?.code || '').trim().toUpperCase()
          === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE
        if (deferredFailure && !terminalOutcomeUnknown && attempt === 0) {
          activeError = deferredFailure
          continue
        }
        throw createTerminalPersistenceFailure(terminalError)
      }
    }
  }

  async function emitBlocked(sourceError) {
    const state = stateSnapshot()
    const baseFailure = normalizeTurnFailure(sourceError, { retryable: false })
    const sideEffectUnknown = baseFailure.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'
      && sourceError?.unsafeToReplay === true
      && sourceError?.requiresUserVerification === true
    const modelRequestUnknown = baseFailure.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && sourceError?.unsafeToReplay === true
    const incompleteReason = baseFailure.incompleteReason || (sideEffectUnknown
      ? 'side_effect_outcome_unknown'
      : modelRequestUnknown ? 'model_request_outcome_unknown' : 'recovery_blocked')
    const missingRequirements = Array.isArray(baseFailure.missingRequirements)
      && baseFailure.missingRequirements.length > 0
      ? baseFailure.missingRequirements
      : missingRequirementsForIncompleteReason(incompleteReason)
    const failure = normalizeTurnFailure({
      ...sourceError,
      code: baseFailure.code,
      incompleteReason,
      missingRequirements,
      manualRetryable: true,
      retryable: false,
    }, { retryable: false })
    const recoveryToolCallId = sideEffectUnknown
      ? normalizeOptionalId(sourceError?.sideEffectExecution?.toolCallId)
      : null
    const recoveryModelRequestId = modelRequestUnknown
      ? normalizeOptionalId(sourceError?.modelRequestId || sourceError?.modelInvocation?.id)
      : null
    const blockedAt = ports.now()
    const verifiedLocalFiles = verifiedLocalFilesAt(blockedAt)
    const retainedLocalFiles = retainedLocalFilesAt(blockedAt, verifiedLocalFiles)
    const partialText = publicIncompleteText(
      sourceError?.partialText || state.streamedAssistantText,
      '',
    )
    const blockedRecovery = sideEffectUnknown
      ? {
          recoveryKind: 'side_effect_outcome_unknown',
          requiresUserVerification: true,
          ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
        }
      : modelRequestUnknown
        ? {
            recoveryKind: 'model_request_outcome_unknown',
            requiresUserVerification: true,
            ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
          }
        : null
    const artifactIds = normalizeArtifactIds(state.checkpointArtifactIds)
    const deliveryArtifactIds = optionalDeliveryArtifactIds(
      { deliveryArtifactIds: state.checkpointDeliveryArtifactIds },
      [],
    )
    const evidenceOptions = {
      state: 'blocked',
      text: partialText,
      artifactIds: state.checkpointArtifactIds,
      deliveryArtifactIds,
      iterations: state.checkpointIterations,
      error: { ...failure, retryable: false },
      verifiedLocalFiles,
      retainedLocalFiles,
      blockedRecovery,
      writtenAt: blockedAt,
    }
    const blockedEvent = await ports.emitter('turn.blocked', {
      code: failure.code,
      error: failure,
      incompleteReason: failure.incompleteReason,
      missingRequirements: failure.missingRequirements,
      ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
      partialText,
      retryable: false,
      manualRetryable: true,
      recoveryStatus: 'dead_letter',
      ...(sideEffectUnknown ? {
        turnId,
        requiresUserVerification: true,
        recoveryKind: 'side_effect_outcome_unknown',
        ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
        recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
      } : {}),
      ...(modelRequestUnknown ? {
        turnId,
        requiresUserVerification: true,
        recoveryKind: 'model_request_outcome_unknown',
        ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
        recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
      } : {}),
      checkpointSequence: state.latestCheckpointSequence,
      artifactIds,
      deliveryArtifactIds,
      verifiedLocalFiles,
      retainedLocalFiles,
      iterations: state.checkpointIterations,
    }, boundaryOptions(evidenceOptions))
    if (!atomicTurnBoundary) {
      try {
        await persistEvidence({
          ...evidenceOptions,
          serverLastSequence: blockedEvent.sequence,
        })
      } catch (error) {
        logWarn('turn.legacy_evidence_projection', error, {
          userId, sessionId, turnId, state: 'blocked',
        })
      }
    }
    await ports.writeRecoveryFailure({
      userId,
      sessionId,
      turnId,
      candidateVersion: recoveryCandidateVersion(blockedEvent),
      retryable: false,
      errorCode: failure.code,
      errorMessage: String(sourceError?.message || failure.code),
      now: blockedEvent.createdAt,
    })
  }

  return Object.freeze({
    emitter: ports.emitter,
    atomicTurnBoundary,
    verifiedLocalFilesAt,
    retainedLocalFilesAt,
    projectEvidence,
    persistEvidence,
    commitBoundaryEvent,
    boundaryOptions,
    emitFailed,
    emitBlocked,
  })
}
