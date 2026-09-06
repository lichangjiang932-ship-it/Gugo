import { normalizeModelUsage } from '../../shared/modelUsage.js'
import {
  expandStoredMessages,
  selectAttachmentIdsForModelRequest,
  selectStoredMessagesAfterCompaction,
} from './turnMessageContext.js'
import {
  assertTurnExecutionEnvironmentCompatible,
  createTurnExecutionEnvironmentSnapshot,
} from './turnExecutionEnvironment.js'
import { logWarn } from '../utils/logger.js'
import {
  checkpointMessagesForTurn,
  latestLegacyCheckpoint,
  recoveryAttemptAfterCheckpoint,
  storedCheckpointEvent,
} from './turnRecoveryProjection.js'
import { normalizeArtifactIds, optionalDeliveryArtifactIds } from './turnTerminalProjection.js'
import { normalizePromptTokenEstimate } from './turnModelUsageProjection.js'
import { createTurnTerminalEvidenceRuntime } from './turnTerminalEvidenceRuntime.js'
import { createTurnLoopExecutionRuntime } from './turnLoopExecutionRuntime.js'
import {
  checkpointStateForResolution,
  isTemporaryTurnEvidence,
  normalizePromptContextSnapshot,
} from './turnEnginePolicy.js'
import { resetManualRetryVerificationBudget } from './turnFailedRetryPolicy.js'
import { filterAuthorizedDirectoryResolutions } from './turnResolutionRuntime.js'

export function checkpointStateForFailedRetry(state, { manualRetry = false } = {}) {
  if (!state || typeof state !== 'object') return state || null
  const restored = state.final ? { ...state, final: null } : { ...state }
  return manualRetry ? resetManualRetryVerificationBudget(restored) : restored
}

async function loadTurnExecutionRecovery(runtime, input) {
  const { deps } = runtime
  const { userId, sessionId, turnId, content, failedRetryActive, manualFailedRetryActive,
    resumeContext } = input
  const scope = { userId, sessionId, turnId }
  const effectiveTurnStartedAt = Number.isFinite(Number(input.turnStartedAt))
    ? Math.max(0, Number(input.turnStartedAt))
    : deps.now()
  const storedCheckpoint = storedCheckpointEvent(await deps.runtimeCore.checkpoint.load(scope))
  const checkpoint = storedCheckpoint || await latestLegacyCheckpoint(deps.replayEvents, scope)
  const resolved = checkpointStateForResolution(checkpoint?.payload?.state, resumeContext)
  const retryState = failedRetryActive
    ? checkpointStateForFailedRetry(resolved, { manualRetry: manualFailedRetryActive })
    : resolved
  let fileAccessStatus
  try { fileAccessStatus = deps.readFileAccessStatus({ userId }) }
  catch { fileAccessStatus = null }
  const restoredCheckpointState = retryState
    && Object.hasOwn(retryState, 'directoryAuthorizationResolution')
    ? {
        ...retryState,
        directoryAuthorizationResolution: filterAuthorizedDirectoryResolutions(
          retryState.directoryAuthorizationResolution,
          fileAccessStatus?.grants,
        ),
      }
    : retryState
  const steeringOwnerId = String(deps.runtimeCore.lease.ownerId || '').trim() || null
  const steeringScope = { ...scope, ownerId: steeringOwnerId }
  if (steeringOwnerId) {
    const appliedSteeringIds = Array.isArray(checkpoint?.payload?.state?.appliedSteeringIds)
      ? checkpoint.payload.state.appliedSteeringIds
      : []
    await deps.acknowledgeAppliedSteering({
      ...steeringScope, steeringIds: appliedSteeringIds, now: deps.now(),
    })
    await deps.releaseStaleSteering({ ...steeringScope, now: deps.now() })
  }
  const pendingRecoveryAttempt = await recoveryAttemptAfterCheckpoint(
    deps.replayEvents,
    scope,
    checkpoint,
  )
  const storedMessages = (await deps.readMessages({
    userId, sessionId, limit: 500, recent: true,
  }))
    .filter((message) => !isTemporaryTurnEvidence(message, turnId))
    .filter((message) => !(message?.id === `${turnId}:assistant`
      && message?.modelContext?.paused === true))
    .filter((message) => !(message?.modelContext?.liveSteering === true
      && message?.modelContext?.turnId === turnId))
    .map((message) => message.id === `${turnId}:user`
      ? { ...message, content }
      : message)
  const currentUserMessage = storedMessages.find((message) => message.id === `${turnId}:user`)
  const previousUserPrompt = (await deps.readPreviousUserMessage({
    userId, sessionId, messageId: `${turnId}:user`,
  }))?.content || ''
  const managedAttachments = Array.isArray(currentUserMessage?.modelContext?.attachments)
    ? currentUserMessage.modelContext.attachments
    : []
  return {
    scope, effectiveTurnStartedAt, checkpoint, restoredCheckpointState,
    fileAccessStatus, steeringOwnerId, steeringScope, pendingRecoveryAttempt,
    storedMessages, currentUserMessage, previousUserPrompt, managedAttachments,
  }
}

