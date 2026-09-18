/** Host-only delegation constraints. No model argument or enumerable context field is trusted. */
const policies = new WeakMap()
export const SUBAGENT_EXECUTION_POLICY_VERSION = 1
export const SUBAGENT_EXECUTION_POLICY_EVENT = 'runtime_execution_policy'

function policyError(code = 'SUBAGENT_EXECUTION_POLICY_INVALID') {
  return Object.assign(new Error(code === 'SUBAGENT_EXECUTION_POLICY_CONFLICT'
    ? 'Subagent execution policy conflicts with its recorded parent scope.'
    : 'Subagent execution policy is missing a valid host scope.'), { code, retryable: false })
}

function identifier(value, { nullable = false } = {}) {
  if (nullable && value == null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw policyError()
  return value
}

function bindingSnapshot(value) {
  if (!value || value.version !== 1) throw policyError()
  if (value.planId === null && value.revision === null) {
    return Object.freeze({ version: 1, planId: null, revision: null,
      ...(value.unknown === true ? { unknown: true } : {}) })
  }
  if (value.unknown === true || !Number.isSafeInteger(value.revision) || value.revision < 1) throw policyError()
  return Object.freeze({ version: 1, planId: identifier(value.planId), revision: value.revision })
}

/** Read only from a host-owned persistence record, never from Agent arguments. */
export function restoreSubagentExecutionPolicySnapshot(value, { userId } = {}) {
  if (!value || value.version !== SUBAGENT_EXECUTION_POLICY_VERSION || typeof value.readOnly !== 'boolean') throw policyError()
  const owner = identifier(value.userId)
  if (userId != null && owner !== userId) throw policyError('SUBAGENT_EXECUTION_POLICY_CONFLICT')
  const sessionId = identifier(value.sessionId, { nullable: true })
  const goalPlanBinding = bindingSnapshot(value.goalPlanBinding)
  if (goalPlanBinding.planId && !sessionId) throw policyError()
  return Object.freeze({ version: SUBAGENT_EXECUTION_POLICY_VERSION,
    userId: owner, sessionId, goalPlanBinding, readOnly: value.readOnly })
}

function sameBinding(left, right) {
  return left.planId === right.planId && left.revision === right.revision
    && (left.unknown === true) === (right.unknown === true)
}

function inheritedSnapshot(parent, next) {
  if (parent.userId !== next.userId || (next.sessionId && parent.sessionId !== next.sessionId)
      || !sameBinding(parent.goalPlanBinding, next.goalPlanBinding)) {
    throw policyError('SUBAGENT_EXECUTION_POLICY_CONFLICT')
  }
  return Object.freeze({ ...parent, readOnly: parent.readOnly || next.readOnly })
}

export function getSubagentExecutionPolicy(context, { userId } = {}) {
  if (!context || typeof context !== 'object') return null
  const snapshot = policies.get(context) || null
  if (snapshot && userId != null && snapshot.userId !== userId) throw policyError('SUBAGENT_EXECUTION_POLICY_CONFLICT')
  return snapshot
}

/** Preserve the approval cache, but give each child an immutable, non-forgeable policy wrapper. */
export function bindSubagentExecutionPolicy(context, { userId, sessionId = null, goalPlanBinding, readOnly = false } = {}) {
  const parent = getSubagentExecutionPolicy(context, { userId })
  const proposed = restoreSubagentExecutionPolicySnapshot({
    version: SUBAGENT_EXECUTION_POLICY_VERSION, userId,
    sessionId: sessionId || parent?.sessionId || null,
    goalPlanBinding: goalPlanBinding || parent?.goalPlanBinding,
    readOnly: readOnly === true,
  }, { userId })
  const snapshot = parent ? inheritedSnapshot(parent, proposed) : proposed
  const wrapper = {
    approved: context?.approved instanceof Map ? context.approved : new Map(),
    pending: context?.pending instanceof Map ? context.pending : new Map(),
  }
  policies.set(wrapper, snapshot)
  return wrapper
}

/** Rebind only authenticated persisted state; a new ancestor cannot replace old scope/revision. */
export function restoreSubagentApprovalContext(context, snapshot, { userId } = {}) {
  const parent = getSubagentExecutionPolicy(context, { userId })
  if (snapshot === undefined) return context || { approved: new Map(), pending: new Map() }
  const recorded = restoreSubagentExecutionPolicySnapshot(snapshot, { userId })
  if (parent && (parent.sessionId !== recorded.sessionId || !sameBinding(parent.goalPlanBinding, recorded.goalPlanBinding))) {
    throw policyError('SUBAGENT_EXECUTION_POLICY_CONFLICT')
  }
  return bindSubagentExecutionPolicy(context, { ...recorded, readOnly: recorded.readOnly || parent?.readOnly === true })
}

/** Only the host snapshot may populate this checkpoint field. */
export function withSubagentExecutionPolicyCheckpoint(state, context, { userId } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw policyError()
  const snapshot = getSubagentExecutionPolicy(context, { userId })
  const result = { ...state }
  delete result.subagentExecutionPolicy
  if (snapshot) {
    if (state.goalPlanBinding && !sameBinding(bindingSnapshot(state.goalPlanBinding), snapshot.goalPlanBinding)) {
      throw policyError('SUBAGENT_EXECUTION_POLICY_CONFLICT')
    }
    result.subagentExecutionPolicy = snapshot
  }
  return result
}

/** A dispatch-time host wrapper can tighten, but cannot replace, this child's inherited policy. */
export function subagentCallApprovalContext(incoming, inherited, { userId } = {}) {
  if (!getSubagentExecutionPolicy(incoming, { userId })) return inherited
  return restoreSubagentApprovalContext(incoming, getSubagentExecutionPolicy(inherited, { userId }) || undefined, { userId })
}
