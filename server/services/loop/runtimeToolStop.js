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

/**
 * Terminal authority outcomes cannot be converted into another model/tool attempt.
 *
 * Refusals are the exception, as in Claude Code: a call the user declined, or one
 * a permission rule/hook forbade, is a tool result the model reads and works
 * around — the turn continues. Only what nobody decided (expiry, a missing
 * per-call approval, a broken authorization system), cancellation and unknown
 * side effects still end the turn.
 */
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
    // The rest of this batch is skipped so the user is not asked again about
    // calls planned before their answer; the model then gets the next round.
    return { kind: 'refused', code: 'approval_denied', reason: 'approval_denied' }
  }
  if (result.expired === true) return { kind: 'denied', code: 'approval_expired', reason: 'approval_expired' }
  if (result.approvalRequired === true || code === 'approval_required') {
    return { kind: 'denied', code: 'approval_required', reason: 'approval_required' }
  }
  if (result.authorizationFailure === true && result.retryable === false) {
    return { kind: 'denied', code: code || 'approval_system_failed', reason: 'tool_authorization_unavailable' }
  }
  // Policy, hook and mode refusals: an ordinary failed result. Each later call
  // is checked on its own, and the loop guard bounds repeated identical attempts.
  return null
}

/**
 * Consecutive refused rounds after which the turn stops and waits for the user.
 * One refusal goes back to the model; a second in a row means it is proposing
 * what the user keeps declining. (A third identical proposal would also trip the
 * repeat-call guard, which reports a less accurate no-progress stop.)
 */
export const MAX_CONSECUTIVE_REFUSED_ROUNDS = 2

/** A policy, hook or mode refusal, in the shape a terminal stop needs. */
export function policyRefusal(result) {
  if (!result || result.ok === true) return null
  const code = String(result.code || '')
  if (!(result.denied === true || result.policyDenied === true || code === 'hook_denied')) return null
  if (result.deniedByUser === true) return null
  const reason = ['explicit_read_only_constraint', 'explicit_tool_free_constraint', 'tool_disabled_by_config'].includes(code)
    ? code : 'tool_permission_denied'
  return { kind: 'refused', code: code || 'tool_permission_denied', reason }
}

/**
 * A refused round goes back to the model. Repeated refusals with nothing else
 * succeeding in between mean the model keeps proposing what the user or the
 * policy keeps declining, so the turn ends there instead of asking forever.
 *
 * A round counts as refused when the user declined a call in it, or when every
 * call in it was refused by policy — one refused call next to work that ran is
 * just a failed call, and the round made progress.
 */
export function absorbRefusedToolStop(state) {
  const i = state.iteration
  const calls = Array.isArray(i.toolCalls) ? i.toolCalls : []
  if (!i.toolStop && calls.length > 0) {
    const refusals = calls.map((call) => policyRefusal(call.checkpointResult))
    if (refusals.every(Boolean)) i.toolStop = refusals[0]
  }
  const stop = i.toolStop
  if (stop?.kind !== 'refused') return false
  // Declining the very check a write still needs leaves nothing the model can do
  // except ask for it again, which the verification gate would insist on. The
  // turn stops there and reports the write as standing but unverified.
  const refusedVerification = state.hasPendingMutationVerification?.() === true
    && calls.some((call) => call.checkpointResult?.deniedByUser === true
      && state.availableVerificationToolNames?.includes(call.name))
  if (refusedVerification) {
    stop.kind = 'denied'
    return false
  }
  state.consecutiveRefusedRounds = (Number(state.consecutiveRefusedRounds) || 0) + 1
  if (state.consecutiveRefusedRounds >= MAX_CONSECUTIVE_REFUSED_ROUNDS) {
    stop.kind = 'denied'
    return false
  }
  i.toolStop = null
  return true
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
