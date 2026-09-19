import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'
import { normalizeModelUsage } from '../../../shared/modelUsage.js'
import { modelContextDiagnosticsSchema } from '../../../shared/modelContextDiagnostics.js'
import { modelWireDiagnosticsSchema } from '../../../shared/modelWireDiagnostics.js'
import { projectTurnEventForClient } from '../../../shared/turnEventProjection.js'
import { createToolOutputBuffer } from './toolOutputBuffer.js'
import { modelActivityFromPhase } from './modelActivityProgress.js'
import {
  CLEARED_SERVER_FAILURE_META,
  CLEARED_SERVER_RECOVERY_META,
  CLEARED_TERMINAL_STATE_META,
  MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
  SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
  createTurnFailureError,
  isModelRequestOutcomeUnknownRecoveryKind,
  isSideEffectOutcomeUnknownRecoveryKind,
  normalizeTurnFailurePayload,
  optionalArtifactIds,
  optionalInteger,
  optionalRetainedLocalFiles,
  optionalVerifiedLocalFiles,
  resultText,
} from './turnFailurePayload.js'

export {
  MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
  SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
  createTurnFailureError,
  isModelRequestOutcomeUnknownRecoveryKind,
  isSideEffectOutcomeUnknownRecoveryKind,
  normalizeTurnFailurePayload,
}

const TOOL_OUTPUT_FLUSH_EVENT_TYPES = new Set([
  'tool.completed',
  'turn.interrupted',
  'turn.blocked',
  'turn.completed',
  'turn.paused',
  'turn.cancelled',
  'turn.failed',
])

const TERMINAL_TOOL_CALL_STATUS = new Map([
  ['turn.completed', TOOL_CALL_STATUS.CANCELLED],
  ['turn.paused', TOOL_CALL_STATUS.CANCELLED],
  ['turn.cancelled', TOOL_CALL_STATUS.CANCELLED],
  ['turn.interrupted', TOOL_CALL_STATUS.CANCELLED],
  ['turn.blocked', TOOL_CALL_STATUS.CANCELLED],
  ['turn.failed', TOOL_CALL_STATUS.ERROR],
])

const CLEARED_MODEL_DIAGNOSTICS = Object.freeze({
  modelContextDiagnostics: null, modelWireDiagnostics: null,
  modelRequestId: null, modelPhysicalAttempt: null, modelUsage: null,
})

function preparedModelDiagnostics(payload) {
  const context = payload.phase === 'context_prepared'
  const parsed = (context ? modelContextDiagnosticsSchema : modelWireDiagnosticsSchema)
    .safeParse(context ? payload.contextDiagnostics : payload.wireDiagnostics)
  return {
    ...(context ? CLEARED_MODEL_DIAGNOSTICS : { modelUsage: null }),
    [context ? 'modelContextDiagnostics' : 'modelWireDiagnostics']: parsed.success ? parsed.data : null,
    modelRequestId: typeof payload.modelRequestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(payload.modelRequestId)
      ? payload.modelRequestId : null,
    modelPhysicalAttempt: Number.isSafeInteger(payload.physicalAttempt) && payload.physicalAttempt > 0 ? payload.physicalAttempt : null,
  }
}

function dispatchToolOutput(activity, { dispatch, messageTarget } = {}) {
  if (!activity?.toolCallId || typeof activity.chunk !== 'string' || !activity.chunk) return false
  dispatch?.({
    type: 'APPEND_TOOL_CALL_OUTPUT',
    payload: {
      id: activity.toolCallId,
      name: activity.toolName,
      chunk: activity.chunk,
      stream: activity.stream || 'stdout',
    },
    transientTurnActivity: true,
    serverTurnId: activity.turnId || undefined,
    ...(messageTarget || {}),
  })
  return true
}

export function dispatchTurnActivity(activity, { dispatch, taskId, messageTarget } = {}) {
  if (activity?.kind === 'tool_output_delta') return dispatchToolOutput(activity, { dispatch, messageTarget })
  if (activity?.kind !== 'tool_call_ready') return false
  dispatch?.({
    type: 'UPDATE_TASK',
    payload: {
      id: taskId,
      updates: { stepLabel: `Tool call ready: ${activity.toolName || 'tool'}` },
    },
  })
  dispatch?.({
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: {
      modelActivity: {
        kind: 'tool_call_ready',
        toolName: activity.toolName,
      },
    },
    transientTurnActivity: true,
    serverTurnId: activity.turnId || undefined,
    ...(messageTarget || {}),
  })
  return true
}