async function prepareTurnPromptAndTools(runtime, input, recovery) {
  const { deps, executionToolContextRuntime } = runtime
  const { userId, sessionId, turnId, content, agentId, skillIds, skillDefinitions } = input
  const restoredSnapshot = normalizePromptContextSnapshot(
    recovery.restoredCheckpointState?.promptContextSnapshot,
  )
  let canaryAssignment = restoredSnapshot?.canaryAssignment || null
  let promptContext = {
    messages: [],
    effectiveAgentId: restoredSnapshot?.effectiveAgentId || agentId,
    skillIds: restoredSnapshot?.skillIds || skillIds,
    memoryIds: restoredSnapshot?.memoryIds || [],
    pluginPromptBlockIds: restoredSnapshot?.pluginPromptBlockIds || [],
    compactionArchiveId: null,
    compactionBoundary: null,
    canaryAssignment,
  }
  if (!restoredSnapshot) {
    try {
      canaryAssignment = await deps.resolveCanaryAssignment({
        userId, sessionId, turnId, env: deps.env, now: deps.now(),
      })
    } catch (error) {
      try { logWarn('evolution.canary.resolve', error, recovery.scope) } catch { /* optional */ }
    }
    try {
      promptContext = await deps.preparePromptContext({
        userId, agentId, skillIds, skillDefinitions, sessionId,
        recentMessages: recovery.storedMessages,
        includeRecentTranscript: false,
        query: content,
        canaryAssignment,
        env: deps.env,
      }) || promptContext
    } catch (error) {
      if (String(error?.code || '').trim() !== 'TURN_PROMPT_RUNTIME_NOT_CONFIGURED') {
        logWarn('turn.optional_prompt_context', error, recovery.scope)
      }
      canaryAssignment = null
    }
  }
  const promptContextSnapshot = restoredSnapshot || normalizePromptContextSnapshot({
    effectiveAgentId: promptContext.effectiveAgentId || agentId,
    skillIds: promptContext.skillIds,
    memoryIds: promptContext.memoryIds,
    pluginPromptBlockIds: promptContext.pluginPromptBlockIds,
    canaryAssignment: canaryAssignment || promptContext.canaryAssignment,
  })
  const selected = selectStoredMessagesAfterCompaction(
    recovery.storedMessages,
    promptContext.compactionBoundary,
  )
  const promptStoredMessages = recovery.currentUserMessage
    && !selected.some((message) => message?.id === recovery.currentUserMessage.id)
    ? [...selected, recovery.currentUserMessage]
    : selected
  const historyMessages = expandStoredMessages(promptStoredMessages)
  const messages = [
    ...(Array.isArray(promptContext.messages) ? promptContext.messages : []),
    ...historyMessages,
  ]
  const toolResolutionMessages = Array.isArray(recovery.restoredCheckpointState?.messages)
    ? recovery.restoredCheckpointState.messages
    : messages
  const attachmentIdsForFirstModelRequest = selectAttachmentIdsForModelRequest(messages, {
    currentAttachmentIds: recovery.managedAttachments.map((attachment) => attachment.id),
    prompt: content,
  })
  const toolContext = await executionToolContextRuntime.resolve({
    userId,
    content,
    modelMode: input.modelMode,
    toolsConfig: input.toolsConfig,
    intentMode: input.intentMode,
    approvalMode: input.approvalMode,
    resumeResolution: input.resumeContext?.resolution,
    restoredCheckpointState: recovery.restoredCheckpointState,
    fileAccessStatus: recovery.fileAccessStatus,
    promptContextSkillIds: promptContextSnapshot?.skillIds || promptContext.skillIds,
    fallbackSkillIds: skillIds,
    toolResolutionMessages,
    baseToolSpecs: deps.toolSpecs,
    directoryAuthorizationToolSpecs: deps.directoryAuthorizationToolSpecs,
  })
  return {
    promptContext, promptContextSnapshot, canaryAssignment,
    historyMessages, messages, attachmentIdsForFirstModelRequest, toolContext,
  }
}

