import {
  appendJobEvent,
  appendJobSteps,
  createJob as persistJob,
} from './jobStore.js'
import { normalizeJobCreationSteps, withStableStepIds } from './jobWorkflow.js'

function normalizePlanGuard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const decision = String(value.decision || '').trim().toLowerCase()
  if (!['pass', 'require_approval', 'error'].includes(decision)) return null
  const error = String(value.error || '').trim().slice(0, 120)
  return {
    pluginId: String(value.pluginId || '').trim().slice(0, 80) || 'unknown',
    service: 'task-plan-guard',
    mode: 'approval_only',
    decision,
    ...(error ? { error } : {}),
  }
}

export function persistPlannedJob({
  id,
  userId,
  prompt,
  plan,
  modelName,
  modelProviderId,
  modelConfigRevision,
  requirePlanApproval,
  sourceType,
  sourceId,
  grants,
  autoRetry,
  planGuard = null,
}) {
  const normalizedPlanGuard = normalizePlanGuard(planGuard)
  const effectivePlanApproval = requirePlanApproval === true
    || ['require_approval', 'error'].includes(normalizedPlanGuard?.decision)
  const normalizedSteps = normalizeJobCreationSteps(plan.steps, {
    requirePlanApproval: effectivePlanApproval,
  }).map((step) => (
    step.kind === 'plan' && normalizedPlanGuard
      ? { ...step, input: { ...(step.input || {}), planGuard: normalizedPlanGuard } }
      : step
  ))
  persistJob({
    id,
    userId,
    title: plan.title,
    prompt: plan.prompt || String(prompt || '').trim(),
    modelName,
    modelProviderId,
    modelConfigRevision,
    sourceType,
    sourceId,
    grants,
    autoRetry,
    status: 'queued',
  })
  appendJobSteps(id, withStableStepIds(id, normalizedSteps))
  return appendJobEvent({
    jobId: id,
    type: 'created',
    code: 'JOB_CREATED',
    payload: {
      stepCount: normalizedSteps.length,
      requirePlanApproval: effectivePlanApproval,
      ...(normalizedPlanGuard ? { planGuard: normalizedPlanGuard } : {}),
    },
  })
}
