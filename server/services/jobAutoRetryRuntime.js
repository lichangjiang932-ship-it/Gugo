import { hasUnresolvedJobStepSideEffects } from './sideEffectExecutionLedger.js'
import { nextJobAutoRetry } from './jobAutoRetryPolicy.js'
import { persistedJobOutcomeFields } from './jobWorkflow.js'

export function buildJobRetryEvent({ job, step, modelSnapshot, automatic = false } = {}) {
  return {
    stepId: step.id,
    type: automatic ? 'auto_retry_started' : 'step_retried',
    code: automatic ? 'JOB_AUTO_RETRY_STARTED' : 'JOB_STEP_RETRIED',
    params: { title: step.title },
    payload: {
      previousModelProviderId: job.modelProviderId,
      previousModelConfigRevision: job.modelConfigRevision,
      modelProviderId: modelSnapshot.modelProviderId,
      modelConfigRevision: modelSnapshot.modelConfigRevision,
      ...(automatic ? { automatic: true, attempt: job.autoRetry?.attempts || 0 } : {}),
      ...persistedJobOutcomeFields(step.output),
      nextAction: 'resume_execution',
    },
  }
}

export function resolveJobAutoRetrySchedule({
  job,
  step,
  modelFailure,
  now = Date.now(),
} = {}) {
  if (!job || !step || job.cancelRequested
    || !['queued', 'planning', 'running'].includes(job.status)) return null
  const schedule = nextJobAutoRetry(job, { failureCode: modelFailure?.code, now })
  if (!schedule) return null
  if (hasUnresolvedJobStepSideEffects({
    userId: job.userId,
    jobId: job.id,
    stepId: step.id,
  })) return null
  return { ...schedule, failureCode: modelFailure.code }
}
