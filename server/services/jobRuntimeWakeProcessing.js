import { hasValidPersistedJobIdentity } from './jobRuntimeIdentity.js'

const DETERMINISTIC_AUTO_RETRY_BLOCKERS = new Set([
  'JOB_AUTO_RETRY_SIDE_EFFECT_UNKNOWN',
  'JOB_PLAN_APPROVAL_REQUIRED',
  'JOB_STEP_RETRY_STATUS_INVALID',
  'MODEL_AUTH_FAILED',
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_NOT_FOUND',
])

export function processJobRuntimeWakes(runtime, dependencies) {
  const {
    claimDueJobWakes,
    blockClaimedAutoRetryWakeTransition,
    appendJobEvent,
    getJobRow,
    isModelReadinessError,
  } = dependencies

  for (const wake of claimDueJobWakes()) {
    const wakeJob = getJobRow(wake.jobId)
    if (!hasValidPersistedJobIdentity(wakeJob) || wakeJob.userId !== wake.userId) continue
    runtime.cacheJobOwner(wake.jobId, wake.userId)
    if (wake.kind === 'auto_retry') {
      try {
        runtime.retryStep(wake.jobId, wake.stepId, {
          userId: wake.userId,
          resetBudget: false,
          preserveModelSnapshot: true,
          automatic: true,
          autoRetryWake: wake,
        })
      } catch (error) {
        if (error?.code === 'JOB_RETRY_CONFLICT') continue
        const current = getJobRow(wake.jobId, { userId: wake.userId })
        if (!current || current.cancelRequested
          || ['cancel_requested', 'cancelled', 'queued', 'planning', 'running', 'completed'].includes(current.status)) {
          continue
        }
        if (!DETERMINISTIC_AUTO_RETRY_BLOCKERS.has(error?.code)
          && !isModelReadinessError(error)) continue
        const blocked = blockClaimedAutoRetryWakeTransition({
          jobId: wake.jobId,
          stepId: wake.stepId,
          userId: wake.userId,
          wakeAt: wake.wakeAt,
          claimedAt: wake.firedAt,
          retryAttempt: wake.retryAttempt,
          claimToken: wake.claimToken,
          errorCode: error?.code || 'JOB_AUTO_RETRY_BLOCKED',
        })
        if (blocked.event) runtime.emit(blocked.event)
      }
      continue
    }
    runtime.emit(appendJobEvent({
      jobId: wake.jobId,
      stepId: wake.stepId,
      type: 'wake_fired',
      code: 'JOB_WAKE_FIRED',
      payload: {
        wakeAt: wake.wakeAt,
        ...(wake.diagnostics || {}),
        reason: wake.reason || wake.diagnostics?.reason || null,
        nextAction: 'resume_execution',
      },
    }))
  }
}
