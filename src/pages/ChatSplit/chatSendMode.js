const PLAN_EXECUTION_CONFIRMATIONS = new Map([
  ['\u6267\u884c', 'acceptEdits'],
  ['\u81ea\u52a8\u6a21\u5f0f\u6267\u884c', 'acceptEdits'],
  ['\u6b63\u5e38\u6a21\u5f0f\u6267\u884c', 'normal'],
])

export function intentModeForAgentMode(agentMode) {
  if (agentMode === 'code') return 'execute'
  if (agentMode === 'plan') return 'answer'
  return 'auto'
}

/**
 * Treat only an exact, whole-message confirmation as approval to leave the
 * current plan context. This must stay deliberately narrower than general
 * execution-intent inference: a sentence that merely discusses "执行" must
 * never change the user's persistent permission mode.
 */
export function resolvePlanExecutionConfirmation({
  content,
  agentMode = 'chat',
  approvalMode = 'normal',
} = {}) {
  if (agentMode !== 'plan' && approvalMode !== 'plan') return null
  const nextApprovalMode = PLAN_EXECUTION_CONFIRMATIONS.get(String(content || '').trim())
  if (!nextApprovalMode) return null
  return {
    agentMode: 'code',
    approvalMode: nextApprovalMode,
    intentMode: 'execute',
  }
}

export async function applyPlanExecutionConfirmation(confirmation, {
  currentApprovalMode = 'normal',
  changeApprovalMode,
  dispatch,
} = {}) {
  if (!confirmation) return { proceed: true, applied: false }
  if (confirmation.approvalMode !== currentApprovalMode) {
    if (typeof changeApprovalMode !== 'function') {
      return { proceed: false, applied: false }
    }
    const saved = await changeApprovalMode(confirmation.approvalMode)
    if (saved === false || saved == null) return { proceed: false, applied: false }
  }
  dispatch?.({ type: 'SET_AGENT_MODE', payload: confirmation.agentMode })
  return { proceed: true, applied: true }
}
