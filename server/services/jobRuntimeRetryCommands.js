import { appendJobEvent, completeJobStep } from './jobStore.js'
import { latestPersistedOutcomeFields } from './jobRuntimeProjection.js'
import { cancelJobWake } from './jobWakeStore.js'
import { retryJobTransition } from './jobRuntimeTransitionStore.js'
import {
  assertJobPlanApprovalResolved,
  assertJobPlanRetryAllowed,
  normalizeJobModelSnapshot,
} from './jobPlanPolicyRuntime.js'
import { completeManualJobTransition } from './jobAcceptanceRuntime.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import {
  loadJobRetryCheckpoints,
  loadRetryCheckpoint,
  makeRetryCheckpointResumable,
} from './jobRetryRuntime.js'
import { buildJobRetryEvent } from './jobAutoRetryRuntime.js'
import { hasUnresolvedJobStepSideEffects } from './sideEffectExecutionLedger.js'
import {
  assertRetryHasRunnablePath,
  deliveryProjectionDiagnosticResetStepIds,
  deliveryProjectionRecoverySteps,
  deliveryProjectionRetryBlocker,
  hasExplicitIncompleteStepOutput,
  hasRejectedCompletedOutcome,
  RETRYABLE_STEP_STATUSES,
  retryStatusError,
  uniqueJobSteps,
} from './jobRetryEligibility.js'

export const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RETRYABLE_JOB_STATUSES = new Set(['failed', 'cancelled'])

export function retryRuntimeJob(runtime, jobId, { userId } = {}) {
  let currentJob = runtime.getJob(jobId, { userId })
  if (!currentJob) return null
  // A pending plan approval is the authoritative blocker. Surface its
  // stable error before the generic retry-status guard so retry routes
  // cannot obscure the security decision behind JOB_RETRY_STATUS_INVALID.
  assertJobPlanRetryAllowed(currentJob)
  if (!RETRYABLE_JOB_STATUSES.has(currentJob.status)) {
    const error = new Error(`job cannot be retried from status ${currentJob.status}`)
    error.code = 'JOB_RETRY_STATUS_INVALID'
    error.statusCode = 409
    throw error
  }
  const retryLease = !runtime.activeControllers.has(jobId)
    ? runtime.runtimeCore.lease.acquire({ jobId })
    : null
  if (!retryLease) {
    const error = new Error('job retry is already active')
    error.code = 'JOB_RETRY_CONFLICT'
    error.statusCode = 409
    throw error
  }
  try {
    currentJob = runtime.getJob(jobId, { userId })
    if (currentJob) assertJobPlanRetryAllowed(currentJob)
    if (!currentJob || !RETRYABLE_JOB_STATUSES.has(currentJob.status)) {
      const error = new Error(`job cannot be retried from status ${currentJob?.status || 'missing'}`)
      error.code = 'JOB_RETRY_STATUS_INVALID'
      error.statusCode = 409
      throw error
    }
    const deliveryRetryBlocker = deliveryProjectionRetryBlocker(currentJob)
    if (deliveryRetryBlocker) {
      throw retryStatusError('JOB_RETRY_STATUS_INVALID', deliveryRetryBlocker)
    }
    const modelBinding = runtime.resolveModelBinding({
      userId,
      providerId: currentJob.modelProviderId,
      modelName: currentJob.modelName,
    })
    const modelSnapshot = normalizeJobModelSnapshot({
      modelName: modelBinding.modelName,
      modelProviderId: modelBinding.providerId,
      modelConfigRevision: modelBinding.configRevision,
    })
    const checkpointsByStepId = loadJobRetryCheckpoints({
      runtimeCore: runtime.runtimeCore,
      job: currentJob,
      modelSnapshot,
    })
    const deliveryRecoverySteps = deliveryProjectionRecoverySteps(currentJob)
    const retriedSteps = uniqueJobSteps([...currentJob.steps.filter((step) => (
      RETRYABLE_STEP_STATUSES.has(step.status) || hasRejectedCompletedOutcome(step)
    )), ...deliveryRecoverySteps])
    assertRetryHasRunnablePath(currentJob, retriedSteps)
    const completedRetryStepIds = deliveryRecoverySteps
      .filter((step) => step.status === 'completed')
      .map((step) => step.id)
    const diagnosticResetStepIds = deliveryProjectionDiagnosticResetStepIds(
      currentJob,
      retriedSteps,
    )
    const retriedDiagnostics = latestPersistedOutcomeFields(retriedSteps)
    const previousDiagnostics = Object.keys(retriedDiagnostics).length > 0
      ? retriedDiagnostics
      : latestPersistedOutcomeFields(currentJob.steps)
    const transition = retryJobTransition({
      jobId,
      userId,
      expectedJobStatus: currentJob.status,
      steps: retriedSteps,
      completedRetryStepIds,
      diagnosticResetStepIds,
      modelSnapshot,
      prepareCheckpoints: () => {
        for (const step of retriedSteps) {
          // A truncated run deliberately keeps its durable checkpoint. Clear
          // only the terminal marker so the next tick resumes after completed
          // tool results. Keeping this inside retryJobTransition also makes
          // checkpoint preparation atomic with the job/step compare-and-swap.
          makeRetryCheckpointResumable({
            runtimeCore: runtime.runtimeCore,
            checkpoint: checkpointsByStepId.get(step.id),
            jobId,
            stepId: step.id,
            userId,
          })
        }
      },
      event: {
        type: 'retried',
        code: 'JOB_RETRIED',
        payload: {
          previousModelProviderId: currentJob.modelProviderId,
          previousModelConfigRevision: currentJob.modelConfigRevision,
          modelProviderId: modelSnapshot.modelProviderId,
          modelConfigRevision: modelSnapshot.modelConfigRevision,
          ...previousDiagnostics,
          nextAction: 'resume_execution',
        },
      },
    })
    if (!transition.changed) {
      const error = new Error(`job cannot be retried from status ${transition.status || 'missing'}`)
      error.code = 'JOB_RETRY_STATUS_INVALID'
      error.statusCode = 409
      throw error
    }
    runtime.emit(transition.event)
    return runtime.getJob(jobId, { userId })
  } finally {
    retryLease.release()
  }
}