export function createBufferedTurnActivityDispatcher(options = {}) {
  const { bufferOptions = {}, ...dispatchOptions } = options
  const outputBuffer = createToolOutputBuffer({
    ...bufferOptions,
    onFlush: ({ id, name, chunk, stream, turnId }) => dispatchToolOutput({
      toolCallId: id,
      toolName: name,
      chunk,
      stream,
      turnId,
    }, dispatchOptions),
  })

  return {
    onActivity: (activity) => activity?.kind === 'tool_output_delta'
      ? outputBuffer.append({
          id: activity.toolCallId,
          name: activity.toolName,
          chunk: activity.chunk,
          stream: activity.stream,
          turnId: activity.turnId,
        })
      : dispatchTurnActivity(activity, dispatchOptions),
    flush: outputBuffer.flush,
    dispose: outputBuffer.dispose,
  }
}

export async function dispatchTurnEvent(sourceEvent, {
  dispatch,
  taskId,
  onApproval,
  onArtifact,
  messageTarget,
  flushToolOutput,
} = {}) {
  const event = projectTurnEventForClient(sourceEvent)
  const payload = event.payload || {}
  if (TOOL_OUTPUT_FLUSH_EVENT_TYPES.has(event.type)) await flushToolOutput?.()
  const dispatchMessage = (action) => dispatch?.({ ...action, ...(messageTarget || {}) })
  const streamCursor = { serverTurnId: event.turnId, serverSequence: event.sequence }
  const terminalToolStatus = TERMINAL_TOOL_CALL_STATUS.get(event.type)
  const terminalToolFinalizer = terminalToolStatus ? {
    status: terminalToolStatus,
    ...(terminalToolStatus === TOOL_CALL_STATUS.ERROR
      ? {
          error: String(payload.message || payload.reason || 'Turn failed before the tool returned a result'),
          errorCode: String(payload.code || payload.error?.code || 'TURN_FAILED'),
        }
      : {}),
  } : null
  let cursorCommitted = false
  if (event.type === 'turn.started') {
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: { modelActivity: { kind: 'preparing' }, turnStartedAt: event.createdAt },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.attempt' && payload.resetStreaming) {
    dispatchMessage({
      type: 'RESET_LAST_MESSAGE_STREAM',
      payload: {
        attempt: payload.attempt,
        content: payload.assistantText || '',
        reasoning: payload.reasoningText || '',
      },
      meta: {
        ...CLEARED_SERVER_RECOVERY_META,
        ...CLEARED_SERVER_FAILURE_META,
        ...CLEARED_TERMINAL_STATE_META,
        ...CLEARED_MODEL_DIAGNOSTICS,
        streaming: true,
        turnCompletedAt: null,
        latency: null,
        serverPartialText: '',
        publicTimeline: null,
        serverArtifactIds: [],
        modelActivity: null,
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.resumed') {
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        ...CLEARED_SERVER_RECOVERY_META,
        ...CLEARED_SERVER_FAILURE_META,
        ...CLEARED_TERMINAL_STATE_META,
        streaming: true,
        turnCompletedAt: null,
        latency: null,
        serverConnectionState: 'connected',
        modelActivity: { kind: 'preparing' },
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'model.phase') {
    if (payload.phase === 'context_prepared' || payload.phase === 'wire_prepared') {
      dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: preparedModelDiagnostics(payload), ...streamCursor })
      return { cursorCommitted: true }
    }
    const labels = {
      started: 'Calling model',
      waiting_first_token: 'Waiting for model output',
      streaming: 'Receiving model output',
      tool_arguments: 'Receiving tool arguments; the tool has not run yet',
      idle: 'Waiting for the model to continue',
      retrying: 'Retrying model call',
      compacting: 'Compacting conversation context',
      compaction_fallback: 'Using a mechanical context summary',
      failed: 'Model call failed',
      completed: 'Model response completed',
    }
    const label = labels[payload.phase] || 'Model task is running'
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: label } } })
    const modelUsage = payload.phase === 'completed'
      ? normalizeModelUsage(payload.usage)
      : null
    if (payload.phase === 'streaming' || payload.phase === 'tool_arguments') {
      dispatchMessage({
        type: 'UPDATE_LAST_MESSAGE_META',
        payload: { progress: null, modelActivity: modelActivityFromPhase(payload, event.createdAt) },
        ...streamCursor,
      })
      cursorCommitted = true
    } else if (['started', 'waiting_first_token', 'idle', 'retrying', 'compacting', 'compaction_fallback'].includes(payload.phase)) {
      dispatchMessage({
        type: 'UPDATE_LAST_MESSAGE_META',
        payload: { progress: null, modelActivity: modelActivityFromPhase(payload, event.createdAt) },
        ...streamCursor,
      })
      cursorCommitted = true
    } else if (payload.phase === 'completed' || payload.phase === 'failed') {
      dispatchMessage({
        type: 'UPDATE_LAST_MESSAGE_META',
        payload: {
          modelActivity: null,
          ...(modelUsage ? {
            modelUsage,
            actualPromptTokens: modelUsage.promptTokens,
          } : {}),
        },
        ...streamCursor,
      })
      cursorCommitted = true
    }
  } else if (event.type === 'model.failover') {
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        modelFallback: {
          kind: payload.kind || 'failover',
          from: payload.from || null,
          to: payload.to || null,
          modelName: payload.modelName || null,
          attempt: Number.isInteger(payload.attempt) ? payload.attempt : null,
        },
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'assistant.delta') {
    dispatchMessage({
      type: 'APPEND_TO_LAST_MESSAGE',
      payload: payload.text || '',
      meta: { progress: null, modelActivity: { kind: 'responding' } },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'reasoning.delta') {
    dispatchMessage({
      type: 'APPEND_REASONING_TO_LAST_MESSAGE',
      payload: payload.text || '',
      meta: { progress: null, modelActivity: { kind: 'reasoning', phase: 'streaming', iteration: payload.iteration } },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.progress') {
    dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { progress: payload }, ...streamCursor })
    cursorCommitted = true
  } else if (event.type === 'tool.call' || event.type === 'tool.started') {
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        ...(payload.args !== undefined ? { arguments: JSON.stringify(payload.args) } : {}),
        ...(payload.outputReplay ? { outputReplay: payload.outputReplay } : {}),
        ...(event.type === 'tool.started' ? { startedAt: event.createdAt } : {}),
        status: TOOL_CALL_STATUS.RUNNING,
      },
      meta: { modelActivity: null },
      ...streamCursor,
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `Calling ${payload.name || 'tool'}` } } })
    cursorCommitted = true
  } else if (event.type === 'tool.completed') {
    const failed = payload.result?.ok === false
    const failure = payload.error || (failed ? {
      code: payload.result?.code || 'tool_execution_failed',
      message: payload.result?.error || 'Tool call failed',
      status: payload.result?.status ?? payload.result?.statusCode,
      retryable: payload.result?.retryable === true,
      hint: payload.result?.hint,
      attempts: payload.result?.attempts,
    } : null)
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        ...(payload.args ? { arguments: JSON.stringify(payload.args) } : {}),
        status: failed ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS,
        result: resultText(payload.result),
        error: failed ? failure?.message || 'Tool call failed' : undefined,
        errorCode: failed ? failure?.code : undefined,
        errorStatus: failed ? failure?.status : undefined,
        retryable: failed ? failure?.retryable === true : undefined,
        errorHint: failed ? failure?.hint : undefined,
        attempts: failed ? failure?.attempts : undefined,
        approvalAuthorization: payload.result?.approvalAuthorization || null,
      },
      meta: { modelActivity: { kind: 'reviewing' } },
      ...streamCursor,
    })
    const completedArtifacts = Array.isArray(payload.artifacts) && payload.artifacts.length > 0
      ? payload.artifacts
      : Array.isArray(payload.result?.artifacts) && payload.result.artifacts.length > 0
        ? payload.result.artifacts
        : payload.artifactId || payload.result?.artifactId
          ? [{
              id: payload.artifactId || payload.result.artifactId,
              filename: payload.result?.filename || '',
              url: payload.result?.url || '',
              ...(payload.result?.previewRevision ? { previewRevision: payload.result.previewRevision } : {}),
            }]
          : []
    for (const artifact of completedArtifacts) {
      onArtifact?.({ ...artifact, name: payload.name, toolCallId: payload.toolCallId })
    }
    cursorCommitted = true
  } else if (event.type === 'approval.required') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Waiting for approval' } } })
    await onApproval?.({
      id: payload.approvalId,
      name: payload.toolName,
      args: payload.args || {},
      risk: payload.risk,
      metadataSource: payload.metadataSource === 'declared' ? 'declared' : 'fallback',
      reason: payload.reason,
    })
  } else if (event.type === 'approval.resolved') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Approval resolved, continuing' } } })
  } else if (event.type === 'turn.paused') {
    const partialText = Object.hasOwn(payload, 'partialText')
      ? String(payload.partialText ?? '')
      : Object.hasOwn(payload, 'text') ? String(payload.text ?? '') : undefined
    const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
    const verifiedLocalFiles = optionalVerifiedLocalFiles(payload)
    const retainedLocalFiles = optionalRetainedLocalFiles(payload)
    const artifactIds = optionalArtifactIds(payload, 'artifactIds')
    const modelUsage = normalizeModelUsage(payload.usage)
    const turnModelUsage = normalizeModelUsage(payload.turnModelUsage)
    const estimatedPromptTokens = optionalInteger(payload.estimatedPromptTokens, 0)
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        ...CLEARED_SERVER_RECOVERY_META,
        ...CLEARED_SERVER_FAILURE_META,
        ...CLEARED_TERMINAL_STATE_META,
        streaming: false,
        turnCompletedAt: event.createdAt,
        modelActivity: null,
        progress: null,
        paused: true,
        serverConnectionState: 'paused',
        serverClarification: payload.clarification || null,
        directoryAuthorizationPending: false,
        serverResumeResolution: null,
        ...(artifactIds?.length > 0 ? { serverArtifactIds: artifactIds } : {}),
        ...(partialText ? { serverPartialText: partialText } : {}),
        finalizeRunningToolCalls: terminalToolFinalizer,
        ...(modelUsage ? { modelUsage, actualPromptTokens: modelUsage.promptTokens } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(estimatedPromptTokens !== undefined ? { serverEstimatedPromptTokens: estimatedPromptTokens } : {}),
        ...(deliveryArtifactIds?.length > 0 ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
        ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
        ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
      },
      ...streamCursor,
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: payload.clarification?.question || 'Waiting for user input' } } })
    cursorCommitted = true
  } else if (event.type === 'turn.completed') {
    const artifactIds = optionalArtifactIds(payload, 'artifactIds')
    const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
    const verifiedLocalFiles = optionalVerifiedLocalFiles(payload)
    const retainedLocalFiles = optionalRetainedLocalFiles(payload)
    const modelUsage = normalizeModelUsage(payload.usage)
    const turnModelUsage = normalizeModelUsage(payload.turnModelUsage)
    const estimatedPromptTokens = optionalInteger(payload.estimatedPromptTokens, 0)
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        ...CLEARED_SERVER_RECOVERY_META,
        ...CLEARED_SERVER_FAILURE_META,
        streaming: false,
        turnCompletedAt: event.createdAt,
        modelActivity: null,
        progress: null,
        serverConnectionState: null,
        failed: false,
        interrupted: false,
        paused: false,
        cancelled: false,
        ...(artifactIds !== undefined ? { serverArtifactIds: artifactIds } : {}),
        finalizeRunningToolCalls: terminalToolFinalizer,
        ...(deliveryArtifactIds !== undefined ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
        ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
        ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
        ...(modelUsage ? {
          modelUsage,
          actualPromptTokens: modelUsage.promptTokens,
        } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(estimatedPromptTokens !== undefined ? { serverEstimatedPromptTokens: estimatedPromptTokens } : {}),
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.cancelled') {
    const failure = normalizeTurnFailurePayload(payload, { fallbackCode: 'TURN_CANCELLED' })
    const partialText = Object.hasOwn(payload, 'partialText')
      ? String(payload.partialText ?? '')
      : Object.hasOwn(payload, 'text') ? String(payload.text ?? '') : undefined
    const verifiedLocalFiles = optionalVerifiedLocalFiles(payload)
    const retainedLocalFiles = optionalRetainedLocalFiles(payload)
    const artifactIds = optionalArtifactIds(payload, 'artifactIds')
    const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
    const modelUsage = normalizeModelUsage(payload.usage)
    const turnModelUsage = normalizeModelUsage(payload.turnModelUsage)
    const estimatedPromptTokens = optionalInteger(payload.estimatedPromptTokens, 0)
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        ...CLEARED_SERVER_RECOVERY_META,
        ...CLEARED_SERVER_FAILURE_META,
        serverFailure: failure.error,
        streaming: false,
        turnCompletedAt: event.createdAt,
        modelActivity: null,
        progress: null,
        cancelled: true,
        failed: false,
        interrupted: false,
        paused: false,
        serverConnectionState: 'cancelled',
        serverClarification: null,
        serverResumeResolution: null,
        directoryAuthorizationPending: false,
        directoryAuthorizationError: null,
        ...(artifactIds?.length > 0 ? { serverArtifactIds: artifactIds } : {}),
        serverDeliveryArtifactIds: deliveryArtifactIds || [],
        ...(partialText ? { serverPartialText: partialText } : {}),
        finalizeRunningToolCalls: terminalToolFinalizer,
        ...(modelUsage ? { modelUsage, actualPromptTokens: modelUsage.promptTokens } : {}),
        ...(turnModelUsage ? { turnModelUsage } : {}),
        ...(estimatedPromptTokens !== undefined ? { serverEstimatedPromptTokens: estimatedPromptTokens } : {}),
        ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
        ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.interrupted'
    || event.type === 'turn.blocked'
    || event.type === 'turn.failed') {
    const blocked = event.type === 'turn.blocked'
    const sideEffectUnknown = blocked && isSideEffectOutcomeUnknownRecoveryKind(payload.recoveryKind)
    const modelRequestUnknown = blocked && isModelRequestOutcomeUnknownRecoveryKind(payload.recoveryKind)
    const failure = normalizeTurnFailurePayload(payload, {
      fallbackCode: event.type === 'turn.interrupted'
        ? 'TURN_INTERRUPTED'
        : blocked ? 'TURN_RECOVERY_BLOCKED' : 'TURN_FAILED',
    })
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        ...CLEARED_SERVER_RECOVERY_META,
        serverFailure: failure.error,
        cancelled: false,
        streaming: event.type === 'turn.interrupted',
        turnCompletedAt: event.type === 'turn.interrupted' || blocked ? null : event.createdAt,
        ...(event.type === 'turn.interrupted' || blocked ? { latency: null } : {}),
        modelActivity: null,
        progress: null,
        ...(event.type === 'turn.failed' ? { serverConnectionState: null } : {}),
        ...(failure.partialText ? { serverPartialText: failure.partialText } : {}),
        ...(failure.artifactIds?.length > 0 ? { serverArtifactIds: failure.artifactIds } : {}),
        ...(failure.deliveryArtifactIds?.length > 0
          ? { serverDeliveryArtifactIds: failure.deliveryArtifactIds }
          : {}),
        ...(failure.verifiedLocalFiles !== undefined
          ? { verifiedLocalFiles: failure.verifiedLocalFiles }
          : {}),
        ...(failure.retainedLocalFiles !== undefined
          ? { retainedLocalFiles: failure.retainedLocalFiles }
          : {}),
        ...(failure.iterations !== undefined ? { serverIterations: failure.iterations } : {}),
        finalizeRunningToolCalls: terminalToolFinalizer,
        ...(failure.modelUsage ? {
          modelUsage: failure.modelUsage,
          actualPromptTokens: failure.modelUsage.promptTokens,
        } : {}),
        ...(failure.turnModelUsage ? { turnModelUsage: failure.turnModelUsage } : {}),
        ...(failure.estimatedPromptTokens !== undefined
          ? { serverEstimatedPromptTokens: failure.estimatedPromptTokens }
          : {}),
        interrupted: event.type === 'turn.interrupted',
        ...(event.type === 'turn.interrupted'
          ? { failed: false, paused: false, serverConnectionState: 'interrupted' }
          : blocked
            ? {
                failed: false,
                paused: false,
                streaming: false,
                serverConnectionState: 'blocked',
                serverRecoveryBlocked: true,
                ...(sideEffectUnknown ? {
                  serverRecoveryKind: SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
                  serverRecoveryToolCallId: typeof payload.toolCallId === 'string' ? payload.toolCallId : null,
                  serverRecoveryActionPath: null,
                } : {}),
                ...(modelRequestUnknown ? {
                  serverRecoveryKind: MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
                  serverRecoveryModelRequestId: typeof payload.modelRequestId === 'string'
                    ? payload.modelRequestId
                    : null,
                  serverRecoveryActionPath: payload.recoveryAction?.path === '/settings?tab=recovery'
                    ? payload.recoveryAction.path
                    : '/settings?tab=recovery',
                } : {}),
              }
            : { failed: true, paused: false, streaming: false }),
      },
      ...streamCursor,
    })
    cursorCommitted = true
  }
  return { cursorCommitted }
}

