import { formatProxyError } from '../adapters/modelProxy.js'
import {
  appendJobEvent,
  getJobWithChildren,
  updateJob,
  updateJobAutoRetryAttempts,
  updateJobStep,
} from './jobStore.js'
import { cancelJobWake, scheduleJobWake } from './jobWakeStore.js'
import { describeJobModelFailure } from './jobModelFailure.js'
import { resolveJobAutoRetrySchedule } from './jobAutoRetryRuntime.js'
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
  const now = Date.now()
  const retrySchedule = resolveJobAutoRetrySchedule({ job, step, modelFailure, now })
  let terminalPayload = null
  const committed = commitOwned(() => {
    updateJobStep(step.id, {
      status: 'failed',
      error: message,
      finishedAt: now,
    })
    updateJob(job.id, retrySchedule ? {
      status: 'waiting',
      error: message,
      finishedAt: null,
    } : {
      status: 'failed',
      error: message,
      finishedAt: now,
    }, now)
    cancelJobWake({ jobId: job.id, userId: job.userId })
    if (retrySchedule) {
      updateJobAutoRetryAttempts(job.id, {
        userId: job.userId,
        attempts: retrySchedule.attempt,
      }, now)
      scheduleJobWake({
        jobId: job.id,
        stepId: step.id,
        userId: job.userId,
        wakeAt: retrySchedule.wakeAt,
        wakeKind: 'auto_retry',
        reason: retrySchedule.failureCode,
        now,
      })
    }
    const snapshot = getJobWithChildren(job.id, { userId: job.userId })
    const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
      reason: message || 'Step execution failed',
      nextAction: retrySchedule ? 'wait_for_retry' : 'retry_step',
      ...(retrySchedule ? { status: 'waiting' } : {}),
    })
    terminalPayload = {
      ...(modelPayload || {}),
      ...diagnostics,
      ...(retrySchedule ? retrySchedule : {}),
    }
    const persistedStep = snapshot?.steps?.find((candidate) => candidate.id === step.id)
    const priorOutput = persistedStep?.output && typeof persistedStep.output === 'object' && !Array.isArray(persistedStep.output)
      ? persistedStep.output
      : {}
    updateJobStep(step.id, { output: { ...priorOutput, ...terminalPayload } })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: step.id,
      type: retrySchedule ? 'auto_retry_scheduled' : 'failed',
      code: retrySchedule ? 'JOB_AUTO_RETRY_SCHEDULED' : 'JOB_FAILED',
      params: retrySchedule
        ? { attempt: retrySchedule.attempt, maxAttempts: retrySchedule.maxAttempts }
        : {},
      payload: terminalPayload,
    }))
  })
  if (!committed) return false
  if (retrySchedule) return true
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
