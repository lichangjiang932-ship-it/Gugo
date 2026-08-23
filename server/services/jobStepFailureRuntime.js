import { formatProxyError } from '../adapters/modelProxy.js'
import { appendJobEvent, updateJob, updateJobStep } from './jobStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import { describeJobModelFailure } from './jobModelFailure.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'

function modelFailurePayload(modelFailure) {
  if (!modelFailure) return null
  return {
    code: modelFailure.code,
    action: modelFailure.action,
    providerId: modelFailure.providerId,
    modelName: modelFailure.modelName,
    configRevision: modelFailure.configRevision,
  }
}

export function persistJobStepFailure({
  commitOwned,
  emit,
  error,
  job,
  step,
} = {}) {
  const rawMessage = error?.message || String(error)
  const modelFailure = describeJobModelFailure(error, {
    modelProviderId: job.modelProviderId,
    modelName: job.modelName,
    modelConfigRevision: job.modelConfigRevision,
  })
  const message = modelFailure?.message || formatProxyError(error) || rawMessage
  const payload = modelFailurePayload(modelFailure)
  const committed = commitOwned(() => {
    updateJobStep(step.id, {
      status: 'failed',
      error: message,
      finishedAt: Date.now(),
    })
    updateJob(job.id, {
      status: 'failed',
      error: message,
      finishedAt: Date.now(),
    })
    cancelJobWake({ jobId: job.id, userId: job.userId })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: step.id,
      type: 'failed',
      message: message || 'Step execution failed',
      ...(payload ? { payload } : {}),
    }))
  })
  if (!committed) return false
  notifyJobTerminal(
    { ...job, error: message },
    { status: 'failed', body: message || 'Step execution failed' },
  )
  notifyJobStopHook(job, {
    status: 'failed',
    error: message,
    stepId: step.id,
  })
  return true
}
