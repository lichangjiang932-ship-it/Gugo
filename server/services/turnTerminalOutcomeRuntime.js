import {
  findEventPersistenceFailure,
  TURN_TERMINAL_PERSISTENCE_FAILURE_CODE,
} from './turnEventEmitter.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import {
  isExplicitTurnCancellation,
  isManualRecoveryBlock,
  isRecord,
  lostTurnLease,
} from './turnEnginePolicy.js'
import {
  createCompletedTurnMessage,
  createInitialCancellationMessage,
  createPausedTurnMessage,
} from './turnEvidenceMessageProjection.js'
import {
  deliveryArtifactFields,
  finalClarificationText,
  missingRequirementsForIncompleteReason,
  normalizeArtifactIds,
  normalizeIncompleteReason,
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
 * Project model-loop results and errors into one durable terminal outcome.
 * Persistence mechanics remain delegated to turnTerminalEvidenceRuntime.
 */
export function createTurnTerminalOutcomeRuntime({
  now,
  writeMessage,
  commitTurnBoundary = null,
  dispatchHooks = null,
  scheduleMemoryExtraction,
  runMemoryModel,
} = {}) {
  const ports = {
    now: requirePort('now', now),
    writeMessage: requirePort('writeMessage', writeMessage),
    commitTurnBoundary: typeof commitTurnBoundary === 'function' ? commitTurnBoundary : null,
    dispatchHooks: typeof dispatchHooks === 'function' ? dispatchHooks : null,
    scheduleMemoryExtraction: requirePort('scheduleMemoryExtraction', scheduleMemoryExtraction),
    runMemoryModel: requirePort('runMemoryModel', runMemoryModel),
  }

  async function cancelBeforeExecution({
    scope,
    signal,
    emitter,
    executionLease = null,
    turnStartedAt,
  }) {
    if (!signal?.aborted) return false
    if (lostTurnLease(signal)) return true
    const { userId, sessionId, turnId } = scope
    const cancelledAt = ports.now()
    const cancellationMessage = createInitialCancellationMessage({
      userId,
      sessionId,
      turnId,
      turnStartedAt,
      cancelledAt,
    })
    const atomicTurnBoundary = !!ports.commitTurnBoundary
    await emitter('turn.cancelled', {
      reason: signal.reason?.message || 'Cancelled by user',
      partialText: '',
      artifactIds: [],
      deliveryArtifactIds: [],
      verifiedLocalFiles: [],
      retainedLocalFiles: [],
      iterations: 0,
    }, {
      commitEvent: atomicTurnBoundary
        ? ({ event }) => ports.commitTurnBoundary({
            userId,
            event,
            message: cancellationMessage,
            executionLease,
          })
        : null,
      beforeAppend: atomicTurnBoundary
        ? null
        : async () => {
            try {
              await ports.writeMessage(cancellationMessage)
            } catch (error) {
              logWarn('turn.legacy_evidence_projection', error, {
                userId, sessionId, turnId, state: 'cancelled',
              })
            }
          },
    })
    return true
  }

  async function settleResult({
    scope,
    signal,
    result,
    state,
    evidence,
    recordCanaryTerminal,
  }) {
    const { userId, sessionId, turnId } = scope
    if (signal.aborted) {
      if (lostTurnLease(signal)) return
      const cancelledAt = ports.now()
      const verifiedLocalFiles = evidence.verifiedLocalFilesAt(cancelledAt)
      const retainedLocalFiles = evidence.retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
      const artifactIds = normalizeArtifactIds(state.checkpointArtifactIds)
      const partialText = publicIncompleteText(state.streamedAssistantText, '')
      const deliveryArtifactIds = normalizeArtifactIds(state.checkpointDeliveryArtifactIds)
      const evidenceOptions = {
        state: 'cancelled',
        text: partialText,
        artifactIds,
        deliveryArtifactIds,
        iterations: state.checkpointIterations,
        verifiedLocalFiles,
        retainedLocalFiles,
        writtenAt: cancelledAt,
      }
      await evidence.emitter('turn.cancelled', {
        reason: 'Cancelled by user',
        partialText,
        artifactIds,
        deliveryArtifactIds,
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations: state.checkpointIterations,
        ...usageFields(state),
      }, evidence.boundaryOptions(evidenceOptions, {
        legacyBeforeAppend: true,
        legacyBestEffort: true,
      }))
      await recordCanaryTerminal('cancelled', null, cancelledAt, partialText)
      return
    }

    if (!result?.incomplete && !result?.interrupted && !result?.paused
      && !isSuccessfulTurnCompletedEvent({ type: 'turn.completed', payload: result })) {
      result = {
        ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
        incomplete: true,
        partialText: result?.partialText || result?.text || '',
        reason: result?.incompleteReason || result?.reason || 'turn_incomplete',
      }
    }

    if (result?.interrupted) {
      const artifactIds = normalizeArtifactIds(result.artifactIds ?? state.checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(
        result,
        normalizeArtifactIds(state.checkpointDeliveryArtifactIds),
      )
      const iterations = Math.max(0, Number(result.iterations) || state.checkpointIterations)
      const partialText = publicIncompleteText(
        result.partialText || state.streamedAssistantText,
        '',
      )
      const interruptedAt = ports.now()
      const verifiedLocalFiles = evidence.verifiedLocalFilesAt(interruptedAt)
      const retainedLocalFiles = evidence.retainedLocalFilesAt(interruptedAt, verifiedLocalFiles)
      const incompleteReason = normalizeIncompleteReason(
        result.incompleteReason || result.reasonCode || result.reason,
        'model_call_interrupted',
      )
      const explicitMissingRequirements = Array.isArray(result.missingRequirements)
        ? result.missingRequirements
        : []
      const missingRequirements = explicitMissingRequirements.length > 0
        ? explicitMissingRequirements
        : missingRequirementsForIncompleteReason(incompleteReason)
      const failure = normalizeTurnFailure({
        code: result.code,
        incompleteReason,
        missingRequirements,
        retryable: true,
        taskVerification: result.taskVerification,
      }, { code: 'MODEL_CALL_INTERRUPTED', retryable: true })
      const evidenceOptions = {
        state: 'interrupted',
        text: partialText,
        artifactIds,
        deliveryArtifactIds,
        iterations,
        error: failure,
        verifiedLocalFiles,
        retainedLocalFiles,
        writtenAt: interruptedAt,
      }
      await evidence.emitter('turn.interrupted', {
        code: failure.code,
        error: failure,
        incompleteReason: failure.incompleteReason,
        missingRequirements: failure.missingRequirements,
        ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
        retryable: true,
        text: partialText,
        partialText,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations,
        ...usageFields(state),
      }, evidence.boundaryOptions(evidenceOptions, { legacyBeforeAppend: true }))
      return
    }

    if (result?.incomplete) {
      // `result.text` may be host-authored blocker copy. Keep assistant content
      // model-authored and carry task diagnostics through the structured
      // failure contract below so clients can localize the explanation.
      const partialText = publicIncompleteText(
        result.partialText || state.streamedAssistantText,
        '',
      )
      const resultCode = String(result.code || '').trim()
      const incompleteReason = normalizeIncompleteReason(
        result.budgetExceeded === true
          ? 'execution_budget_exhausted'
          : result.noProgress === true
            ? 'tool_no_progress'
            : resultCode === 'REASONING_RUNAWAY' ? 'reasoning_runaway' : result.reason,
      )
      const explicitMissingRequirements = Array.isArray(result.missingRequirements)
        ? result.missingRequirements
        : []
      const missingRequirements = explicitMissingRequirements.length > 0
        ? explicitMissingRequirements
        : missingRequirementsForIncompleteReason(incompleteReason)
      const resultRetryable = typeof result.retryable === 'boolean'
        ? result.retryable
        : resultCode !== 'REASONING_RUNAWAY'
      const retryable = state.failedRetryActive ? false : resultRetryable
      const failure = normalizeTurnFailure({
        code: resultCode || 'TURN_INCOMPLETE',
        incompleteReason,
        missingRequirements,
        retryable,
        manualRetryable: state.failedRetryActive ? false : result.manualRetryable,
        taskVerification: result.taskVerification,
      }, { retryable })
      const artifactIds = normalizeArtifactIds(result.artifactIds ?? state.checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(
        result,
        normalizeArtifactIds(state.checkpointDeliveryArtifactIds),
      )
      const iterations = Math.max(0, Number(result.iterations) || state.checkpointIterations)
      const failedAt = ports.now()
      const verifiedLocalFiles = evidence.verifiedLocalFilesAt(failedAt)
      const retainedLocalFiles = evidence.retainedLocalFilesAt(failedAt, verifiedLocalFiles)
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
      await evidence.emitter('turn.failed', {
        code: failure.code,
        error: failure,
        incompleteReason: failure.incompleteReason,
        missingRequirements: failure.missingRequirements,
        ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
        partialText,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations,
        ...usageFields(state),
      }, evidence.boundaryOptions(evidenceOptions, { legacyBeforeAppend: true }))
      await recordCanaryTerminal('failed', failure.code, failedAt, partialText)
      return
    }

    if (result?.paused) {
      const text = finalClarificationText(result)
      const clarification = isRecord(result.clarification)
        ? {
            ...result.clarification,
            ...(!text && !result.clarification.reason_code && !result.clarification.reasonCode
              ? { reason_code: 'clarification_required' }
              : {}),
          }
        : typeof result.clarification === 'string' && result.clarification.trim()
          ? {
              question: result.clarification.trim(),
              reason_code: 'clarification_required',
              blocker_kind: 'missing_info',
            }
          : { reason_code: 'clarification_required', blocker_kind: 'missing_info' }
      const artifactIds = normalizeArtifactIds(result.artifactIds ?? state.checkpointArtifactIds)
      const deliveryArtifactIds = optionalDeliveryArtifactIds(
        result,
        normalizeArtifactIds(state.checkpointDeliveryArtifactIds),
      )
      const iterations = Math.max(0, Number(result.iterations) || state.checkpointIterations)
      const pausedAt = ports.now()
      const verifiedLocalFiles = evidence.verifiedLocalFilesAt(pausedAt)
      const retainedLocalFiles = evidence.retainedLocalFilesAt(pausedAt, verifiedLocalFiles)
      const createPausedMessage = (pausedEvent) => createPausedTurnMessage({
        userId,
        sessionId,
        turnId,
        text,
        clarification,
        pausedEventSequence: pausedEvent.sequence,
        checkpointMessages: state.checkpointMessages,
        baselineToolCallIds: state.baselineToolCallIds,
        verifiedLocalFiles,
        retainedLocalFiles,
        artifactIds,
        deliveryArtifactIds,
        iterations,
        pluginPromptBlockIds: state.promptContextSnapshot?.pluginPromptBlockIds,
        compactionArchiveId: result?.recovery?.archiveId || null,
        compactionRecovery: result?.recovery || state.checkpointRecovery,
        latestModelUsage: state.latestModelUsage,
        turnModelUsage: state.turnModelUsage,
        latestEstimatedPromptTokens: state.latestEstimatedPromptTokens,
        effectiveTurnStartedAt: state.effectiveTurnStartedAt,
        pausedAt,
      })
      await evidence.emitter('turn.paused', {
        text,
        clarification,
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        verifiedLocalFiles,
        retainedLocalFiles,
        iterations,
        ...usageFields(state),
      }, evidence.atomicTurnBoundary ? {
        commitEvent: ({ event }) => evidence.commitBoundaryEvent({
          event,
          message: createPausedMessage(event),
        }),
      } : {
        beforeAppend: async (event) => ports.writeMessage(createPausedMessage(event)),
      })
      return
    }

    const text = String(result?.text || '')
    const artifactIds = normalizeArtifactIds(result?.artifactIds ?? state.checkpointArtifactIds)
    const deliveryArtifactIds = optionalDeliveryArtifactIds(
      result,
      state.checkpointDeliveryArtifactIds,
    )
    const completedAt = ports.now()
    const verifiedLocalFiles = evidence.verifiedLocalFilesAt(completedAt)
    const retainedLocalFiles = evidence.retainedLocalFilesAt(completedAt, verifiedLocalFiles)
    if (retainedLocalFiles.length > 0) {
      return settleResult({
        scope,
        signal,
        result: {
          ...result,
          incomplete: true,
          partialText: text,
          code: 'TURN_INCOMPLETE',
          incompleteReason: 'post_mutation_verification_missing',
          missingRequirements: ['mutation_readback', 'diff_or_project_check'],
        },
        state,
        evidence,
        recordCanaryTerminal,
      })
    }
    const iterations = result?.iterations || 0
    const completedMessage = createCompletedTurnMessage({
      userId,
      sessionId,
      turnId,
      text,
      checkpointMessages: state.checkpointMessages,
      baselineToolCallIds: state.baselineToolCallIds,
      verifiedLocalFiles,
      retainedLocalFiles,
      artifactIds,
      deliveryArtifactIds,
      iterations,
      pluginPromptBlockIds: state.promptContextSnapshot?.pluginPromptBlockIds,
      compactionArchiveId: result?.recovery?.archiveId || null,
      compactionRecovery: result?.recovery || state.checkpointRecovery,
      latestModelUsage: state.latestModelUsage,
      turnModelUsage: state.turnModelUsage,
      latestEstimatedPromptTokens: state.latestEstimatedPromptTokens,
      effectiveTurnStartedAt: state.effectiveTurnStartedAt,
      completedAt,
    })
    await evidence.emitter('turn.completed', {
      text,
      artifactIds,
      ...deliveryArtifactFields(deliveryArtifactIds),
      verifiedLocalFiles,
      retainedLocalFiles,
      iterations,
      ...usageFields(state),
    }, {
      commitEvent: evidence.atomicTurnBoundary
        ? ({ event }) => evidence.commitBoundaryEvent({ event, message: completedMessage })
        : null,
      beforeAppend: evidence.atomicTurnBoundary
        ? null
        : async () => {
            try {
              await ports.writeMessage(completedMessage)
            } catch (error) {
              logWarn('turn.legacy_evidence_projection', error, {
                userId, sessionId, turnId, state: 'completed',
              })
            }
          },
    })
    await recordCanaryTerminal('completed', null, completedAt, text)
    void ports.dispatchHooks?.({
      userId,
      event: 'notification',
      tool: null,
      args: {
        text: String(text || '').slice(0, 4_000),
        artifactIds,
        ...deliveryArtifactFields(deliveryArtifactIds),
        iterations,
      },
      sessionId,
    }).catch(() => { /* notification hook is best-effort */ })
    try {
      ports.scheduleMemoryExtraction({
        userId,
        sessionId,
        agentId: state.promptContext?.effectiveAgentId || state.agentId || null,
        messages: state.historyMessages,
        assistantText: text,
        callModel: ({ messages }) => ports.runMemoryModel({ messages, userId }),
      })
    } catch (error) {
      logWarn('turn.memory_extraction_schedule', error, { userId, sessionId, turnId })
    }
  }

  async function settleError({ scope, signal, error, state, evidence, recordCanaryTerminal }) {
    const { userId, sessionId, turnId } = scope
    if (lostTurnLease(signal, error)) return
    if (isManualRecoveryBlock(error)) {
      await evidence.emitBlocked(error)
      return
    }
    if (String(error?.code || '').trim().toUpperCase() === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE) {
      throw error
    }
    const deferredPersistenceFailure = findEventPersistenceFailure(error)
    if (deferredPersistenceFailure) {
      await evidence.emitFailed(deferredPersistenceFailure)
      return
    }
    if (isExplicitTurnCancellation(signal, error)) {
      const cancelledAt = ports.now()
      const verifiedLocalFiles = evidence.verifiedLocalFilesAt(cancelledAt)
      const retainedLocalFiles = evidence.retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
      const artifactIds = normalizeArtifactIds(state.checkpointArtifactIds)
      const partialText = publicIncompleteText(state.streamedAssistantText, '')
      const deliveryArtifactIds = normalizeArtifactIds(state.checkpointDeliveryArtifactIds)
      const evidenceOptions = {
        state: 'cancelled',
        text: partialText,
        artifactIds,
        deliveryArtifactIds,
        iterations: state.checkpointIterations,
        verifiedLocalFiles,
        retainedLocalFiles,
        writtenAt: cancelledAt,
      }
      try {
        await evidence.emitter('turn.cancelled', {
          reason: error?.message || 'Cancelled by user',
          partialText,
          artifactIds,
          deliveryArtifactIds,
          verifiedLocalFiles,
          retainedLocalFiles,
          iterations: state.checkpointIterations,
          ...usageFields(state),
        }, evidence.boundaryOptions(evidenceOptions, {
          legacyBeforeAppend: true,
          legacyBestEffort: true,
        }))
      } catch (terminalError) {
        const deferredFailure = findEventPersistenceFailure(terminalError)
        if (!deferredFailure) throw terminalError
        await evidence.emitFailed(deferredFailure)
        return
      }
      await recordCanaryTerminal('cancelled', null, cancelledAt, evidenceOptions.text)
      return
    }
    await evidence.emitFailed(error)
  }

  return Object.freeze({ cancelBeforeExecution, settleResult, settleError })
}
