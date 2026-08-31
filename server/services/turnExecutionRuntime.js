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
import {
  normalizeArtifactIds,
  optionalDeliveryArtifactIds,
} from './turnTerminalProjection.js'
import { normalizePromptTokenEstimate } from './turnModelUsageProjection.js'
import { createTurnTerminalEvidenceRuntime } from './turnTerminalEvidenceRuntime.js'
import { createTurnLoopExecutionRuntime } from './turnLoopExecutionRuntime.js'
import {
  checkpointStateForResolution,
  isTemporaryTurnEvidence,
  normalizePromptContextSnapshot,
} from './turnEnginePolicy.js'

export function createTurnExecutionRuntime({
  deps,
  executionToolContextRuntime,
  canaryOutcomeRuntime,
  terminalOutcomeRuntime,
}) {
  const runTurnLoopExecution = createTurnLoopExecutionRuntime({ deps })

  return async function executeTurn({
    userId,
    sessionId,
    turnId,
    turnStartedAt,
    content,
    displayContent,
    modelName,
    modelProviderId,
    modelConfigRevision,
    modelRuntimeEnv,
    modelMode,
    agentId,
    skillIds,
    skillDefinitions,
    toolsConfig,
    intentMode,
    approvalMode,
    failedRetryActive = false,
    resumeContext,
    emitter,
    executionLease = null,
  }, signal) {
    const scope = { userId, sessionId, turnId }
    if (signal.aborted) {
      await terminalOutcomeRuntime.cancelBeforeExecution({
        scope,
        signal,
        emitter,
        executionLease,
        turnStartedAt,
      })
      return
    }
    const effectiveTurnStartedAt = Number.isFinite(Number(turnStartedAt))
      ? Math.max(0, Number(turnStartedAt))
      : deps.now()
    const storedCheckpoint = storedCheckpointEvent(
      await deps.runtimeCore.checkpoint.load(scope),
    )
    const checkpoint = storedCheckpoint || await latestLegacyCheckpoint(deps.replayEvents, scope)
    const resolvedCheckpointState = checkpointStateForResolution(checkpoint?.payload?.state, resumeContext)
    const restoredCheckpointState = failedRetryActive && resolvedCheckpointState?.final
      ? { ...resolvedCheckpointState, final: null }
      : resolvedCheckpointState
    const steeringOwnerId = String(deps.runtimeCore.lease.ownerId || '').trim() || null
    const steeringScope = { ...scope, ownerId: steeringOwnerId }
    if (steeringOwnerId) {
      const appliedSteeringIds = Array.isArray(checkpoint?.payload?.state?.appliedSteeringIds)
        ? checkpoint.payload.state.appliedSteeringIds
        : []
      await deps.acknowledgeAppliedSteering({
        ...steeringScope,
        steeringIds: appliedSteeringIds,
        now: deps.now(),
      })
      await deps.releaseStaleSteering({ ...steeringScope, now: deps.now() })
    }
    const pendingRecoveryAttempt = await recoveryAttemptAfterCheckpoint(
      deps.replayEvents,
      scope,
      checkpoint,
    )
    const storedMessages = (await deps.readMessages({
      userId,
      sessionId,
      limit: 500,
      recent: true,
    }))
      .filter((message) => !isTemporaryTurnEvidence(message, turnId))
      .filter((message) => !(
        message?.id === `${turnId}:assistant`
          && message?.modelContext?.paused === true
      ))
      .filter((message) => !(
        message?.modelContext?.liveSteering === true
          && message?.modelContext?.turnId === turnId
      ))
      .map((message) => message.id === `${turnId}:user`
        ? { ...message, content }
        : message)
    const currentUserMessage = storedMessages.find((message) => message.id === `${turnId}:user`)
    const previousUserPrompt = (await deps.readPreviousUserMessage({
      userId,
      sessionId,
      messageId: `${turnId}:user`,
    }))?.content || ''
    const managedAttachments = Array.isArray(currentUserMessage?.modelContext?.attachments)
      ? currentUserMessage.modelContext.attachments
      : []
    const restoredPromptContextSnapshot = normalizePromptContextSnapshot(
      restoredCheckpointState?.promptContextSnapshot,
    )
    let canaryAssignment = restoredPromptContextSnapshot?.canaryAssignment || null
    let promptContext = {
      messages: [],
      effectiveAgentId: restoredPromptContextSnapshot?.effectiveAgentId || agentId,
      skillIds: restoredPromptContextSnapshot?.skillIds || skillIds,
      memoryIds: restoredPromptContextSnapshot?.memoryIds || [],
      pluginPromptBlockIds: restoredPromptContextSnapshot?.pluginPromptBlockIds || [],
      compactionArchiveId: null,
      compactionBoundary: null,
      canaryAssignment,
    }
    if (!restoredPromptContextSnapshot) {
      try {
        canaryAssignment = await deps.resolveCanaryAssignment({
          userId,
          sessionId,
          turnId,
          env: deps.env,
          now: deps.now(),
        })
      } catch (error) {
        try { logWarn('evolution.canary.resolve', error, scope) } catch { /* optional */ }
      }
      try {
        promptContext = await deps.preparePromptContext({
          userId,
          agentId,
          skillIds,
          skillDefinitions,
          sessionId,
          recentMessages: storedMessages,
          includeRecentTranscript: false,
          query: content,
          canaryAssignment,
          env: deps.env,
        }) || promptContext
      } catch (error) {
        if (String(error?.code || '').trim() !== 'TURN_PROMPT_RUNTIME_NOT_CONFIGURED') {
          logWarn('turn.optional_prompt_context', error, scope)
        }
        canaryAssignment = null
      }
    }
    const promptContextSnapshot = restoredPromptContextSnapshot || normalizePromptContextSnapshot({
      effectiveAgentId: promptContext.effectiveAgentId || agentId,
      skillIds: promptContext.skillIds,
      memoryIds: promptContext.memoryIds,
      pluginPromptBlockIds: promptContext.pluginPromptBlockIds,
      canaryAssignment: canaryAssignment || promptContext.canaryAssignment,
    })
    const selectedStoredMessages = selectStoredMessagesAfterCompaction(
      storedMessages,
      promptContext.compactionBoundary,
    )
    const promptStoredMessages = currentUserMessage
      && !selectedStoredMessages.some((message) => message?.id === currentUserMessage.id)
      ? [...selectedStoredMessages, currentUserMessage]
      : selectedStoredMessages
    const historyMessages = expandStoredMessages(promptStoredMessages)
    const messages = [
      ...(Array.isArray(promptContext.messages) ? promptContext.messages : []),
      ...historyMessages,
    ]
    const toolResolutionMessages = Array.isArray(restoredCheckpointState?.messages)
      ? restoredCheckpointState.messages
      : messages
    const attachmentIdsForFirstModelRequest = selectAttachmentIdsForModelRequest(messages, {
      currentAttachmentIds: managedAttachments.map((attachment) => attachment.id),
      prompt: content,
    })
    const toolContext = await executionToolContextRuntime.resolve({
      userId,
      content,
      modelMode,
      toolsConfig,
      intentMode,
      approvalMode,
      resumeResolution: resumeContext?.resolution,
      restoredCheckpointState,
      promptContextSkillIds: promptContextSnapshot?.skillIds || promptContext.skillIds,
      fallbackSkillIds: skillIds,
      toolResolutionMessages,
      baseToolSpecs: deps.toolSpecs,
      directoryAuthorizationToolSpecs: deps.directoryAuthorizationToolSpecs,
    })
    const state = {
      checkpointMessages: checkpointMessagesForTurn(restoredCheckpointState, { content }),
      baselineToolCallIds: new Set(),
      checkpointArtifactIds: normalizeArtifactIds(restoredCheckpointState?.artifactIds),
      checkpointDeliveryArtifactIds: optionalDeliveryArtifactIds(restoredCheckpointState),
      checkpointIterations: Math.max(0, Number(restoredCheckpointState?.iterations) || 0),
      checkpointRecovery: restoredCheckpointState?.recovery || null,
      latestCheckpointSequence: Number.isInteger(checkpoint?.sequence) ? checkpoint.sequence : null,
      latestModelUsage: normalizeModelUsage(restoredCheckpointState?.latestModelUsage),
      turnModelUsage: normalizeModelUsage(restoredCheckpointState?.turnModelUsage)
        || normalizeModelUsage(restoredCheckpointState?.latestModelUsage),
      latestEstimatedPromptTokens: normalizePromptTokenEstimate(
        restoredCheckpointState?.latestEstimatedPromptTokens,
      ),
      streamedAssistantText: String(
        pendingRecoveryAttempt?.assistantText || restoredCheckpointState?.retryAssistantText || '',
      ),
    }
    const recordCanaryTerminal = (
      terminalState,
      errorCode = null,
      completedAt = deps.now(),
      evaluationOutput = '',
    ) => canaryOutcomeRuntime({
      canaryAssignment,
      userId,
      sessionId,
      turnId,
      effectiveTurnStartedAt,
      turnModelUsage: state.turnModelUsage,
      latestModelUsage: state.latestModelUsage,
      modelProviderId,
      modelName,
      modelConfigRevision,
      evaluationInput: content,
      terminalState,
      errorCode,
      completedAt,
      evaluationOutput,
    })
    const readTerminalState = () => ({
      ...state,
      effectiveTurnStartedAt,
      promptContextSnapshot,
      promptContext,
      historyMessages,
      agentId,
      failedRetryActive,
    })
    const terminalEvidenceRuntime = createTurnTerminalEvidenceRuntime({
      scope,
      emitter,
      executionLease,
      now: deps.now,
      writeMessage: deps.writeMessage,
      writeRecoveryFailure: deps.writeRecoveryFailure,
      commitTurnBoundary: deps.commitTurnBoundary,
      recordCanaryTerminal,
      readState: readTerminalState,
    })
    let contextWindow
    try {
      contextWindow = deps.getContextWindow({
        userId: modelRuntimeEnv ? null : userId,
        modelName: modelName || undefined,
        modelProviderId: modelRuntimeEnv ? undefined : (modelProviderId || undefined),
        env: modelRuntimeEnv || deps.env,
      })
    } catch (error) {
      logWarn('turn.context_window_discovery', error, scope)
    }
    try {
      const executionFileAccess = toolContext.modelToolFileAccessStatus
        ?? deps.readFileAccessStatus({ userId })
      const executionRuntimePlugins = deps.readRuntimePlugins()
      let executionRuntimePluginStates
      try {
        executionRuntimePluginStates = deps.readRuntimePluginStates({ verifyActiveReleases: true })
      } catch (error) {
        if (restoredCheckpointState
          && String(error?.code || '').trim() === 'PLUGIN_RELEASE_CORRUPT') {
          error.retryable = false
          error.unsafeToReplay = true
        }
        throw error
      }
      const toolImplementations = deps.resolveToolImplementationRevisions({
        userId,
        toolSpecs: toolContext.resolvedToolSpecs,
      })
      const runtimePolicyProvenance = deps.readRuntimePolicyProvenance()
      const environmentInput = {
        modelName,
        modelProviderId,
        modelConfigRevision,
        modelMode: toolContext.normalizedModelMode,
        policy: runtimePolicyProvenance,
        toolsConfig: toolContext.effectiveToolsConfig,
        toolSpecs: toolContext.resolvedToolSpecs,
        toolImplementations,
        fileAccess: executionFileAccess,
        runtimePlugins: executionRuntimePlugins,
        runtimePluginStates: executionRuntimePluginStates,
      }
      const observedExecutionEnvironment = createTurnExecutionEnvironmentSnapshot({
        ...environmentInput,
        approvalMode: toolContext.currentApprovalMode,
      })
      const effectiveExecutionEnvironment = createTurnExecutionEnvironmentSnapshot({
        ...environmentInput,
        approvalMode: toolContext.effectiveApprovalMode,
      })
      if (restoredCheckpointState) {
        const options = { directoryAuthorization: resumeContext?.resolution }
        assertTurnExecutionEnvironmentCompatible(
          restoredCheckpointState.executionEnvironment,
          observedExecutionEnvironment,
          options,
        )
        assertTurnExecutionEnvironmentCompatible(
          restoredCheckpointState.executionEnvironment,
          effectiveExecutionEnvironment,
          options,
        )
      }
      const result = await runTurnLoopExecution({
        scope,
        signal,
        content,
        displayContent,
        modelName,
        modelProviderId,
        modelConfigRevision,
        modelRuntimeEnv,
        contextWindow,
        attachmentIdsForFirstModelRequest,
        pendingRecoveryAttempt,
        skillDefinitions,
        promptContextSnapshot,
        promptContext,
        agentId,
        previousUserPrompt,
        managedAttachments,
        messages,
        steeringOwnerId,
        steeringScope,
        restoredCheckpointState,
        effectiveExecutionEnvironment,
        emitter,
        executionLease,
        state,
        ...toolContext,
      })
      await terminalOutcomeRuntime.settleResult({
        scope,
        signal,
        result,
        state: readTerminalState(),
        evidence: terminalEvidenceRuntime,
        recordCanaryTerminal,
      })
    } catch (error) {
      await terminalOutcomeRuntime.settleError({
        scope,
        signal,
        error,
        state: readTerminalState(),
        evidence: terminalEvidenceRuntime,
        recordCanaryTerminal,
      })
    }
  }
}
