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
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from './turnRecoveryProjection.js'
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

const GENERIC_TURN_FAILURE_CODES = new Set([
  'TURN_FAILED',
  'INVALID_TURN_REQUEST',
  'INTERNAL_ERROR',
  'UNKNOWN_ERROR',
])

function inferredIncompleteReason(failure) {
  if (failure?.incompleteReason) return failure.incompleteReason
  const code = String(failure?.code || '').trim().toUpperCase()
  if (!code || GENERIC_TURN_FAILURE_CODES.has(code)) return 'turn_incomplete'
  if (code === 'REASONING_RUNAWAY') return 'reasoning_runaway'
  if (code === 'TURN_COMPLETION_INVALID') return 'post_mutation_verification_missing'
  if (/^(?:REPEATED_TOOL_CALL|TOOL_NO_PROGRESS)/u.test(code)) return 'tool_no_progress'
  if (/^(?:MODEL_|TURN_MODEL_)/u.test(code)) return 'model_call_interrupted'
  if (/(?:PERSISTENCE|CHECKPOINT|RECOVERY|LEASE|CONTEXT_DRIFT|EVENT_SEQUENCE)/u.test(code)) {
    return 'recovery_blocked'
  }
  return /^[A-Z][A-Z0-9_]{1,95}$/u.test(code) ? code.toLowerCase() : 'turn_incomplete'
}

function inferredMissingRequirements(failure, incompleteReason) {
  if (Array.isArray(failure?.missingRequirements)
    && failure.missingRequirements.length > 0) return failure.missingRequirements
  const code = String(failure?.code || '').trim().toUpperCase()
  if (/^(?:TOOL_|TURN_TOOL_|BASH_|DOCKER_|LSP_|RUN_CODE_)/u.test(code)) {
    return ['execution_environment_repair', 'remaining_task_steps']
  }
  return missingRequirementsForIncompleteReason(incompleteReason)
}

function stateSnapshot(runtime) {
  const state = runtime.ports.readState()
  return state && typeof state === 'object' ? state : {}
}

function verifiedLocalFilesAt(runtime, verifiedAt = runtime.ports.now()) {
  const state = stateSnapshot(runtime)
  return extractVerifiedLocalFiles(state.checkpointMessages, {
    userId: runtime.scope.userId,
    baselineToolCallIds: state.baselineToolCallIds,
    verifiedAt,
  })
}

function retainedLocalFilesAt(runtime, retainedAt = runtime.ports.now(), verifiedLocalFiles = []) {
  const state = stateSnapshot(runtime)
  const verifiedIds = new Set((Array.isArray(verifiedLocalFiles) ? verifiedLocalFiles : [])
    .map((file) => String(file?.id || '').trim()).filter(Boolean))
  return extractRetainedLocalFiles(state.checkpointMessages, {
    userId: runtime.scope.userId,
    baselineToolCallIds: state.baselineToolCallIds,
    retainedAt,
  }).filter((file) => !verifiedIds.has(String(file?.id || '').trim()))
}

