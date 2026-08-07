import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'

function resultText(result) {
  if (typeof result === 'string') return result
  try { return JSON.stringify(result ?? {}) } catch { return String(result ?? '') }
}

export async function dispatchTurnEvent(event, { dispatch, taskId, onApproval, onArtifact, messageTarget } = {}) {
  const payload = event.payload || {}
  const dispatchMessage = (action) => dispatch?.({ ...action, ...(messageTarget || {}) })
  if (event.type === 'model.phase') {
    const label = payload.phase === 'started' ? 'Calling model'
      : payload.phase === 'failed' ? 'Model call failed'
        : 'Model response completed'
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: label } } })
  } else if (event.type === 'assistant.delta') {
    dispatchMessage({ type: 'APPEND_TO_LAST_MESSAGE', payload: payload.text || '' })
  } else if (event.type === 'reasoning.delta') {
    dispatchMessage({ type: 'APPEND_REASONING_TO_LAST_MESSAGE', payload: payload.text || '' })
  } else if (event.type === 'tool.call' || event.type === 'tool.started') {
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        arguments: JSON.stringify(payload.args || {}),
        status: TOOL_CALL_STATUS.RUNNING,
      },
    })
    dispatch?.({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: `Calling ${payload.name || 'tool'}` } } })
  } else if (event.type === 'tool.completed') {
    const failed = payload.result?.ok === false
    dispatchMessage({
      type: 'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
      payload: {
        id: payload.toolCallId,
        name: payload.name,
        status: failed ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS,
        result: resultText(payload.result),
        error: failed ? payload.result?.error || 'Tool call failed' : undefined,
        approvalAuthorization: payload.result?.approvalAuthorization || null,
      },
    })
    if (payload.artifactId || payload.result?.artifactId) onArtifact?.({
      id: payload.artifactId || payload.result.artifactId,
      name: payload.name,
      filename: payload.result?.filename || '',
      url: payload.result?.url || '',
    })
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
  }
}

