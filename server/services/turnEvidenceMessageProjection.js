import { buildAssistantModelContext } from './turnMessageContext.js'
import { normalizeArtifactIds } from './turnTerminalProjection.js'
import { normalizeTurnOptionalId as normalizeOptionalId } from './turnStartRuntime.js'

export function createInitialCancellationMessage({
  userId,
  sessionId,
  turnId,
  turnStartedAt,
  cancelledAt,
}) {
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    // Cancellation status is event metadata, not model-authored output.
    content: '',
    modelContext: {
      ...buildAssistantModelContext({
        turnId,
        checkpointMessages: [],
        baselineToolCallIds: new Set(),
        userId,
        verifiedLocalFiles: [],
        retainedLocalFiles: [],
        artifactIds: [],
        deliveryArtifactIds: [],
        iterations: 0,
        turnStartedAt,
        turnCompletedAt: cancelledAt,
      }),
      turnEvidence: true,
      evidenceState: 'cancelled',
    },
    createdAt: cancelledAt,
    updatedAt: cancelledAt,
  }
}

function recoveryProjection(state, blockedRecovery) {
  const recoveryKind = state === 'blocked' && blockedRecovery?.requiresUserVerification === true
    ? String(blockedRecovery.recoveryKind || '').trim()
    : ''
  const recoveryToolCallId = recoveryKind === 'side_effect_outcome_unknown'
    ? normalizeOptionalId(blockedRecovery.toolCallId)
    : null
  const recoveryModelRequestId = recoveryKind === 'model_request_outcome_unknown'
    ? normalizeOptionalId(blockedRecovery.modelRequestId)
    : null
  return ['side_effect_outcome_unknown', 'model_request_outcome_unknown'].includes(recoveryKind)
    ? {
        recoveryKind,
        requiresUserVerification: true,
        ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
        ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
        recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
      }
    : null
}

export function createTurnEvidenceMessage({
  state,
  text,
  artifactIds,
  deliveryArtifactIds,
  iterations,
  error = null,
  serverLastSequence = null,
  verifiedLocalFiles,
  retainedLocalFiles,
  blockedRecovery = null,
  writtenAt,
}, {
  userId,
  sessionId,
  turnId,
  checkpointMessages,
  baselineToolCallIds,
  pluginPromptBlockIds,
  checkpointRecovery,
  latestModelUsage,
  turnModelUsage,
  latestEstimatedPromptTokens,
  effectiveTurnStartedAt,
}) {
  // Assistant content is reserved for model-authored output. Failure and
  // recovery copy stays in structured metadata so each client can render
  // it in the user's selected language.
  const evidenceText = String(text ?? '').trim()
  const evidenceArtifacts = normalizeArtifactIds(artifactIds)
  const evidenceIterations = Math.max(0, Number(iterations) || 0)
  const evidenceRecovery = recoveryProjection(state, blockedRecovery)
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: evidenceText,
    modelContext: {
      ...buildAssistantModelContext({
        turnId,
        checkpointMessages,
        baselineToolCallIds,
        userId,
        verifiedLocalFiles,
        retainedLocalFiles,
        artifactIds: evidenceArtifacts,
        deliveryArtifactIds,
        iterations: evidenceIterations,
        pluginPromptBlockIds,
        compactionRecovery: checkpointRecovery,
        usage: latestModelUsage,
        turnModelUsage,
        estimatedPromptTokens: latestEstimatedPromptTokens,
        turnStartedAt: effectiveTurnStartedAt,
        turnCompletedAt: writtenAt,
      }),
      turnEvidence: true,
      evidenceState: state,
      ...(Number.isInteger(serverLastSequence) && serverLastSequence >= 0
        ? { serverLastSequence }
        : {}),
      ...(error ? { error } : {}),
      ...(evidenceRecovery ? { recovery: evidenceRecovery } : {}),
    },
    createdAt: writtenAt,
    updatedAt: writtenAt,
  }
}

export function createPausedTurnMessage({
  userId,
  sessionId,
  turnId,
  text,
  clarification,
  pausedEventSequence,
  checkpointMessages,
  baselineToolCallIds,
  verifiedLocalFiles,
  retainedLocalFiles,
  artifactIds,
  deliveryArtifactIds,
  iterations,
  pluginPromptBlockIds,
  compactionArchiveId,
  compactionRecovery,
  latestModelUsage,
  turnModelUsage,
  latestEstimatedPromptTokens,
  effectiveTurnStartedAt,
  pausedAt,
}) {
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: text,
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
        paused: true,
        pluginPromptBlockIds,
        compactionArchiveId,
        compactionRecovery,
        usage: latestModelUsage,
        turnModelUsage,
        estimatedPromptTokens: latestEstimatedPromptTokens,
        turnStartedAt: effectiveTurnStartedAt,
        turnCompletedAt: pausedAt,
      }),
      clarification,
      pausedSequence: pausedEventSequence,
    },
    createdAt: pausedAt,
    updatedAt: pausedAt,
  }
}

export function createCompletedTurnMessage({
  userId,
  sessionId,
  turnId,
  text,
  checkpointMessages,
  baselineToolCallIds,
  verifiedLocalFiles,
  retainedLocalFiles,
  artifactIds,
  deliveryArtifactIds,
  iterations,
  pluginPromptBlockIds,
  compactionArchiveId,
  compactionRecovery,
  latestModelUsage,
  turnModelUsage,
  latestEstimatedPromptTokens,
  effectiveTurnStartedAt,
  completedAt,
}) {
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: text,
    modelContext: buildAssistantModelContext({
      turnId,
      checkpointMessages,
      baselineToolCallIds,
      userId,
      verifiedLocalFiles,
      retainedLocalFiles,
      artifactIds,
      deliveryArtifactIds,
      iterations,
      pluginPromptBlockIds,
      compactionArchiveId,
      compactionRecovery,
      usage: latestModelUsage,
      turnModelUsage,
      estimatedPromptTokens: latestEstimatedPromptTokens,
      turnStartedAt: effectiveTurnStartedAt,
      turnCompletedAt: completedAt,
    }),
    createdAt: completedAt,
    updatedAt: completedAt,
  }
}
