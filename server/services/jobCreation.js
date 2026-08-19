import {
  appendJobEvent,
  appendJobSteps,
  createJob as persistJob,
} from './jobStore.js'
import { normalizeJobCreationSteps, withStableStepIds } from './jobWorkflow.js'

export function persistPlannedJob({
  id,
  userId,
  prompt,
  plan,
  modelName,
  requirePlanApproval,
  sourceType,
  sourceId,
  grants,
}) {
  const normalizedSteps = normalizeJobCreationSteps(plan.steps, { requirePlanApproval })
  persistJob({
    id,
    userId,
    title: plan.title,
    prompt: plan.prompt || String(prompt || '').trim(),
    modelName,
    sourceType,
    sourceId,
    grants,
    status: 'queued',
  })
  appendJobSteps(id, withStableStepIds(id, normalizedSteps))
  return appendJobEvent({
    jobId: id,
    type: 'created',
    message: '任务已创建',
    payload: {
      stepCount: normalizedSteps.length,
      requirePlanApproval: requirePlanApproval === true,
    },
  })
}
