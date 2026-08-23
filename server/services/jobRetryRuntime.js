import {
  assertModelInvocationRetrySafe,
  normalizeModelInvocation,
} from './loop/modelInvocationCheckpoint.js'

function mustPreserveBudgetForManualModelResolution(checkpoint) {
  const invocation = normalizeModelInvocation(checkpoint?.state?.modelInvocation)
  return Boolean(
    ['completed', 'not_sent'].includes(invocation?.status)
    && invocation.reconciliation?.source === 'manual'
    && invocation.reconciliation.outcome === invocation.status
  )
}

export function loadRetryCheckpoint({
  runtimeCore,
  jobId,
  stepId,
  userId,
  modelSnapshot,
}) {
  const checkpoint = runtimeCore.checkpoint.load({ jobId, stepId, userId })
  assertModelInvocationRetrySafe(checkpoint?.state?.modelInvocation, {
    stepId,
    ...modelSnapshot,
  })
  return checkpoint
}

export function loadJobRetryCheckpoints({ runtimeCore, job, modelSnapshot }) {
  const checkpoints = new Map()
  for (const step of job.steps) {
    checkpoints.set(step.id, loadRetryCheckpoint({
      runtimeCore,
      jobId: job.id,
      stepId: step.id,
      userId: job.userId,
      modelSnapshot,
    }))
  }
  return checkpoints
}

export function makeRetryCheckpointResumable({
  runtimeCore,
  checkpoint,
  jobId,
  stepId,
  userId,
  resetBudget = true,
}) {
  return runtimeCore.checkpoint.makeResumable(
    { jobId, stepId, userId },
    {
      resetBudget: mustPreserveBudgetForManualModelResolution(checkpoint)
        ? false
        : resetBudget !== false,
    },
  )
}
