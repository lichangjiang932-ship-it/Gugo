import {
  buildFinalOutput,
  clearResumedJobOutcomeDiagnostics,
} from './jobWorkflow.js'

export const RETRYABLE_STEP_STATUSES = new Set(['failed', 'cancelled'])

const COMPLETED_TASK_VERIFICATION_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

export function hasRejectedCompletedOutcome(step) {
  if (step?.status !== 'completed') return false
  if (step.kind === 'verify') {
    const verdict = String(step.output?.acceptance?.verdict || '').trim().toLowerCase()
    return verdict && verdict !== 'pass'
  }
  return step.kind === 'finalize' && step.output?.complete === false
}

export function hasExplicitIncompleteStepOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  if (output.complete === false || String(output.incompleteReason || '').trim()) return true
  if (Array.isArray(output.missingRequirements) && output.missingRequirements.length > 0) return true
  const verification = output.taskVerification
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false
  return (Array.isArray(verification.checks) ? verification.checks : []).some((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return true
    return !COMPLETED_TASK_VERIFICATION_STATUSES.has(String(check.status || '').trim().toLowerCase())
  })
}

export function uniqueJobSteps(steps = []) {
  return [...new Map(
    steps.filter((step) => step?.id).map((step) => [step.id, step]),
  ).values()]
}

function hasDeliveryProjectionFailure(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  if (job?.status !== 'failed' || !steps.length) return false
  const finalize = [...steps].reverse().find((step) => step.kind === 'finalize')
  const allStepsCompleted = steps.every((step) => step.status === 'completed')
  return finalize?.output?.complete === false
    || (allStepsCompleted && buildFinalOutput(job).complete === false)
}

export function deliveryProjectionRecoverySteps(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  if (!hasDeliveryProjectionFailure(job)) return []
  const verify = [...steps].reverse().find((step) => step.kind === 'verify')
  const finalize = [...steps].reverse().find((step) => step.kind === 'finalize')
  const priorMutationStepsSettled = steps.every((step) => (
    ['verify', 'finalize'].includes(step.kind) || step.status === 'completed'
  ))
  if (!verify || !priorMutationStepsSettled) return []

  // Verification is the safe repair stage: its prompt permits inspecting and
  // correcting prior work. Finalize must then run again so stale delivery
  // diagnostics cannot immediately return the job to failed. Completed execute
  // steps are intentionally not replayed because they may contain mutations.
  return uniqueJobSteps([verify, finalize].filter((step) => (
    step?.status === 'completed' || RETRYABLE_STEP_STATUSES.has(step?.status)
  )))
}

export function deliveryProjectionDiagnosticResetStepIds(job, retrySteps) {
  if (!hasDeliveryProjectionFailure(job)) return []
  const retryStepIds = new Set(retrySteps.map((step) => step.id))
  return (Array.isArray(job?.steps) ? job.steps : [])
    .filter((step) => {
      if (step?.status !== 'completed' || retryStepIds.has(step.id)) return false
      const output = step.output && typeof step.output === 'object' && !Array.isArray(step.output)
        ? step.output
        : null
      if (!output) return false
      const resumed = clearResumedJobOutcomeDiagnostics(output)
      return Object.keys(output).some((key) => !Object.hasOwn(resumed, key))
    })
    .map((step) => step.id)
}

export function retryStatusError(code, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = 409
  return error
}

export function deliveryProjectionRetryBlocker(job) {
  if (!hasDeliveryProjectionFailure(job)) return null
  const verify = [...job.steps].reverse().find((step) => step.kind === 'verify')
  if (!verify) {
    return 'job delivery cannot be retried safely because the persisted plan has no verify stage; completed mutation steps were not replayed'
  }
  if (!['queued', 'pending', 'completed', 'failed', 'cancelled'].includes(verify.status)) {
    return `job delivery cannot be retried because verify stage is not recoverable from status ${verify.status}`
  }
  return null
}

export function assertRetryHasRunnablePath(job, retrySteps) {
  if (retrySteps.length > 0) return
  const hasQueuedWork = job.steps.some((step) => ['queued', 'pending'].includes(step.status))
  if (hasQueuedWork) return
  throw retryStatusError(
    'JOB_RETRY_STATUS_INVALID',
    'job has no retryable step; completed mutation steps cannot be replayed safely and no verify/finalize recovery stage is available',
  )
}
