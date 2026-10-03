import { assertModelInvocationRetrySafe } from './loop/modelInvocationCheckpoint.js'
import { isManuallyResolvedModelInvocation, readModelInvocationSlots } from './modelRequestInvocationSlots.js'

function mustPreserveBudgetForManualModelResolution(checkpoint) {
  return readModelInvocationSlots(checkpoint?.state)
    .some(({ invocation }) => isManuallyResolvedModelInvocation(invocation))
}

export function loadRetryCheckpoint({
  runtimeCore,
  jobId,
  stepId,
  userId,
  modelSnapshot,
}) {
  const checkpoint = runtimeCore.checkpoint.load({ jobId, stepId, userId })
  const binding = { stepId, ...modelSnapshot }
  for (const { invocation } of readModelInvocationSlots(checkpoint?.state, binding)) {
    assertModelInvocationRetrySafe(invocation, binding)
  }
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
  const resumed = runtimeCore.checkpoint.makeResumable(
    { jobId, stepId, userId },
    {
      resetBudget: mustPreserveBudgetForManualModelResolution(checkpoint)
        ? false
        : resetBudget !== false,
    },
  )
  if (checkpoint?.state && !resumed?.state) {
    const error = new Error('job retry checkpoint could not be made resumable')
    error.code = 'JOB_RETRY_CHECKPOINT_UPDATE_FAILED'
    throw error
  }
  if (checkpoint?.state?.final != null && resumed?.state?.final != null) {
    const error = new Error('job retry checkpoint retained its terminal result')
    error.code = 'JOB_RETRY_CHECKPOINT_UPDATE_FAILED'
    throw error
  }
  return resumed
}