function createTurnExecutionState(runtime, input, recovery, prepared) {
  const restored = recovery.restoredCheckpointState
  const state = {
    checkpointMessages: checkpointMessagesForTurn(restored, { content: input.content }),
    baselineToolCallIds: new Set(),
    checkpointArtifactIds: normalizeArtifactIds(restored?.artifactIds),
    checkpointDeliveryArtifactIds: optionalDeliveryArtifactIds(restored),
    checkpointIterations: Math.max(0, Number(restored?.iterations) || 0),
    checkpointRecovery: restored?.recovery || null,
    latestCheckpointSequence: Number.isInteger(recovery.checkpoint?.sequence)
      ? recovery.checkpoint.sequence
      : null,
    latestModelUsage: normalizeModelUsage(restored?.latestModelUsage),
    turnModelUsage: normalizeModelUsage(restored?.turnModelUsage)
      || normalizeModelUsage(restored?.latestModelUsage),
    latestEstimatedPromptTokens: normalizePromptTokenEstimate(restored?.latestEstimatedPromptTokens),
    streamedAssistantText: String(
      recovery.pendingRecoveryAttempt?.assistantText || restored?.retryAssistantText || '',
    ),
  }
  const recordCanaryTerminal = (
    terminalState,
    errorCode = null,
    completedAt = runtime.deps.now(),
    evaluationOutput = '',
  ) => runtime.canaryOutcomeRuntime({
    canaryAssignment: prepared.canaryAssignment,
    userId: input.userId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    effectiveTurnStartedAt: recovery.effectiveTurnStartedAt,
    turnModelUsage: state.turnModelUsage,
    latestModelUsage: state.latestModelUsage,
    modelProviderId: input.modelProviderId,
    modelName: input.modelName,
    modelConfigRevision: input.modelConfigRevision,
    evaluationInput: input.content,
    terminalState,
    errorCode,
    completedAt,
    evaluationOutput,
  })
  const readTerminalState = () => ({
    ...state,
    effectiveTurnStartedAt: recovery.effectiveTurnStartedAt,
    promptContextSnapshot: prepared.promptContextSnapshot,
    promptContext: prepared.promptContext,
    historyMessages: prepared.historyMessages,
    agentId: input.agentId,
    failedRetryActive: input.failedRetryActive,
    manualFailedRetryActive: input.manualFailedRetryActive,
  })
  return { state, recordCanaryTerminal, readTerminalState }
}

