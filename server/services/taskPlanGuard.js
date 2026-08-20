import { invokePluginService } from '../plugins/pluginRegistry.js'

const SERVICE_NAME = 'task-plan-guard'
const DECISIONS = new Set(['pass', 'require_approval'])
const MAX_OBJECTIVE_CHARS = 8_000

function clean(value, max = 512) {
  return String(value || '').trim().slice(0, max)
}

function cleanList(value, { maxItems = 20, maxChars = 1_000 } = {}) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map((item) => clean(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems))
}

function frozenStep(step = {}) {
  const input = step?.input && typeof step.input === 'object' && !Array.isArray(step.input)
    ? step.input
    : {}
  return Object.freeze({
    title: clean(step?.title, 200),
    kind: clean(step?.kind, 64) || 'execute',
    description: clean(input.description, 2_000),
    action: clean(input.action, 2_000),
    risk: clean(input.risk, 64) || 'low',
    targets: cleanList(input.targets, { maxItems: 20, maxChars: 512 }),
    acceptance: cleanList(
      Array.isArray(input.acceptance) ? input.acceptance : [input.acceptance],
      { maxItems: 20, maxChars: 1_000 },
    ),
  })
}

function guardScope({ plan, modelName, requirePlanApproval }) {
  return Object.freeze({
    title: clean(plan?.title, 200),
    objective: clean(plan?.prompt, MAX_OBJECTIVE_CHARS),
    taskType: clean(plan?.taskType, 64) || 'general',
    planningSource: clean(plan?.planningSource, 64) || 'unknown',
    modelName: clean(modelName, 512) || null,
    requirePlanApproval: requirePlanApproval === true,
    steps: Object.freeze((Array.isArray(plan?.steps) ? plan.steps : [])
      .slice(0, 50)
      .map(frozenStep)),
  })
}

function guardMetadata({ pluginId, decision, error = null }) {
  return Object.freeze({
    pluginId: clean(pluginId, 80) || 'unknown',
    service: SERVICE_NAME,
    mode: 'approval_only',
    decision,
    ...(error ? { error: clean(error, 120) } : {}),
  })
}

function forceApproval({ pluginId, code }) {
  return Object.freeze({
    requirePlanApproval: true,
    guard: guardMetadata({ pluginId, decision: 'error', error: code }),
  })
}

function normalizeGuardResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const decision = clean(value.decision, 40).toLowerCase()
  return DECISIONS.has(decision) ? decision : null
}

export async function applyRuntimeTaskPlanGuard(input = {}, dependencies = {}) {
  const explicitlyRequired = input.requirePlanApproval === true
  const invokeService = dependencies.invokePluginService || invokePluginService
  let invoked
  try {
    invoked = await invokeService(SERVICE_NAME, 'review', [guardScope(input)])
  } catch (error) {
    return forceApproval({
      pluginId: error?.pluginId,
      code: clean(error?.code, 120) || 'PLUGIN_SERVICE_CALL_FAILED',
    })
  }
  if (!invoked?.found) {
    return Object.freeze({ requirePlanApproval: explicitlyRequired, guard: null })
  }
  const decision = normalizeGuardResult(invoked.value)
  if (!decision) {
    return forceApproval({
      pluginId: invoked.pluginId,
      code: 'TASK_PLAN_GUARD_RESULT_INVALID',
    })
  }
  return Object.freeze({
    requirePlanApproval: explicitlyRequired || decision === 'require_approval',
    guard: guardMetadata({ pluginId: invoked.pluginId, decision }),
  })
}

export const TASK_PLAN_GUARD_SERVICE = SERVICE_NAME