function projectEvidence(runtime, options = {}) {
  const state = stateSnapshot(runtime)
  const writtenAt = options.writtenAt ?? runtime.ports.now()
  const verifiedLocalFiles = Array.isArray(options.verifiedLocalFiles)
    ? options.verifiedLocalFiles
    : verifiedLocalFilesAt(runtime, writtenAt)
  const retainedLocalFiles = Array.isArray(options.retainedLocalFiles)
    ? options.retainedLocalFiles
    : retainedLocalFilesAt(runtime, writtenAt, verifiedLocalFiles)
  return createTurnEvidenceMessage({
    ...options, writtenAt, verifiedLocalFiles, retainedLocalFiles,
  }, {
    ...runtime.scope,
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

function boundaryOptions(runtime, options, {
  legacyBeforeAppend = false,
  legacyAfterAppend = false,
  legacyBestEffort = false,
} = {}) {
  if (runtime.atomicTurnBoundary) {
    return {
      commitEvent: ({ event }) => runtime.ports.commitTurnBoundary({
        userId: runtime.scope.userId,
        event,
        message: projectEvidence(runtime, { ...options, serverLastSequence: event.sequence }),
        executionLease: runtime.executionLease,
      }),
    }
  }
  if (!legacyBeforeAppend && !legacyAfterAppend) return {}
  return {
    afterAppend: async (storedEvent) => {
      try {
        await runtime.ports.writeMessage(projectEvidence(runtime, {
          ...options,
          serverLastSequence: storedEvent.sequence,
        }))
      } catch (error) {
        if (!legacyBestEffort) throw error
        logWarn('turn.legacy_evidence_projection', error, {
          ...runtime.scope,
          state: options.state,
        })
      }
    },
  }
}

function failureEvidence(runtime, sourceError, state, timestamp) {
  const verifiedLocalFiles = mergeLocalFileReceipts(
    sourceError?.verifiedLocalFiles,
    verifiedLocalFilesAt(runtime, timestamp),
  )
  const retainedLocalFiles = excludeVerifiedLocalFiles(
    mergeLocalFileReceipts(
      sourceError?.retainedLocalFiles,
      retainedLocalFilesAt(runtime, timestamp, verifiedLocalFiles),
    ),
    verifiedLocalFiles,
  )
  return {
    artifactIds: normalizeArtifactIds(sourceError?.artifactIds ?? state.checkpointArtifactIds),
    deliveryArtifactIds: optionalDeliveryArtifactIds(
      sourceError,
      normalizeArtifactIds(state.checkpointDeliveryArtifactIds),
    ),
    iterations: Math.max(0, Number(sourceError?.iterations) || state.checkpointIterations),
    verifiedLocalFiles,
    retainedLocalFiles,
    partialText: publicIncompleteText(
      sourceError?.partialText || state.streamedAssistantText,
      '',
    ),
  }
}

async function emitFailed(runtime, sourceError) {
  const state = stateSnapshot(runtime)
  const failedAt = runtime.ports.now()
  const evidence = failureEvidence(runtime, sourceError, state, failedAt)
  let activeError = findEventPersistenceFailure(sourceError) || sourceError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const projectedFailure = normalizeTurnFailure(activeError)
    const incompleteReason = inferredIncompleteReason(projectedFailure)
    const failure = {
      ...projectedFailure,
      incompleteReason,
      missingRequirements: inferredMissingRequirements(projectedFailure, incompleteReason),
    }
    const evidenceOptions = {
      state: 'failed',
      text: evidence.partialText,
      ...evidence,
      error: failure,
      writtenAt: failedAt,
    }
    try {
      const failedEvent = await runtime.ports.emitter('turn.failed', {
        code: failure.code,
        error: failure,
        ...(failure.incompleteReason ? { incompleteReason: failure.incompleteReason } : {}),
        ...(Array.isArray(failure.missingRequirements)
          ? { missingRequirements: failure.missingRequirements }
          : {}),
        ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
        partialText: evidence.partialText,
        artifactIds: evidence.artifactIds,
        ...deliveryArtifactFields(evidence.deliveryArtifactIds),
        verifiedLocalFiles: evidence.verifiedLocalFiles,
        retainedLocalFiles: evidence.retainedLocalFiles,
        iterations: evidence.iterations,
        ...usageFields(state),
      }, boundaryOptions(runtime, evidenceOptions))
      if (!runtime.atomicTurnBoundary) {
        try {
          await runtime.ports.writeMessage(projectEvidence(runtime, {
            ...evidenceOptions,
            serverLastSequence: failedEvent.sequence,
          }))
        } catch (error) {
          logWarn('turn.legacy_evidence_projection', error, {
            ...runtime.scope, state: 'failed',
          })
        }
      }
      await runtime.ports.recordCanaryTerminal(
        'failed', failure.code, failedAt, evidence.partialText,
      )
      return
    } catch (terminalError) {
      const deferredFailure = findEventPersistenceFailure(terminalError)
      const terminalUnknown = String(terminalError?.code || '').trim().toUpperCase()
        === TURN_TERMINAL_PERSISTENCE_FAILURE_CODE
      if (deferredFailure && !terminalUnknown && attempt === 0) {
        activeError = deferredFailure
        continue
      }
      throw createTerminalPersistenceFailure(terminalError)
    }
  }
}

function blockedFailure(sourceError) {
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
  return {
    failure: normalizeTurnFailure({
      ...sourceError,
      code: baseFailure.code,
      incompleteReason,
      missingRequirements,
      manualRetryable: true,
      retryable: false,
    }, { retryable: false }),
    sideEffectUnknown,
    modelRequestUnknown,
  }
}

async function emitBlocked(runtime, sourceError) {
  const state = stateSnapshot(runtime)
  const { failure, sideEffectUnknown, modelRequestUnknown } = blockedFailure(sourceError)
  const recoveryToolCallId = sideEffectUnknown
    ? normalizeOptionalId(sourceError?.sideEffectExecution?.toolCallId)
    : null
  const recoveryModelRequestId = modelRequestUnknown
    ? normalizeOptionalId(sourceError?.modelRequestId || sourceError?.modelInvocation?.id)
    : null
  const blockedAt = runtime.ports.now()
  const evidence = failureEvidence(runtime, sourceError, state, blockedAt)
  const blockedRecovery = sideEffectUnknown
    ? {
        recoveryKind: 'side_effect_outcome_unknown', requiresUserVerification: true,
        ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
      }
    : modelRequestUnknown
      ? {
          recoveryKind: 'model_request_outcome_unknown', requiresUserVerification: true,
          ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
        }
      : null
  const evidenceOptions = {
    state: 'blocked',
    text: evidence.partialText,
    ...evidence,
    error: { ...failure, retryable: false },
    blockedRecovery,
    writtenAt: blockedAt,
  }
  const blockedEvent = await runtime.ports.emitter('turn.blocked', {
    code: failure.code,
    error: failure,
    incompleteReason: failure.incompleteReason,
    missingRequirements: failure.missingRequirements,
    ...(failure.taskVerification ? { taskVerification: failure.taskVerification } : {}),
    partialText: evidence.partialText,
    retryable: false,
    manualRetryable: true,
    recoveryStatus: 'dead_letter',
    ...(sideEffectUnknown ? {
      turnId: runtime.scope.turnId,
      requiresUserVerification: true,
      recoveryKind: 'side_effect_outcome_unknown',
      ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
      recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
    } : {}),
    ...(modelRequestUnknown ? {
      turnId: runtime.scope.turnId,
      requiresUserVerification: true,
      recoveryKind: 'model_request_outcome_unknown',
      ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
      recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
    } : {}),
    checkpointSequence: state.latestCheckpointSequence,
    ...evidence,
  }, boundaryOptions(runtime, evidenceOptions, {
    legacyAfterAppend: true,
    legacyBestEffort: true,
  }))
  await runtime.ports.writeRecoveryFailure({
    ...runtime.scope,
    candidateVersion: recoveryCandidateVersion(blockedEvent),
    retryable: false,
    errorCode: failure.code,
    errorMessage: String(sourceError?.message || failure.code),
    now: blockedEvent.createdAt,
  })
}

/** Own terminal evidence projection and its durability boundary for one Turn. */
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
  const runtime = { scope: { userId, sessionId, turnId }, ports, executionLease }
  runtime.atomicTurnBoundary = !!ports.commitTurnBoundary
  return Object.freeze({
    emitter: ports.emitter,
    atomicTurnBoundary: runtime.atomicTurnBoundary,
    verifiedLocalFilesAt: (at) => verifiedLocalFilesAt(runtime, at),
    retainedLocalFilesAt: (at, files) => retainedLocalFilesAt(runtime, at, files),
    projectEvidence: (options) => projectEvidence(runtime, options),
    persistEvidence: async (options) => {
      const message = projectEvidence(runtime, options)
      await ports.writeMessage(message)
      return message.content
    },
    commitBoundaryEvent: ({ event, message }) => ports.commitTurnBoundary({
      userId, event, message, executionLease,
    }),
    boundaryOptions: (options, legacy) => boundaryOptions(runtime, options, legacy),
    emitFailed: (error) => emitFailed(runtime, error),
    emitBlocked: (error) => emitBlocked(runtime, error),
  })
}
