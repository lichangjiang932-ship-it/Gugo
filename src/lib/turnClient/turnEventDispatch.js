import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'
import { normalizeModelUsage } from '../../../shared/modelUsage.js'
import { removeVerifiedLocalFilesFromRetained } from '../localFileReferences.js'
import { createToolOutputBuffer } from './toolOutputBuffer.js'

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

export const SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND = 'side_effect_outcome_unknown'
export const MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND = 'model_request_outcome_unknown'
const LEGACY_SIDE_EFFECT_UNKNOWN_RECOVERY_KIND = 'side_effect_unknown'

export function isSideEffectOutcomeUnknownRecoveryKind(value) {
  return value === SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND
    || value === LEGACY_SIDE_EFFECT_UNKNOWN_RECOVERY_KIND
}

export function isModelRequestOutcomeUnknownRecoveryKind(value) {
  return value === MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND
}

const CLEARED_SERVER_RECOVERY_META = Object.freeze({
  serverRecoveryBlocked: false,
  serverRecoveryKind: null,
  serverRecoveryToolCallId: null,
  serverRecoveryModelRequestId: null,
  serverRecoveryActionPath: null,
})

const CLEARED_SERVER_FAILURE_META = Object.freeze({
  serverFailure: null,
  serverFailureDisplayKey: null,
  serverPartialText: null,
})

const CLEARED_TERMINAL_STATE_META = Object.freeze({
  cancelled: false,
  failed: false,
  interrupted: false,
  paused: false,
})

function resultText(result) {
  if (typeof result === 'string') return result
  try { return JSON.stringify(result ?? {}) } catch { return String(result ?? '') }
}

function optionalInteger(value, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined
}

function optionalArtifactIds(payload, key) {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, key)) return undefined
  return [...new Set((Array.isArray(payload[key]) ? payload[key] : [])
    .map((value) => String(value || '').trim()).filter(Boolean))]
}

function terminalEvidenceSource(payload, nested, key) {
  const payloadOwns = payload && typeof payload === 'object' && Object.hasOwn(payload, key)
  const nestedOwns = nested && typeof nested === 'object' && Object.hasOwn(nested, key)
  const meaningful = (value) => (
    Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : value !== undefined && value !== null && value !== ''
  )
  // Public projections may contain an empty compatibility field while the
  // nested durable failure still carries the evidence. Never let that empty
  // outer value erase the richer persisted value.
  if (payloadOwns && meaningful(payload[key])) return payload
  if (nestedOwns && meaningful(nested[key])) return nested
  if (payloadOwns) return payload
  if (nestedOwns) return nested
  return payload
}

function optionalLocalFileReceipts(payload, key, timestampKey) {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, key)) return undefined
  const seen = new Set()
  return (Array.isArray(payload[key]) ? payload[key] : [])
    .map((file) => {
      const id = String(file?.id || '').trim()
      const path = String(file?.path || '').trim()
      const filename = String(file?.filename || '').trim()
      if (!id || !path || !filename || seen.has(id)) return null
      seen.add(id)
      return {
        id,
        path,
        filename,
        ...(Number.isFinite(Number(file?.size)) ? { size: Math.max(0, Number(file.size)) } : {}),
        ...(Number.isFinite(Number(file?.[timestampKey]))
          ? { [timestampKey]: Math.max(0, Number(file[timestampKey])) }
          : {}),
        ...(Array.isArray(file?.relatedArtifactIds) && file.relatedArtifactIds.length > 0
          ? { relatedArtifactIds: [...new Set(file.relatedArtifactIds.map(String).filter(Boolean))] }
          : {}),
      }
    })
    .filter(Boolean)
}

function optionalVerifiedLocalFiles(payload) {
  return optionalLocalFileReceipts(payload, 'verifiedLocalFiles', 'verifiedAt')
}

