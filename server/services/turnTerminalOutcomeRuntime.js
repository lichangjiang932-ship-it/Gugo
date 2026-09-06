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

async function cancelBeforeExecution(runtime, {
  scope,
  signal,
  emitter,
  executionLease = null,
  turnStartedAt,
}) {
  if (!signal?.aborted) return false
  if (lostTurnLease(signal)) return true
  const { userId, sessionId, turnId } = scope
  const cancelledAt = runtime.ports.now()
  const message = createInitialCancellationMessage({
    userId, sessionId, turnId, turnStartedAt, cancelledAt,
  })
  const atomic = !!runtime.ports.commitTurnBoundary
  await emitter('turn.cancelled', {
    code: 'TURN_CANCELLED',
    partialText: '',
    artifactIds: [],
    deliveryArtifactIds: [],
    verifiedLocalFiles: [],
    retainedLocalFiles: [],
    iterations: 0,
  }, {
    commitEvent: atomic
      ? ({ event }) => runtime.ports.commitTurnBoundary({
          userId, event, message, executionLease,
        })
      : null,
    afterAppend: atomic
      ? null
      : async () => {
          try { await runtime.ports.writeMessage(message) }
          catch (error) {
            logWarn('turn.legacy_evidence_projection', error, {
              userId, sessionId, turnId, state: 'cancelled',
            })
          }
        },
  })
  return true
}