export function completeRuntimeStep(runtime, jobId, stepId, { userId, evidence = [] } = {}) {
  const initial = runtime.getJob(jobId, { userId })
  if (!initial) return null
  const completionLease = !runtime.activeControllers.has(jobId)
    ? runtime.runtimeCore.lease.acquire({ jobId })
    : null
  if (!completionLease) {
    const error = new Error('job step cannot be completed while the job is active')
    error.code = 'JOB_COMPLETION_CONFLICT'
    error.statusCode = 409
    throw error
  }
  try {
    let completedJob = null
    const completionEvents = []
    let terminalTransition = null
    const outcome = runtime.runtimeCore.lease.runIfOwned({ jobId }, () => {
      const job = runtime.getJob(jobId, { userId })
      const step = job?.steps.find((item) => item.id === stepId)
      if (!job || !step) return false
      assertJobPlanApprovalResolved(job)
      if (TERMINAL_JOB_STATUSES.has(job.status)
        || job.cancelRequested
        || job.status === 'cancel_requested') {
        const error = new Error(`job step cannot be completed after job reached ${job.status}`)
        error.code = 'JOB_COMPLETION_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      if (!['queued', 'pending', 'running'].includes(step.status)) {
        const error = new Error(`job step cannot be completed from status ${step.status}`)
        error.code = 'JOB_COMPLETION_STATUS_INVALID'
        error.statusCode = 409
        throw error
      }
      if (hasExplicitIncompleteStepOutput(step.output)) {
        const error = new Error(
          step.output.incompleteReason || 'job step still reports incomplete requirements',
        )
        error.code = 'JOB_COMPLETION_INCOMPLETE'
        error.statusCode = 409
        throw error
      }
      const completedAt = Date.now()
      // completeJobStep validates evidence before writing. Keep wake/checkpoint
      // cleanup after that gate so a rejected completion is entirely side-effect free.
      completeJobStep(stepId, {
        evidence,
        output: step.output || {},
        completedAt,
        userId,
      })
      cancelJobWake({ jobId, userId })
      runtime.runtimeCore.checkpoint.clear({ jobId, stepId, userId })
      const completedStep = runtime.getJob(jobId, { userId })?.steps.find((item) => item.id === stepId)
      const normalizedEvidence = Array.isArray(completedStep?.output?.evidence)
        ? completedStep.output.evidence
        : []
      completionEvents.push(appendJobEvent({
        jobId,
        type: 'step_completed',
        stepId,
        code: 'JOB_STEP_VERIFIED',
        params: {
          title: completedStep?.title || '',
          evidenceCount: normalizedEvidence.length,
        },
        payload: { evidenceCount: normalizedEvidence.length },
      }))
      const updated = runtime.getJob(jobId, { userId })
      terminalTransition = completeManualJobTransition({ jobId, userId, updated })
      if (terminalTransition.event) completionEvents.push(terminalTransition.event)
      completedJob = runtime.getJob(jobId, { userId })
      return true
    })
    if (!outcome?.owned) {
      const error = new Error('job completion lease was lost')
      error.code = 'JOB_COMPLETION_CONFLICT'
      error.statusCode = 409
      throw error
    }
    if (outcome.value) {
      for (const event of completionEvents) runtime.emit(event)
      if (terminalTransition?.terminal) {
        notifyJobTerminal({
          ...completedJob,
          error: terminalTransition.error,
        }, {
          status: terminalTransition.status,
          body: terminalTransition.message,
          payload: terminalTransition.payload,
        })
        notifyJobStopHook(completedJob, {
          status: terminalTransition.status,
          error: terminalTransition.error,
          stepId,
        })
      }
    }
    return outcome.value ? completedJob : null
  } finally {
    completionLease.release()
  }
}

