/** Host-only goal binding and synchronous policy checks; no storage imports. */
import { getSubagentExecutionPolicy } from './subagentExecutionPolicy.js'

const VERSION = 1
const NO_PLAN = Object.freeze({ version: VERSION, planId: null, revision: null })
const UNKNOWN_PLAN = Object.freeze({ ...NO_PLAN, unknown: true })
const CONTROL_TOOLS = new Set([
  'goal_plan_status', 'goal_step_update', 'goal_plan_rewrite', 'manage_todos',
  'reflect', 'request_clarification', 'request_directory', 'load_skill', 'search_tools', 'set_deliverables',
])

export function restoreGoalPlanBinding(value) {
  if (!value || value.version !== VERSION) {
    throw Object.assign(new Error('Invalid goal plan checkpoint binding'), { code: 'GOAL_PLAN_BINDING_INVALID', retryable: false })
  }
  if (value.planId === null && value.revision === null) return value.unknown === true ? UNKNOWN_PLAN : NO_PLAN
  if (typeof value.planId !== 'string' || !value.planId.trim() || value.planId.length > 200
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.unknown === true) {
    throw Object.assign(new Error('Invalid goal plan checkpoint binding'), { code: 'GOAL_PLAN_BINDING_INVALID', retryable: false })
  }
  return Object.freeze({ version: VERSION, planId: value.planId, revision: value.revision })
}

function readCurrentPlan(state) {
  const userId = state.job?.userId || null
  const inherited = getSubagentExecutionPolicy(state.approvalContext, { userId })
  const sessionId = inherited ? inherited.sessionId : state.job?.sessionId || null
  if (!userId || !sessionId) return NO_PLAN
  try {
    const context = state.d.goalToolContextForTurn({ userId, sessionId, requireAuthoritative: true })
    if (context?.then) {
      Promise.resolve(context).catch(() => {})
      return UNKNOWN_PLAN
    }
    if (context?.active === false) return NO_PLAN
    if (context?.active !== true || !['awaiting_approval', 'approved'].includes(context.status)) return UNKNOWN_PLAN
    return { ...restoreGoalPlanBinding({ version: VERSION, planId: context.planId, revision: context.revision }),
      status: context.status }
  } catch {
    return UNKNOWN_PLAN
  }
}

function isBuiltinGoalControl(toolName, toolOrigin) {
  return toolOrigin === 'builtin' && CONTROL_TOOLS.has(toolName)
}

export function goalPlanExecutionDecision({ binding, current, toolName, isReadOnly = false, toolOrigin = 'unknown' }) {
  if (isReadOnly || isBuiltinGoalControl(toolName, toolOrigin)) return { allowed: true }
  if (binding?.unknown || current?.unknown || !binding || !current) {
    return { allowed: false, code: 'GOAL_PLAN_STATE_UNAVAILABLE' }
  }
  if (binding.planId !== current.planId || binding.revision !== current.revision) {
    return { allowed: false, code: 'GOAL_PLAN_CHANGED' }
  }
  if (current.planId && current.status !== 'approved') {
    return { allowed: false, code: 'GOAL_PLAN_APPROVAL_REQUIRED' }
  }
  return { allowed: true }
}

function blockedText(code, locale) {
  const english = locale === 'en'
  if (code === 'GOAL_PLAN_APPROVAL_REQUIRED') return english
    ? 'The goal plan needs human approval before new side effects can execute. Approve the plan, then continue.'
    : '目标计划尚未获人工批准，新的副作用操作未执行。请批准计划后继续。'
  if (code === 'GOAL_PLAN_CHANGED') return english
    ? 'The goal plan changed after this turn started. The obsolete operation was not executed; review the current plan and start a new turn.'
    : '目标计划在本轮开始后发生变化，旧操作未执行。请核对当前计划后开启新一轮。'
  return english
    ? 'The current goal approval state could not be verified. No new side effect was executed; retry after the state is available.'
    : '无法核实当前目标计划的批准状态，新的副作用操作未执行。请在状态可用后重试。'
}

export function installGoalPlanExecutionGate(state) {
  const inherited = getSubagentExecutionPolicy(state.approvalContext, { userId: state.job?.userId || null })
  const current = readCurrentPlan(state)
  const stored = state.restoredState?.goalPlanBinding
  const captured = inherited?.goalPlanBinding || current
  state.goalPlanBinding = stored === undefined
    ? (captured.unknown ? UNKNOWN_PLAN : restoreGoalPlanBinding(captured)) : restoreGoalPlanBinding(stored)
  const inheritedBindingChanged = inherited && (
    inherited.goalPlanBinding.planId !== state.goalPlanBinding.planId
    || inherited.goalPlanBinding.revision !== state.goalPlanBinding.revision
    || (inherited.goalPlanBinding.unknown === true) !== (state.goalPlanBinding.unknown === true))
  state.goalExecutionValidationError = (toolName, args = {}) => {
    const metadata = state.d.getToolMetadata(toolName, { args, userId: state.job?.userId || null })
    if (metadata.isReadOnly === true || isBuiltinGoalControl(toolName, metadata.origin)) return null
    const live = readCurrentPlan(state)
    const decision = inheritedBindingChanged ? { allowed: false, code: 'GOAL_PLAN_CHANGED' }
      : goalPlanExecutionDecision({ binding: state.goalPlanBinding, current: live, toolName,
        toolOrigin: metadata.origin })
    if (decision.allowed) return null
    return { ok: false, denied: true, policyDenied: true, executed: false, goalPlanBlocked: true,
      code: decision.code, error: blockedText(decision.code, state.locale), retryable: false, manualRetryable: true,
      goalPlanId: live.planId || state.goalPlanBinding.planId, goalPlanRevision: live.revision || null }
  }
}
