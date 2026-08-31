import { formatProxyError } from '../adapters/modelProxy.js'
import { appendJobEvent, getJobWithChildren, updateJob, updateJobStep } from './jobStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import { describeJobModelFailure } from './jobModelFailure.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import { buildJobOutcomeDiagnostics } from './jobWorkflow.js'

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
  const modelPayload = modelFailurePayload(modelFailure)
  let terminalPayload = null
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
    const snapshot = getJobWithChildren(job.id, { userId: job.userId })
    const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
      reason: message || 'Step execution failed',
      nextAction: 'retry_step',
    })
    terminalPayload = { ...(modelPayload || {}), ...diagnostics }
    const persistedStep = snapshot?.steps?.find((candidate) => candidate.id === step.id)
    const priorOutput = persistedStep?.output && typeof persistedStep.output === 'object' && !Array.isArray(persistedStep.output)
      ? persistedStep.output
      : {}
    updateJobStep(step.id, { output: { ...priorOutput, ...terminalPayload } })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: step.id,
      type: 'failed',
      message: message || 'Step execution failed',
      payload: terminalPayload,
    }))
  })
  if (!committed) return false
  notifyJobTerminal(
    { ...job, error: message },
    { status: 'failed', body: message || 'Step execution failed', payload: terminalPayload },
  )
  notifyJobStopHook(job, {
    status: 'failed',
    error: message,
    stepId: step.id,
  })
  return true
}
