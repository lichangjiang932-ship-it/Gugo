import { normalizeModelUsage } from '../../shared/modelUsage.js'
import {
  checkpointMessagesForTurn,
} from './turnRecoveryProjection.js'
import {
  normalizeArtifactIds,
  optionalDeliveryArtifactIds,
  sameArtifactIds,
} from './turnTerminalProjection.js'
import {
  addTurnModelUsage,
  normalizePromptTokenEstimate,
} from './turnModelUsageProjection.js'
import { createChatOnlyToolExecutionError } from './turnModelRequestRuntime.js'
import { TurnEngineError } from './turnResolutionRuntime.js'
import { normalizeTurnOptionalId } from './turnStartRuntime.js'
import { abortError, normalizePositiveInteger } from './turnEnginePolicy.js'

const ATOMIC_CHECKPOINT_UNSUPPORTED_CODE = 'TURN_ATOMIC_CHECKPOINT_UNSUPPORTED'
const ATOMIC_CHECKPOINT_COMMIT_MISMATCH_CODE = 'TURN_ATOMIC_CHECKPOINT_COMMIT_MISMATCH'

function createModelRequestReconciler({
  deps,
  scope,
  modelName,
  modelProviderId,
  modelConfigRevision,
  modelRuntimeEnv,
}) {
  return async (invocation) => {
    const manualResolution = typeof deps.readModelRequestResolution === 'function'
      ? await deps.readModelRequestResolution({ ...scope, invocation })
      : null
    if (manualResolution) return manualResolution
    if (typeof deps.reconcileModelRequest !== 'function') return null
    return deps.reconcileModelRequest({
      invocation,
      modelName,
      modelProviderId,
      modelConfigRevision,
      env: modelRuntimeEnv || deps.env,
    })
  }
}

function createCheckpointWriter({
  deps,
  scope,
  content,
  effectiveApprovalMode,
  normalizedModelMode,
  effectiveExecutionEnvironment,
  promptContextSnapshot,
  emitter,
  executionLease,
  state,
}) {
  return async (checkpoint) => {
    if (!deps.supportsAtomicCheckpointState) {
      const error = new TurnEngineError(
        ATOMIC_CHECKPOINT_UNSUPPORTED_CODE,
        'The configured turn event adapter does not support atomic checkpoint state commits.',
        503,
      )
      error.retryable = false
      error.unsafeToReplay = true
      throw error
    }
    state.checkpointMessages = checkpointMessagesForTurn(checkpoint, {
      content,
      fallback: state.checkpointMessages,
    })
    const checkpointState = {
      ...checkpoint,
      approvalMode: effectiveApprovalMode,
      modelMode: normalizedModelMode,
      executionEnvironment: effectiveExecutionEnvironment,
      promptContextSnapshot,
      turnMessages: state.checkpointMessages,
      ...(state.latestModelUsage ? { latestModelUsage: state.latestModelUsage } : {}),
      ...(state.turnModelUsage ? { turnModelUsage: state.turnModelUsage } : {}),
      ...(state.latestEstimatedPromptTokens !== null
        ? { latestEstimatedPromptTokens: state.latestEstimatedPromptTokens }
        : {}),
    }
    const nextCheckpointArtifactIds = normalizeArtifactIds(
      checkpointState?.artifactIds ?? state.checkpointArtifactIds,
    )
    const artifactCollectionChanged = !sameArtifactIds(
      state.checkpointArtifactIds,
      nextCheckpointArtifactIds,
    )
    state.checkpointArtifactIds = nextCheckpointArtifactIds
    state.checkpointDeliveryArtifactIds = optionalDeliveryArtifactIds(
      checkpointState,
      artifactCollectionChanged ? [] : state.checkpointDeliveryArtifactIds,
    )
    state.checkpointIterations = Math.max(
      0,
      Number(checkpointState?.iterations) || state.checkpointIterations,
    )
    state.checkpointRecovery = checkpointState?.recovery || state.checkpointRecovery
    const checkpointEvent = await emitter('turn.checkpoint', {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: state.checkpointIterations,
      toolCallCount: Array.isArray(checkpointState?.toolCalls) ? checkpointState.toolCalls.length : 0,
    }, {
      checkpointState,
      commitEvent: typeof deps.commitTurnCheckpoint === 'function'
        ? ({ event, checkpointState: durableState }) => deps.commitTurnCheckpoint({
            userId: scope.userId,
            event,
            checkpointState: durableState,
            executionLease,
          })
        : null,
    })
    const saved = await deps.runtimeCore.checkpoint.load(scope)
    if (saved?.eventSequence !== checkpointEvent.sequence) {
      const error = new TurnEngineError(
        ATOMIC_CHECKPOINT_COMMIT_MISMATCH_CODE,
        'The turn event adapter acknowledged a checkpoint event without atomically committing its state.',
        503,
      )
      error.retryable = false
      error.unsafeToReplay = true
      error.eventSequence = checkpointEvent.sequence
      throw error
    }
    if (!saved?.state) {
      const error = new TurnEngineError(
        'TURN_CHECKPOINT_PERSISTENCE_FAILED',
        'Failed to persist turn checkpoint',
        503,
      )
      error.retryable = true
      throw error
    }
    state.latestCheckpointSequence = checkpointEvent.sequence
    return true
  }
}