async function settleCancelledResult(runtime, context) {
  const { state, evidence, recordCanaryTerminal } = context
  const cancelledAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(cancelledAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
  const artifactIds = normalizeArtifactIds(state.checkpointArtifactIds)
  const partialText = publicIncompleteText(state.streamedAssistantText, '')
  const deliveryArtifactIds = normalizeArtifactIds(state.checkpointDeliveryArtifactIds)
  const evidenceOptions = {
    state: 'cancelled', text: partialText, artifactIds, deliveryArtifactIds,
    iterations: state.checkpointIterations, verifiedLocalFiles, retainedLocalFiles,
    writtenAt: cancelledAt,
  }
  await evidence.emitter('turn.cancelled', {
    code: 'TURN_CANCELLED', partialText, artifactIds, deliveryArtifactIds,
    verifiedLocalFiles, retainedLocalFiles, iterations: state.checkpointIterations,
    ...usageFields(state),
  }, evidence.boundaryOptions(evidenceOptions, {
    legacyAfterAppend: true,
    legacyBestEffort: true,
  }))
  await recordCanaryTerminal('cancelled', null, cancelledAt, partialText)
}

function normalizedIncompleteResult(result) {
  if (result?.incomplete || result?.interrupted || result?.paused
    || isSuccessfulTurnCompletedEvent({ type: 'turn.completed', payload: result })) return result
  return {
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
    incomplete: true,
    partialText: result?.partialText || result?.text || '',
    reason: result?.incompleteReason || result?.reason || 'turn_incomplete',
  }
}

async function settleInterruptedResult(runtime, context) {
  const { result, state, evidence } = context
  const artifactIds = normalizeArtifactIds(result.artifactIds ?? state.checkpointArtifactIds)
  const deliveryArtifactIds = optionalDeliveryArtifactIds(
    result,
    normalizeArtifactIds(state.checkpointDeliveryArtifactIds),
  )
  const iterations = Math.max(0, Number(result.iterations) || state.checkpointIterations)
  const partialText = publicIncompleteText(result.partialText || state.streamedAssistantText, '')
  const interruptedAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(interruptedAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(interruptedAt, verifiedLocalFiles)
  const incompleteReason = normalizeIncompleteReason(
    result.incompleteReason || result.reasonCode || result.reason,
    'model_call_interrupted',
  )
  const explicitMissing = Array.isArray(result.missingRequirements) ? result.missingRequirements : []
  const missingRequirements = explicitMissing.length > 0
    ? explicitMissing
    : missingRequirementsForIncompleteReason(incompleteReason)
  const failure = normalizeTurnFailure({
    code: result.code,
    incompleteReason,
    missingRequirements,
    retryable: true,
    taskVerification: result.taskVerification,
  }, { code: 'MODEL_CALL_INTERRUPTED', retryable: true })
  const evidenceOptions = {
    state: 'interrupted', text: partialText, artifactIds, deliveryArtifactIds,
    iterations, error: failure, verifiedLocalFiles, retainedLocalFiles,
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
}

async function settleIncompleteResult(runtime, context) {
  const { result, state, evidence, recordCanaryTerminal } = context
  const partialText = publicIncompleteText(result.partialText || state.streamedAssistantText, '')
  const resultCode = String(result.code || '').trim()
  const incompleteReason = normalizeIncompleteReason(
    result.budgetExceeded === true
      ? 'execution_budget_exhausted'
      : result.noProgress === true
        ? 'tool_no_progress'
        : resultCode === 'REASONING_RUNAWAY' ? 'reasoning_runaway' : result.reason,
  )
  const explicitMissing = Array.isArray(result.missingRequirements) ? result.missingRequirements : []
  const missingRequirements = explicitMissing.length > 0
    ? explicitMissing
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
  const failedAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(failedAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(failedAt, verifiedLocalFiles)
  const evidenceOptions = {
    state: 'failed', text: partialText, artifactIds, deliveryArtifactIds,
    iterations, error: failure, verifiedLocalFiles, retainedLocalFiles, writtenAt: failedAt,
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
}

async function settlePausedResult(runtime, context) {
  const { scope, result, state, evidence } = context
  const { userId, sessionId, turnId } = scope
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
  const pausedAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(pausedAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(pausedAt, verifiedLocalFiles)
  const createMessage = (event) => createPausedTurnMessage({
    userId, sessionId, turnId, text, clarification,
    pausedEventSequence: event.sequence,
    checkpointMessages: state.checkpointMessages,
    baselineToolCallIds: state.baselineToolCallIds,
    verifiedLocalFiles, retainedLocalFiles, artifactIds, deliveryArtifactIds, iterations,
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
    text, clarification, artifactIds, ...deliveryArtifactFields(deliveryArtifactIds),
    verifiedLocalFiles, retainedLocalFiles, iterations, ...usageFields(state),
  }, evidence.atomicTurnBoundary
    ? { commitEvent: ({ event }) => evidence.commitBoundaryEvent({ event, message: createMessage(event) }) }
    : { beforeAppend: async (event) => runtime.ports.writeMessage(createMessage(event)) })
}

async function settleCompletedResult(runtime, context) {
  const { scope, result, state, evidence, recordCanaryTerminal } = context
  const { userId, sessionId, turnId } = scope
  const text = String(result?.text || '')
  const artifactIds = normalizeArtifactIds(result?.artifactIds ?? state.checkpointArtifactIds)
  const deliveryArtifactIds = optionalDeliveryArtifactIds(result, state.checkpointDeliveryArtifactIds)
  const completedAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(completedAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(completedAt, verifiedLocalFiles)
  const iterations = result?.iterations || 0
  const message = createCompletedTurnMessage({
    userId, sessionId, turnId, text,
    checkpointMessages: state.checkpointMessages,
    baselineToolCallIds: state.baselineToolCallIds,
    verifiedLocalFiles, retainedLocalFiles, artifactIds, deliveryArtifactIds, iterations,
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
    text, artifactIds, ...deliveryArtifactFields(deliveryArtifactIds),
    verifiedLocalFiles, retainedLocalFiles, iterations, ...usageFields(state),
  }, {
    commitEvent: evidence.atomicTurnBoundary
      ? ({ event }) => evidence.commitBoundaryEvent({ event, message })
      : null,
    afterAppend: evidence.atomicTurnBoundary
      ? null
      : async () => {
          try { await runtime.ports.writeMessage(message) }
          catch (error) {
            logWarn('turn.legacy_evidence_projection', error, {
              userId, sessionId, turnId, state: 'completed',
            })
          }
        },
  })
  await recordCanaryTerminal('completed', null, completedAt, text)
  void runtime.ports.dispatchHooks?.({
    userId,
    event: 'notification',
    tool: null,
    args: { text: text.slice(0, 4_000), artifactIds, ...deliveryArtifactFields(deliveryArtifactIds), iterations },
    sessionId,
  }).catch(() => {})
  try {
    runtime.ports.scheduleMemoryExtraction({
      userId,
      sessionId,
      agentId: state.promptContext?.effectiveAgentId || state.agentId || null,
      messages: state.historyMessages,
      assistantText: text,
      callModel: ({ messages }) => runtime.ports.runMemoryModel({ messages, userId }),
    })
  } catch (error) {
    logWarn('turn.memory_extraction_schedule', error, { userId, sessionId, turnId })
  }
}

async function settleResult(runtime, context) {
  if (context.signal.aborted) {
    if (lostTurnLease(context.signal)) return
    return settleCancelledResult(runtime, context)
  }
  context.result = normalizedIncompleteResult(context.result)
  if (context.result?.interrupted) return settleInterruptedResult(runtime, context)
  if (context.result?.incomplete) return settleIncompleteResult(runtime, context)
  if (context.result?.paused) return settlePausedResult(runtime, context)
  return settleCompletedResult(runtime, context)
}

async function settleError(runtime, context) {
  const { signal, error, state, evidence, recordCanaryTerminal } = context
  if (lostTurnLease(signal, error)) return
  if (isManualRecoveryBlock(error)) return evidence.emitBlocked(error)
  if (String(error?.code || '').trim().toUpperCase() === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE) {
    throw error
  }
  const deferredFailure = findEventPersistenceFailure(error)
  if (deferredFailure) return evidence.emitFailed(deferredFailure)
  if (!isExplicitTurnCancellation(signal, error)) return evidence.emitFailed(error)
  const cancelledAt = runtime.ports.now()
  const verifiedLocalFiles = evidence.verifiedLocalFilesAt(cancelledAt)
  const retainedLocalFiles = evidence.retainedLocalFilesAt(cancelledAt, verifiedLocalFiles)
  const artifactIds = normalizeArtifactIds(state.checkpointArtifactIds)
  const partialText = publicIncompleteText(state.streamedAssistantText, '')
  const deliveryArtifactIds = normalizeArtifactIds(state.checkpointDeliveryArtifactIds)
  const evidenceOptions = {
    state: 'cancelled', text: partialText, artifactIds, deliveryArtifactIds,
    iterations: state.checkpointIterations, verifiedLocalFiles, retainedLocalFiles,
    writtenAt: cancelledAt,
  }
  try {
    await evidence.emitter('turn.cancelled', {
      code: 'TURN_CANCELLED', partialText, artifactIds, deliveryArtifactIds,
      verifiedLocalFiles, retainedLocalFiles, iterations: state.checkpointIterations,
      ...usageFields(state),
    }, evidence.boundaryOptions(evidenceOptions, {
      legacyAfterAppend: true,
      legacyBestEffort: true,
    }))
  } catch (terminalError) {
    const deferred = findEventPersistenceFailure(terminalError)
    if (!deferred) throw terminalError
    await evidence.emitFailed(deferred)
    return
  }
  await recordCanaryTerminal('cancelled', null, cancelledAt, evidenceOptions.text)
}

/** Project model-loop results and errors into one durable terminal outcome. */
export function createTurnTerminalOutcomeRuntime({
  now,
  writeMessage,
  commitTurnBoundary = null,
  dispatchHooks = null,
  scheduleMemoryExtraction,
  runMemoryModel,
} = {}) {
  const runtime = {
    ports: {
      now: requirePort('now', now),
      writeMessage: requirePort('writeMessage', writeMessage),
      commitTurnBoundary: typeof commitTurnBoundary === 'function' ? commitTurnBoundary : null,
      dispatchHooks: typeof dispatchHooks === 'function' ? dispatchHooks : null,
      scheduleMemoryExtraction: requirePort('scheduleMemoryExtraction', scheduleMemoryExtraction),
      runMemoryModel: requirePort('runMemoryModel', runMemoryModel),
    },
  }
  return Object.freeze({
    cancelBeforeExecution: (input) => cancelBeforeExecution(runtime, input),
    settleResult: (input) => settleResult(runtime, input),
    settleError: (input) => settleError(runtime, input),
  })
}