async function executePreparedTurn(runtime, input, recovery, prepared, signal) {
  const { deps, terminalOutcomeRuntime, runTurnLoopExecution } = runtime
  const execution = createTurnExecutionState(runtime, input, recovery, prepared)
  const evidence = createTurnTerminalEvidenceRuntime({
    scope: recovery.scope,
    emitter: input.emitter,
    executionLease: input.executionLease,
    now: deps.now,
    writeMessage: deps.writeMessage,
    writeRecoveryFailure: deps.writeRecoveryFailure,
    commitTurnBoundary: deps.commitTurnBoundary,
    recordCanaryTerminal: execution.recordCanaryTerminal,
    readState: execution.readTerminalState,
  })
  let contextWindow
  try {
    contextWindow = deps.getContextWindow({
      userId: input.modelRuntimeEnv ? null : input.userId,
      modelName: input.modelName || undefined,
      modelProviderId: input.modelRuntimeEnv ? undefined : (input.modelProviderId || undefined),
      env: input.modelRuntimeEnv || deps.env,
    })
  } catch (error) {
    logWarn('turn.context_window_discovery', error, recovery.scope)
  }
  try {
    const fileAccess = prepared.toolContext.modelToolFileAccessStatus ?? recovery.fileAccessStatus
    const runtimePlugins = deps.readRuntimePlugins()
    let runtimePluginStates
    try {
      runtimePluginStates = deps.readRuntimePluginStates({ verifyActiveReleases: true })
    } catch (error) {
      if (recovery.restoredCheckpointState
        && String(error?.code || '').trim() === 'PLUGIN_RELEASE_CORRUPT') {
        error.retryable = false
        error.unsafeToReplay = true
      }
      throw error
    }
    const environmentInput = {
      modelName: input.modelName,
      modelProviderId: input.modelProviderId,
      modelConfigRevision: input.modelConfigRevision,
      modelMode: prepared.toolContext.normalizedModelMode,
      policy: deps.readRuntimePolicyProvenance(),
      toolsConfig: prepared.toolContext.effectiveToolsConfig,
      toolSpecs: prepared.toolContext.resolvedToolSpecs,
      toolImplementations: deps.resolveToolImplementationRevisions({
        userId: input.userId,
        toolSpecs: prepared.toolContext.resolvedToolSpecs,
      }),
      fileAccess,
      runtimePlugins,
      runtimePluginStates,
    }
    const observed = createTurnExecutionEnvironmentSnapshot({
      ...environmentInput,
      approvalMode: prepared.toolContext.currentApprovalMode,
    })
    const effective = createTurnExecutionEnvironmentSnapshot({
      ...environmentInput,
      approvalMode: prepared.toolContext.effectiveApprovalMode,
    })
    if (recovery.restoredCheckpointState) {
      const options = { directoryAuthorization: input.resumeContext?.resolution }
      assertTurnExecutionEnvironmentCompatible(
        recovery.restoredCheckpointState.executionEnvironment,
        observed,
        options,
      )
      assertTurnExecutionEnvironmentCompatible(
        recovery.restoredCheckpointState.executionEnvironment,
        effective,
        options,
      )
    }
    const result = await runTurnLoopExecution({
      ...input,
      scope: recovery.scope,
      signal,
      contextWindow,
      attachmentIdsForFirstModelRequest: prepared.attachmentIdsForFirstModelRequest,
      pendingRecoveryAttempt: recovery.pendingRecoveryAttempt,
      promptContextSnapshot: prepared.promptContextSnapshot,
      promptContext: prepared.promptContext,
      previousUserPrompt: recovery.previousUserPrompt,
      managedAttachments: recovery.managedAttachments,
      messages: prepared.messages,
      steeringOwnerId: recovery.steeringOwnerId,
      steeringScope: recovery.steeringScope,
      restoredCheckpointState: recovery.restoredCheckpointState,
      effectiveExecutionEnvironment: effective,
      state: execution.state,
      ...prepared.toolContext,
    })
    await terminalOutcomeRuntime.settleResult({
      scope: recovery.scope,
      signal,
      result,
      state: execution.readTerminalState(),
      evidence,
      recordCanaryTerminal: execution.recordCanaryTerminal,
    })
  } catch (error) {
    await terminalOutcomeRuntime.settleError({
      scope: recovery.scope,
      signal,
      error,
      state: execution.readTerminalState(),
      evidence,
      recordCanaryTerminal: execution.recordCanaryTerminal,
    })
  }
}

export function createTurnExecutionRuntime({
  deps,
  executionToolContextRuntime,
  canaryOutcomeRuntime,
  terminalOutcomeRuntime,
}) {
  const runtime = {
    deps,
    executionToolContextRuntime,
    canaryOutcomeRuntime,
    terminalOutcomeRuntime,
    runTurnLoopExecution: createTurnLoopExecutionRuntime({ deps }),
  }
  return async function executeTurn(input, signal) {
    const scope = { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId }
    if (signal.aborted) {
      await terminalOutcomeRuntime.cancelBeforeExecution({
        scope,
        signal,
        emitter: input.emitter,
        executionLease: input.executionLease,
        turnStartedAt: input.turnStartedAt,
      })
      return
    }
    const recovery = await loadTurnExecutionRecovery(runtime, input)
    const prepared = await prepareTurnPromptAndTools(runtime, input, recovery)
    await executePreparedTurn(runtime, input, recovery, prepared, signal)
  }
}