function optionalRetainedLocalFiles(payload) {
  return removeVerifiedLocalFilesFromRetained(
    optionalLocalFileReceipts(payload, 'retainedLocalFiles', 'retainedAt'),
    optionalVerifiedLocalFiles(payload),
  )
}

export function normalizeTurnFailurePayload(payload = {}, {
  fallbackCode = 'TURN_FAILED',
} = {}) {
  const nested = payload?.error && typeof payload.error === 'object' ? payload.error : {}
  const status = optionalInteger(nested.status ?? nested.statusCode ?? payload.status ?? payload.statusCode, 100, 599)
  const expectedSequence = optionalInteger(nested.expectedSequence ?? payload.expectedSequence, 0)
  const actualSequence = optionalInteger(nested.actualSequence ?? payload.actualSequence, 0)
  const attempts = optionalInteger(nested.attempts ?? payload.attempts, 1)
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : (typeof payload.retryable === 'boolean' ? payload.retryable : undefined)
  const manualRetryable = typeof nested.manualRetryable === 'boolean'
    ? nested.manualRetryable
    : (typeof payload.manualRetryable === 'boolean' ? payload.manualRetryable : undefined)
  const action = String(nested.action || payload.action || '').trim()
  const recoverySource = nested.recovery && typeof nested.recovery === 'object' && !Array.isArray(nested.recovery)
    ? nested.recovery
    : payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)
      ? payload.recovery
      : null
  const reasonSource = terminalEvidenceSource(payload, nested, 'reason')
  const nextActionSource = terminalEvidenceSource(payload, nested, 'nextAction')
  const reason = String(reasonSource?.reason || '').trim()
  const nextAction = String(nextActionSource?.nextAction || '').trim()
  const legacyMessage = String(nested.message || payload.message || reason).trim()
  const error = {
    code: String(nested.code || payload.code || fallbackCode).trim() || fallbackCode,
    ...(legacyMessage ? { message: legacyMessage } : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(expectedSequence !== undefined ? { expectedSequence } : {}),
    ...(actualSequence !== undefined ? { actualSequence } : {}),
    ...(action ? { action } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(manualRetryable !== undefined ? { manualRetryable } : {}),
    ...((nested.hint || payload.hint) ? { hint: String(nested.hint || payload.hint) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(recoverySource ? { recovery: { ...recoverySource } } : {}),
  }
  const incompleteReasonSource = terminalEvidenceSource(payload, nested, 'incompleteReason')
  const incompleteReason = String(incompleteReasonSource?.incompleteReason || '').trim()
  if (incompleteReason) error.incompleteReason = incompleteReason
  const nestedMissingRequirements = [...new Set((Array.isArray(nested.missingRequirements)
    ? nested.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const payloadMissingRequirements = [...new Set((Array.isArray(payload.missingRequirements)
    ? payload.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const missingRequirements = payloadMissingRequirements.length > 0
    ? payloadMissingRequirements
    : nestedMissingRequirements
  if (missingRequirements.length > 0) error.missingRequirements = missingRequirements
  const nestedTaskVerification = nested.taskVerification
    && typeof nested.taskVerification === 'object'
    && !Array.isArray(nested.taskVerification)
    && Object.keys(nested.taskVerification).length > 0
    ? nested.taskVerification
    : null
  const payloadTaskVerification = payload.taskVerification
    && typeof payload.taskVerification === 'object'
    && !Array.isArray(payload.taskVerification)
    && Object.keys(payload.taskVerification).length > 0
      ? payload.taskVerification
      : null
  const taskVerification = payloadTaskVerification || nestedTaskVerification
  if (taskVerification) error.taskVerification = taskVerification
  const iterations = optionalInteger(
    terminalEvidenceSource(payload, nested, 'iterations')?.iterations,
    0,
  )
  const partialTextSource = terminalEvidenceSource(payload, nested, 'partialText')
  const textSource = terminalEvidenceSource(payload, nested, 'text')
  const partialText = Object.hasOwn(partialTextSource || {}, 'partialText')
    ? String(partialTextSource.partialText ?? '')
    : Object.hasOwn(textSource || {}, 'text') ? String(textSource.text ?? '') : undefined
  const artifactIds = optionalArtifactIds(
    terminalEvidenceSource(payload, nested, 'artifactIds'),
    'artifactIds',
  )
  const deliveryArtifactIds = optionalArtifactIds(
    terminalEvidenceSource(payload, nested, 'deliveryArtifactIds'),
    'deliveryArtifactIds',
  )
  const verifiedLocalFiles = optionalVerifiedLocalFiles(
    terminalEvidenceSource(payload, nested, 'verifiedLocalFiles'),
  )
  const retainedSource = terminalEvidenceSource(payload, nested, 'retainedLocalFiles')
  const retainedLocalFiles = removeVerifiedLocalFilesFromRetained(
    optionalRetainedLocalFiles(retainedSource),
    verifiedLocalFiles,
  )
  const modelUsage = normalizeModelUsage(
    terminalEvidenceSource(payload, nested, 'usage')?.usage,
  )
  const turnModelUsage = normalizeModelUsage(
    terminalEvidenceSource(payload, nested, 'turnModelUsage')?.turnModelUsage,
  )
  const estimatedPromptTokens = optionalInteger(
    terminalEvidenceSource(payload, nested, 'estimatedPromptTokens')?.estimatedPromptTokens,
    0,
  )
  return {
    error,
    ...(partialText !== undefined ? { partialText } : {}),
    ...(artifactIds !== undefined ? { artifactIds } : {}),
    ...(deliveryArtifactIds !== undefined ? { deliveryArtifactIds } : {}),
    ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
    ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(turnModelUsage ? { turnModelUsage } : {}),
    ...(estimatedPromptTokens !== undefined ? { estimatedPromptTokens } : {}),
  }
}

export function createTurnFailureError(payload, options) {
  const failure = normalizeTurnFailurePayload(payload, options)
  return Object.assign(
    new Error(failure.error.message || failure.error.code),
    failure.error,
    failure,
    { serverFailure: failure.error },
  )
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

export async function dispatchTurnEvent(event, {
  dispatch,
  taskId,
  onApproval,
  onArtifact,
  messageTarget,
  flushToolOutput,
} = {}) {
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
        streaming: true,
        turnCompletedAt: null,
        latency: null,
        serverPartialText: '',
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
    const labels = {
      started: 'Calling model',
      waiting_first_token: 'Waiting for model output',
      streaming: 'Receiving model output',
      idle: 'Model output paused; task is still running',
      retrying: 'Retrying model call',
      failed: 'Model call failed',
      completed: 'Model response completed',
    }
    const label = labels[payload.phase] || 'Model task is running'
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: label } } })
    const modelUsage = payload.phase === 'completed'
      ? normalizeModelUsage(payload.usage)
      : null
    if (payload.phase === 'streaming') {
      dispatchMessage({
        type: 'UPDATE_LAST_MESSAGE_META',
        payload: { progress: null, modelActivity: { kind: 'responding', phase: payload.phase, iteration: payload.iteration } },
        ...streamCursor,
      })
      cursorCommitted = true
    } else if (['started', 'waiting_first_token', 'idle', 'retrying'].includes(payload.phase)) {
      dispatchMessage({
        type: 'UPDATE_LAST_MESSAGE_META',
        payload: { progress: null, modelActivity: { kind: 'model', phase: payload.phase, iteration: payload.iteration } },
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
        ...(artifactIds?.length > 0 ? { serverArtifactIds: artifactIds } : {}),
        ...(deliveryArtifactIds?.length > 0 ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
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
                  serverRecoveryActionPath: payload.recoveryAction?.path === '/settings?tab=recovery'
                    ? payload.recoveryAction.path
                    : '/settings?tab=recovery',
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

