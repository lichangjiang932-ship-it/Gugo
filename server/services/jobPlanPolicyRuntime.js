import { persistPlannedJob } from './jobCreation.js'
import { normalizeStructuredPlanSteps } from './jobWorkflow.js'

function hasPendingRequiredPlanApproval(job) {
  const required = job?.steps?.some((step) => (
    step.kind === 'plan' && step.input?.requirePlanApproval === true
  ))
  if (!required) return false
  return !(job?.events || []).some((event) => event.type === 'plan_approved')
}

function planApprovalIsWaiting(job) {
  if (!hasPendingRequiredPlanApproval(job) || job?.status !== 'waiting') return false
  const latestSuspension = [...(job.events || [])]
    .reverse()
    .find((event) => event.type === 'plan_proposed' || event.type === 'awaiting_user')
  return latestSuspension?.type === 'plan_proposed'
}

function planApprovalRequiredError() {
  const error = new Error('the proposed plan requires explicit approval before this action')
  error.code = 'JOB_PLAN_APPROVAL_REQUIRED'
  error.statusCode = 409
  return error
}

export function assertJobPlanApprovalResolved(job) {
  if (hasPendingRequiredPlanApproval(job)) throw planApprovalRequiredError()
}

export function assertJobPlanRetryAllowed(job, step = null) {
  if (!hasPendingRequiredPlanApproval(job)) return
  if (!planApprovalIsWaiting(job) && (!step || step.kind === 'plan')) return
  throw planApprovalRequiredError()
}

export async function prepareGuardedTaskPlan({
  plan,
  prompt,
  modelName,
  requirePlanApproval = false,
  taskPlanGuard,
}) {
  const normalizedPlan = {
    ...plan,
    prompt: plan?.prompt || String(prompt || '').trim(),
    steps: normalizeStructuredPlanSteps(plan?.steps),
  }
  const result = await taskPlanGuard({
    plan: normalizedPlan,
    modelName,
    requirePlanApproval,
  })
  return {
    plan: normalizedPlan,
    requirePlanApproval: requirePlanApproval === true || result?.requirePlanApproval === true,
    planGuard: result?.guard || null,
  }
}

export async function persistGuardedGeneratedPlan({
  id,
  userId,
  prompt,
  plan,
  modelName,
  requirePlanApproval,
  sourceType,
  sourceId,
  grants,
  taskPlanGuard,
}) {
  const guarded = await prepareGuardedTaskPlan({
    plan,
    prompt,
    modelName,
    requirePlanApproval,
    taskPlanGuard,
  })
  const event = persistPlannedJob({
    id,
    userId,
    prompt,
    plan: guarded.plan,
    modelName,
    requirePlanApproval: guarded.requirePlanApproval,
    sourceType,
    sourceId,
    grants,
    planGuard: guarded.planGuard,
  })
  return { event, plan: guarded.plan }
}

export async function persistGuardedStructuredPlan({
  id,
  userId,
  title,
  prompt,
  steps,
  modelName,
  taskPlanGuard,
}) {
  const guarded = await prepareGuardedTaskPlan({
    plan: {
      title: String(title || '').trim().slice(0, 200),
      prompt: String(prompt || title || '').trim(),
      taskType: 'structured',
      planningSource: 'user',
      steps,
    },
    modelName,
    taskPlanGuard,
  })
  const event = persistPlannedJob({
    id,
    userId,
    prompt: guarded.plan.prompt,
    plan: guarded.plan,
    modelName,
    requirePlanApproval: guarded.requirePlanApproval,
    sourceType: null,
    sourceId: null,
    grants: [],
    planGuard: guarded.planGuard,
  })
  return { event, plan: guarded.plan }
}
