/** Current-user tool prohibitions do not erase already confirmed or unknown effects. */
export function toolFreeResponseError(state, context) {
  if (!state.explicitToolFree) return null
  const unknown = context.resumedExecutingSideEffect || (context.call.checkpointStatus === 'executing'
    && context.call.checkpointReadOnly !== true && !context.resumedPreparedSideEffect)
  return unknown ? {
    ok: false, code: 'tool_execution_outcome_unknown', retryable: false, requiresUserVerification: true,
    error: 'A previously executing operation requires independent verification; no tool was replayed.',
    policyCauseCode: 'explicit_tool_free_constraint',
  } : {
    ok: false, denied: true, policyDenied: true, code: 'explicit_tool_free_constraint', retryable: false,
    error: state.locale === 'zh' ? '用户明确要求本轮不调用工具，已拒绝该提案，未执行。'
      : 'The current user explicitly requested a tool-free response. This proposal was rejected without execution.',
  }
}

/** Terminal authority outcomes cannot be converted into another model/tool attempt. */
export function toolStopBoundary(result, toolCallId = null) {
  if (!result) return null
  const code = String(result.code || '')
  if (result.requiresUserVerification === true || ['SIDE_EFFECT_OUTCOME_UNKNOWN', 'tool_execution_outcome_unknown'].includes(code)) {
    return { kind: 'unknown', code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', error: result.error, toolCallId }
  }
  if (result.ok === true) return null
  if (result.cancelled === true || ['turn_cancelled', 'cancelled'].includes(code)) {
    return { kind: 'cancelled', code: 'turn_cancelled', error: result.error, toolCallId }
  }
  if (result.goalPlanBlocked === true) return null
  if (result.deniedByUser === true || code === 'approval_denied') {
    return { kind: 'denied', code: 'approval_denied', reason: 'approval_denied' }
  }
  if (result.expired === true) return { kind: 'denied', code: 'approval_expired', reason: 'approval_expired' }
  if (result.approvalRequired === true || code === 'approval_required') {
    return { kind: 'denied', code: 'approval_required', reason: 'approval_required' }
  }
  if (result.authorizationFailure === true && result.retryable === false) {
    return { kind: 'denied', code: code || 'approval_system_failed', reason: 'tool_authorization_unavailable' }
  }
  if (result.denied === true || result.policyDenied === true || code === 'hook_denied') {
    const reason = ['explicit_read_only_constraint', 'explicit_tool_free_constraint', 'tool_disabled_by_config'].includes(code)
      ? code : 'tool_permission_denied'
    return { kind: 'denied', code: code || 'tool_permission_denied', reason }
  }
  return null
}

export async function finishToolStop(state) {
  const stop = state.iteration.toolStop
  await state.persistTurn()
  if (stop.kind === 'unknown') {
    throw state.d.sideEffectRecoveryBlock(state.d.SIDE_EFFECT_OUTCOME_UNKNOWN,
      stop.error || 'Verify the previous operation before continuing.', { toolCallId: stop.toolCallId })
  }
  if (stop.kind === 'cancelled') {
    throw Object.assign(new Error(stop.error || 'Turn cancelled'), { name: 'AbortError', code: 'turn_cancelled' })
  }
  state.checkpointCalls = null
  const terminal = await state.finishIncomplete({ code: stop.code, reason: stop.reason,
    retryable: false, manualRetryable: true, steeringLeaseId: state.iteration.steeringLeaseId })
  return terminal?.deferredForSteering ? { kind: 'continue' } : { kind: 'return', value: terminal }
}