function toolFailure(result) {
  if (result?.ok !== false) return null
  return {
    code: String(result.code || 'tool_execution_failed'),
    message: String(result.error || 'Tool execution failed.'),
    retryable: result.retryable === true,
    ...(Number.isInteger(result.status) ? { status: result.status } : {}),
    ...(result.hint ? { hint: String(result.hint) } : {}),
    ...(Number.isInteger(result.attempts) ? { attempts: result.attempts } : {}),
  }
}

export function createTurnLoopExecutionRuntime({ deps }) {
  return async function runTurnLoopExecution({
    scope,
    signal,
    content,
    displayContent,
    locale,
    modelName,
    modelProviderId,
    modelConfigRevision,
    modelRuntimeEnv,
    normalizedModelMode,
    contextWindow,
    attachmentIdsForFirstModelRequest,
    pendingRecoveryAttempt,
    effectiveIntentMode,
    resolvedToolSpecs,
    effectiveToolsConfig,
    toolResolutionDecision,
    activeSkillId,
    effectiveSkillIds,
    skillDefinitions,
    promptContextSnapshot,
    promptContext,
    agentId,
    previousUserPrompt,
    managedAttachments,
    messages,
    chatOnlyMode,
    effectiveApprovalMode,
    steeringOwnerId,
    steeringScope,
    restoredCheckpointState,
    effectiveExecutionEnvironment,
    emitter,
    executionLease,
    state,
  }) {
    const { userId, sessionId, turnId } = scope
    const runTurnModelRequest = deps.modelRequestRunnerFactory({
      runModel: deps.runModel,
      prepareAttachments: deps.prepareAttachments,
      publishActivity: deps.publishActivity,
      emitEvent: emitter,
      userId,
      sessionId,
      turnId,
      modelName,
      modelProviderId,
      modelRuntimeEnv,
      modelMode: normalizedModelMode,
      env: deps.env,
      contextWindow,
      firstRequestAttachmentIds: attachmentIdsForFirstModelRequest,
      pendingRecoveryAttempt,
      onRecoveryAttempt: (attempt) => {
        state.streamedAssistantText = String(attempt?.assistantText || '')
      },
      onPromptTokenEstimate: (value) => {
        state.latestEstimatedPromptTokens = normalizePromptTokenEstimate(value)
      },
      now: deps.now,
    })
    if (typeof runTurnModelRequest !== 'function') {
      throw new TypeError('modelRequestRunnerFactory must return a runModel function')
    }
    const reconcileModelRequest = createModelRequestReconciler({
      deps,
      scope,
      modelName,
      modelProviderId,
      modelConfigRevision,
      modelRuntimeEnv,
    })
    const saveCheckpoint = createCheckpointWriter({
      deps,
      scope,
      content,
      effectiveApprovalMode,
      normalizedModelMode,
      effectiveExecutionEnvironment,
      promptContextSnapshot,
      emitter,
      executionLease,
      state,
    })
    return deps.runLoop({
      job: {
        id: turnId,
        userId,
        sessionId,
        modelName: String(modelName || '').trim() || null,
        modelProviderId: normalizeTurnOptionalId(modelProviderId),
        modelConfigRevision: normalizePositiveInteger(modelConfigRevision),
        modelMode: normalizedModelMode,
        agentId: promptContextSnapshot?.effectiveAgentId
          || promptContext.effectiveAgentId
          || agentId
          || null,
        skillIds: effectiveSkillIds,
        skillDefinitions,
        origin: 'chat',
        locale,
        prompt: content,
        userPrompt: displayContent || content,
        previousUserPrompt,
        title: content.slice(0, 120),
        managedAttachments,
        hasManagedAttachments: managedAttachments.length > 0,
      },
      step: { id: turnId, kind: 'chat' },
      messages,
      contextWindow,
      intentMode: effectiveIntentMode,
      signal,
      toolSpecs: resolvedToolSpecs,
      toolsConfig: effectiveToolsConfig,
      fallbackToolSpecs: resolvedToolSpecs,
      toolResolutionDecision,
      skillId: activeSkillId,
      executeTool: chatOnlyMode
        ? async () => { throw createChatOnlyToolExecutionError() }
        : deps.executeTool,
      approvalOrigin: 'chat',
      approvalSessionId: sessionId,
      approvalMode: effectiveApprovalMode,
      claimSteering: steeringOwnerId
        ? async () => deps.claimSteering({ ...steeringScope, now: deps.now() })
        : null,
      acknowledgeSteering: steeringOwnerId
        ? async (leaseId) => deps.acknowledgeSteering({
            ...steeringScope,
            leaseId,
            now: deps.now(),
          })
        : null,
      releaseSteering: steeringOwnerId
        ? async (leaseId) => deps.releaseSteering({
            ...steeringScope,
            leaseId,
            now: deps.now(),
          })
        : null,
      beforeFinalCompletion: steeringOwnerId
        ? async () => {
            const decision = await deps.runtimeCore.lease.closeSteeringInbox(scope)
            if (!decision?.closed && decision?.reason !== 'pending') {
              throw abortError('TURN_LEASE_LOST', 'Turn execution lease was lost before completion')
            }
            return decision
          }
        : null,
      loadCheckpoint: async () => restoredCheckpointState || null,
      reconcileModelRequest,
      saveCheckpoint,
      runModel: runTurnModelRequest,
      onModelPhase: async ({ phase, iteration, usage, modelName: activeModel, error }) => {
        const normalizedUsage = phase === 'completed' ? normalizeModelUsage(usage) : null
        if (normalizedUsage) {
          state.latestModelUsage = normalizedUsage
          state.turnModelUsage = addTurnModelUsage(state.turnModelUsage, normalizedUsage)
        }
        await emitter('model.phase', {
          phase,
          iteration,
          usage: normalizedUsage || usage,
          modelName: activeModel,
          error,
        })
      },
      onModelDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
        state.streamedAssistantText += String(delta || '')
        await emitter('assistant.delta', { text: delta, iteration, modelName: activeModel })
      },
      onReasoningDelta: async ({ text: delta, iteration, modelName: activeModel }) => {
        await emitter('reasoning.delta', { text: delta, iteration, modelName: activeModel })
      },
      onProgress: async ({
        completed,
        total,
        iteration,
        filesChanged,
        additions,
        deletions,
        phase,
      } = {}) => {
        await emitter('turn.progress', {
          ...(completed !== undefined ? { completed } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(iteration !== undefined ? { iteration } : {}),
          ...(filesChanged !== undefined ? { filesChanged } : {}),
          ...(additions !== undefined ? { additions } : {}),
          ...(deletions !== undefined ? { deletions } : {}),
          ...(phase !== undefined ? { phase } : {}),
        })
      },
      onToolCall: async (call) => emitter('tool.call', {
        toolCallId: call.id,
        name: call.name,
        args: call.args,
      }),
      onToolStarted: async (call) => emitter('tool.started', {
        toolCallId: call.id,
        name: call.name,
        args: call.args,
        outputReplay: 'live_only',
      }),
      onToolCompleted: async (outcome) => emitter('tool.completed', {
        toolCallId: outcome.call.id,
        name: outcome.call.name,
        args: outcome.executionArgs ?? outcome.call.args,
        result: outcome.result,
        error: toolFailure(outcome.result),
        artifactId: outcome.artifactId || null,
        artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts : [],
      }),
      onApprovalPending: async (approval) => emitter('approval.required', {
        approvalId: approval.id,
        toolName: approval.toolName,
        args: approval.args,
        risk: approval.risk,
        metadataSource: approval.metadataSource,
        reason: approval.reason,
        expiresAt: approval.expiresAt,
      }),
      onApprovalResolved: async (decision) => emitter('approval.resolved', {
        approvalId: decision.approvalId || null,
        proceed: !!decision.proceed,
        edited: !!decision.edited,
        args: decision.args ?? null,
        reason: decision.reason || null,
      }),
    })
  }
}
