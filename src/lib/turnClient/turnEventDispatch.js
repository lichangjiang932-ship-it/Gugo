import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'
import { createToolOutputBuffer } from './toolOutputBuffer.js'

const TOOL_OUTPUT_FLUSH_EVENT_TYPES = new Set([
  'tool.completed',
  'turn.interrupted',
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
  ['turn.failed', TOOL_CALL_STATUS.ERROR],
])

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

export function normalizeTurnFailurePayload(payload = {}, {
  fallbackCode = 'TURN_FAILED', fallbackMessage = 'Server turn failed',
} = {}) {
  const nested = payload?.error && typeof payload.error === 'object' ? payload.error : {}
  const status = optionalInteger(nested.status ?? nested.statusCode ?? payload.status ?? payload.statusCode, 100, 599)
  const attempts = optionalInteger(nested.attempts ?? payload.attempts, 1)
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : (typeof payload.retryable === 'boolean' ? payload.retryable : undefined)
  const error = {
    code: String(nested.code || payload.code || fallbackCode).trim() || fallbackCode,
    message: String(nested.message || payload.message || payload.reason || fallbackMessage).trim() || fallbackMessage,
    ...(status !== undefined ? { status } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...((nested.hint || payload.hint) ? { hint: String(nested.hint || payload.hint) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  }
  const iterations = optionalInteger(payload.iterations, 0)
  const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
  return {
    error,
    partialText: String(payload.partialText ?? payload.text ?? ''),
    artifactIds: [...new Set((Array.isArray(payload.artifactIds) ? payload.artifactIds : [])
      .map((value) => String(value || '').trim()).filter(Boolean))],
    ...(deliveryArtifactIds !== undefined ? { deliveryArtifactIds } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
  }
}

export function createTurnFailureError(payload, options) {
  const failure = normalizeTurnFailurePayload(payload, options)
  return Object.assign(new Error(failure.error.message), failure.error, failure, { serverFailure: failure.error })
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
    ...(messageTarget || {}),
  })
  return true
}

export function createBufferedTurnActivityDispatcher(options = {}) {
  const { bufferOptions = {}, ...dispatchOptions } = options
  const outputBuffer = createToolOutputBuffer({
    ...bufferOptions,
    onFlush: ({ id, name, chunk, stream }) => dispatchToolOutput({
      toolCallId: id,
      toolName: name,
      chunk,
      stream,
    }, dispatchOptions),
  })

  return {
    onActivity: (activity) => activity?.kind === 'tool_output_delta'
      ? outputBuffer.append({
          id: activity.toolCallId,
          name: activity.toolName,
          chunk: activity.chunk,
          stream: activity.stream,
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
  let cursorCommitted = false
  if (event.type === 'turn.started') {
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: { modelActivity: { kind: 'preparing' } },
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
      ...streamCursor,
    })
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        interrupted: false,
        serverFailure: null,
        serverPartialText: '',
        serverArtifactIds: [],
        modelActivity: null,
      },
    })
    cursorCommitted = true
  } else if (event.type === 'model.phase') {
    const label = payload.phase === 'started' ? 'Calling model'
      : payload.phase === 'failed' ? 'Model call failed'
        : 'Model response completed'
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: label } } })
    if (payload.phase === 'started') {
      dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { modelActivity: { kind: 'model' } } })
    } else if (payload.phase === 'completed' || payload.phase === 'failed') {
      dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { modelActivity: null } })
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
      meta: { modelActivity: { kind: 'responding' } },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'reasoning.delta') {
    dispatchMessage({ type: 'APPEND_REASONING_TO_LAST_MESSAGE', payload: payload.text || '', ...streamCursor })
    cursorCommitted = true
  } else if (event.type === 'turn.progress') {
    dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { progress: payload }, ...streamCursor })
    cursorCommitted = true
  } else if (event.type === 'tool.call' || event.type === 'tool.started') {
    dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { modelActivity: null } })
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        ...(payload.args !== undefined ? { arguments: JSON.stringify(payload.args) } : {}),
        status: TOOL_CALL_STATUS.RUNNING,
      },
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `Calling ${payload.name || 'tool'}` } } })
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
    dispatchMessage({ type: 'UPDATE_LAST_MESSAGE_META', payload: { modelActivity: { kind: 'reviewing' } } })
  } else if (event.type === 'approval.required') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Waiting for approval' } } })
    await onApproval?.({
      id: payload.approvalId,
      name: payload.toolName,
      args: payload.args || {},
      risk: payload.risk,
      reason: payload.reason,
    })
  } else if (event.type === 'approval.resolved') {
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: 'Approval resolved, continuing' } } })
  } else if (event.type === 'turn.paused') {
    const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        streaming: false,
        modelActivity: null,
        paused: true,
        serverConnectionState: 'paused',
        serverClarification: payload.clarification || null,
        directoryAuthorizationPending: false,
        serverResumeResolution: null,
        ...(deliveryArtifactIds !== undefined ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
      },
      ...streamCursor,
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: payload.clarification?.question || 'Waiting for user input' } } })
    cursorCommitted = true
  } else if (event.type === 'turn.completed') {
    const deliveryArtifactIds = optionalArtifactIds(payload, 'deliveryArtifactIds')
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        streaming: false,
        modelActivity: null,
        serverArtifactIds: optionalArtifactIds(payload, 'artifactIds') || [],
        ...(deliveryArtifactIds !== undefined ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.cancelled') {
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        streaming: false,
        modelActivity: null,
        serverConnectionState: 'cancelled',
        serverArtifactIds: optionalArtifactIds(payload, 'artifactIds') || [],
        serverDeliveryArtifactIds: optionalArtifactIds(payload, 'deliveryArtifactIds') || [],
      },
      ...streamCursor,
    })
    cursorCommitted = true
  } else if (event.type === 'turn.interrupted' || event.type === 'turn.failed') {
    const failure = normalizeTurnFailurePayload(payload, {
      fallbackCode: event.type === 'turn.interrupted' ? 'TURN_INTERRUPTED' : 'TURN_FAILED',
      fallbackMessage: event.type === 'turn.interrupted' ? 'Turn interrupted' : 'Server turn failed',
    })
    dispatchMessage({
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: {
        serverFailure: failure.error,
        streaming: false,
        modelActivity: null,
        serverPartialText: failure.partialText,
        serverArtifactIds: failure.artifactIds,
        ...(failure.deliveryArtifactIds !== undefined
          ? { serverDeliveryArtifactIds: failure.deliveryArtifactIds }
          : {}),
        ...(failure.iterations !== undefined ? { serverIterations: failure.iterations } : {}),
        interrupted: event.type === 'turn.interrupted',
        ...(event.type === 'turn.interrupted'
          ? { serverConnectionState: 'interrupted' }
          : { failed: true, streaming: false }),
      },
      ...streamCursor,
    })
    cursorCommitted = true
  }
  const terminalToolStatus = TERMINAL_TOOL_CALL_STATUS.get(event.type)
  if (terminalToolStatus) {
    dispatchMessage({
      type: 'FINALIZE_RUNNING_TOOL_CALLS',
      payload: {
        status: terminalToolStatus,
        ...(terminalToolStatus === TOOL_CALL_STATUS.ERROR
          ? {
              error: String(payload.message || payload.reason || 'Turn failed before the tool returned a result'),
              errorCode: String(payload.code || payload.error?.code || 'TURN_FAILED'),
            }
          : {}),
      },
    })
  }
  return { cursorCommitted }
}