export function retryRuntimeStep(runtime, jobId, stepId, {
  userId,
  resetBudget = true,
  preserveModelSnapshot = false,
  automatic = false,
  autoRetryWake = null,
} = {}) {
  let job = runtime.getJob(jobId, { userId })
  let step = job?.steps.find((item) => item.id === stepId)
  if (!job || !step) return null
  assertJobPlanRetryAllowed(job, step)
  let deliveryRecoverySteps = deliveryProjectionRecoverySteps(job)
  let deliveryRecoveryStepIds = new Set(deliveryRecoverySteps.map((item) => item.id))
  if (!RETRYABLE_JOB_STATUSES.has(job.status)
    || (!RETRYABLE_STEP_STATUSES.has(step.status)
      && !hasRejectedCompletedOutcome(step)
      && !deliveryRecoveryStepIds.has(step.id))) {
    const detail = job.status === 'failed' && step.status === 'completed'
      ? '; completed mutation steps are not replayed automatically—retry the verify/finalize stage or the whole job'
      : ''
    throw retryStatusError(
      'JOB_STEP_RETRY_STATUS_INVALID',
      `job step cannot be retried from ${job.status}/${step.status}${detail}`,
    )
  }
  const retryLease = !runtime.activeControllers.has(jobId)
    ? runtime.runtimeCore.lease.acquire({ jobId })
    : null
  if (!retryLease) {
    const error = new Error('job retry is already active')
    error.code = 'JOB_RETRY_CONFLICT'
    error.statusCode = 409
    throw error
  }
  try {
    job = runtime.getJob(jobId, { userId })
    step = job?.steps.find((item) => item.id === stepId)
    if (job && step) assertJobPlanRetryAllowed(job, step)
    const deliveryRetryBlocker = deliveryProjectionRetryBlocker(job)
    if (deliveryRetryBlocker) {
      throw retryStatusError('JOB_STEP_RETRY_STATUS_INVALID', deliveryRetryBlocker)
    }
    deliveryRecoverySteps = deliveryProjectionRecoverySteps(job)
    deliveryRecoveryStepIds = new Set(deliveryRecoverySteps.map((item) => item.id))
    if (!job || !step || !RETRYABLE_JOB_STATUSES.has(job.status)
      || (!RETRYABLE_STEP_STATUSES.has(step.status)
        && !hasRejectedCompletedOutcome(step)
        && !deliveryRecoveryStepIds.has(step.id))) {
      throw retryStatusError(
        'JOB_STEP_RETRY_STATUS_INVALID',
        `job step cannot be retried from ${job?.status || 'missing'}/${step?.status || 'missing'}`,
      )
    }
    const modelBinding = runtime.resolveModelBinding({
      userId,
      providerId: job.modelProviderId,
      modelName: job.modelName,
      ...(preserveModelSnapshot ? {
        configRevision: job.modelConfigRevision,
        requirePersistedBinding: true,
      } : {}),
    })
    const modelSnapshot = normalizeJobModelSnapshot({
      modelName: modelBinding.modelName,
      modelProviderId: modelBinding.providerId,
      modelConfigRevision: modelBinding.configRevision,
    })
    const retrySteps = deliveryRecoveryStepIds.has(step.id)
      ? deliveryRecoverySteps
      : [step]
    const diagnosticResetStepIds = deliveryProjectionDiagnosticResetStepIds(job, retrySteps)
    const checkpointsByStepId = new Map(retrySteps.map((retryStep) => [
      retryStep.id,
      loadRetryCheckpoint({
        runtimeCore: runtime.runtimeCore,
        jobId,
        stepId: retryStep.id,
        userId: job.userId,
        modelSnapshot,
      }),
    ]))
    const transition = retryJobTransition({
      jobId,
      userId,
      expectedJobStatus: job.status,
      steps: retrySteps,
      completedRetryStepIds: deliveryRecoverySteps
        .filter((item) => item.status === 'completed')
        .map((item) => item.id),
      diagnosticResetStepIds,
      modelSnapshot,
      autoRetryWake: automatic ? {
        stepId,
        wakeAt: autoRetryWake?.wakeAt,
        claimedAt: autoRetryWake?.firedAt,
        retryAttempt: autoRetryWake?.retryAttempt,
        claimToken: autoRetryWake?.claimToken,
      } : null,
      validateRetry: automatic ? () => {
        if (!hasUnresolvedJobStepSideEffects({ userId, jobId, stepId })) return
        throw retryStatusError(
          'JOB_AUTO_RETRY_SIDE_EFFECT_UNKNOWN',
          'automatic retry is blocked by an unresolved durable side effect',
        )
      } : null,
      prepareCheckpoints: () => {
        // Preserve completed calls, results, and idempotency keys. Ordinary
        // retries get a fresh budget; manually reconciled paid responses keep
        // their counters. This is transactional with the retry state change.
        for (const retryStep of retrySteps) {
          makeRetryCheckpointResumable({
            runtimeCore: runtime.runtimeCore,
            checkpoint: checkpointsByStepId.get(retryStep.id),
            jobId,
            stepId: retryStep.id,
            userId,
            resetBudget,
          })
        }
      },
      event: buildJobRetryEvent({ job, step, modelSnapshot, automatic }),
    })
    if (!transition.changed) {
      const error = new Error(`job step cannot be retried from ${transition.status || 'missing'}/${step.status}`)
      error.code = 'JOB_STEP_RETRY_STATUS_INVALID'
      error.statusCode = 409
      throw error
    }
    runtime.emit(transition.event)
    return runtime.getJob(jobId, { userId })
  } finally {
    retryLease.release()
  }
}
