import crypto from 'node:crypto'
import { appendJobEvent, getJobWithChildren, listJobs } from './jobStore.js'
import { projectJobForClient } from './jobRuntimeProjection.js'
import {
  enqueueJobSteeringTransition,
  requestJobCancellationTransition,
  resumeJobAfterApprovalTransition,
} from './jobRuntimeTransitionStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import { resumeJobDirectoryAuthorization } from './jobDirectoryAuthorization.js'
import { userCancellationError } from '../utils/toolCancellation.js'
import {
  normalizeJobModelSnapshot,
  persistGuardedGeneratedPlan,
  persistGuardedStructuredPlan,
} from './jobPlanPolicyRuntime.js'
import { approveRuntimeJobPlan } from './jobPlanApprovalRuntime.js'
import { wrapJobModelFailure } from './jobModelFailure.js'

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

export async function createRuntimeJob(runtime, prompt, options = {}) {
  const {
    userId,
    requirePlanApproval = false,
    sourceType = null,
    sourceId = null,
    grants = [],
    autoRetry = false,
  } = options
  if (!userId) throw new Error('createJob requires userId')
  const binding = runtime.resolveModelBinding({
    userId,
    providerId: options.modelProviderId,
    modelName: options.modelName,
    configRevision: options.modelConfigRevision,
    env: options.env || process.env,
  })
  const modelSnapshot = normalizeJobModelSnapshot({
    modelName: binding.modelName,
    modelProviderId: binding.providerId,
    modelConfigRevision: binding.configRevision,
  })
  let plan
  try {
    plan = await runtime.planner(prompt, {
      userId,
      modelName: modelSnapshot.modelName,
      modelProviderId: modelSnapshot.modelProviderId,
      modelConfigRevision: modelSnapshot.modelConfigRevision,
      modelEnv: binding.env,
    })
  } catch (error) {
    const modelFailure = wrapJobModelFailure(error, modelSnapshot)
    throw modelFailure || error
  }
  const id = newId('job')
  const { event } = await persistGuardedGeneratedPlan({
    id, userId, prompt, sourceType, sourceId, grants, autoRetry,
    plan,
    ...modelSnapshot,
    requirePlanApproval,
    taskPlanGuard: runtime.taskPlanGuard,
  })
  runtime.jobUserCache.set(id, userId)
  runtime.emit(event)
  return runtime.getJob(id, { userId })
}

export function listRuntimeJobs(runtime, { userId } = {}) {
  return listJobs({ userId }).map((job) => projectJobForClient(
    getJobWithChildren(job.id, { userId }),
  ))
}

export function getRuntimeJob(_runtime, id, { userId } = {}) {
  return projectJobForClient(getJobWithChildren(id, { userId }))
}

export function steerRuntimeJob(runtime, jobId, { userId, content } = {}) {
  const transition = enqueueJobSteeringTransition({ jobId, userId, content })
  if (!transition.found) return null
  if (!transition.accepted) {
    return {
      accepted: false,
      error: transition.reason === 'plan_approval_required'
        ? 'approve the proposed plan before steering execution'
        : transition.reason === 'cancelling'
          ? 'job cancellation has already been requested'
          : 'job is already finished',
      job: runtime.getJob(jobId, { userId }),
    }
  }
  const { message } = transition
  if (transition.requeued) {
    runtime.emit(appendJobEvent({
      jobId,
      stepId: transition.resumedStepId || null,
      type: 'user_response_received',
      code: 'JOB_USER_RESPONSE_RECEIVED',
      payload: {
        steeringId: message.id,
        ...(transition.resumeDiagnostics || {}),
        nextAction: 'resume_execution',
      },
    }))
  }
  runtime.emit(appendJobEvent({
    jobId,
    type: 'steering_queued',
    code: 'JOB_STEERING_QUEUED',
    payload: { steeringId: message.id },
  }))
  return { accepted: true, message, job: runtime.getJob(jobId, { userId }) }
}

export function resumeRuntimeDirectoryAuthorization(runtime, jobId, options = {}) {
  const current = runtime.getJob(jobId, { userId: options.userId })
  if (!current) return null
  const recoveryLease = !runtime.activeControllers.has(jobId)
    ? runtime.runtimeCore.lease.acquire({ jobId })
    : null
  if (!recoveryLease) {
    return { resumed: false, error: 'job is currently active', job: current }
  }
  try {
    return resumeJobDirectoryAuthorization({
      jobId,
      ...options,
      getJob: runtime.getJob.bind(runtime),
      cancelJobWake,
      emit: runtime.emit.bind(runtime),
    })
  } finally {
    recoveryLease.release()
  }
}

export function approveRuntimePlan(runtime, jobId, {
  userId,
  steps = null,
  proposalEventId = null,
  planDigest = null,
} = {}) {
  return approveRuntimeJobPlan({
    jobId, userId, steps, proposalEventId, planDigest,
    getJob: runtime.getJob.bind(runtime),
    emit: runtime.emit.bind(runtime),
    createStepId: () => newId('step'),
  })
}

export function requestRuntimeJobCancel(runtime, jobId, { userId } = {}) {
  const transition = requestJobCancellationTransition({ jobId, userId })
  if (!transition.found) return null
  if (transition.status === 'cancel_requested') {
    runtime.activeControllers.get(jobId)?.abort(
      userCancellationError('JOB_CANCEL_REQUESTED', 'Cancelled by user'),
    )
  }
  if (!transition.changed) return runtime.getJob(jobId, { userId })
  runtime.emit(transition.event)
  return runtime.getJob(jobId, { userId })
}

export function resumeRuntimeAfterApproval(runtime, jobId, { userId, stepId = null } = {}) {
  const job = runtime.getJob(jobId, { userId })
  if (!job || job.status !== 'awaiting_approval') return job
  // In the original process the durable waiter will resume itself. Only a
  // restarted process, which has no active controller, needs requeueing.
  const scope = { jobId }
  if (runtime.activeControllers.has(jobId) || runtime.runtimeCore.lease.isActive(scope)) return job
  const recoveryLease = runtime.runtimeCore.lease.acquire(scope)
  if (!recoveryLease) return runtime.getJob(jobId, { userId })
  let transition
  try {
    transition = resumeJobAfterApprovalTransition({
      jobId,
      userId,
      stepId,
      leaseOwnerId: runtime.runtimeCore.lease.ownerId,
    })
  } finally {
    recoveryLease.release()
  }
  if (!transition.changed) return runtime.getJob(jobId, { userId })
  runtime.emit(transition.event)
  return runtime.getJob(jobId, { userId })
}

export async function createRuntimePlan(runtime, {
  userId,
  title,
  prompt,
  steps,
  modelName,
  modelProviderId = null,
  modelConfigRevision = null,
  env = process.env,
  autoRetry = false,
} = {}) {
  if (!userId) throw new Error('createPlan requires userId')
  const binding = runtime.resolveModelBinding({
    userId,
    providerId: modelProviderId,
    modelName,
    configRevision: modelConfigRevision,
    env,
  })
  const modelSnapshot = normalizeJobModelSnapshot({
    modelName: binding.modelName,
    modelProviderId: binding.providerId,
    modelConfigRevision: binding.configRevision,
  })
  const id = newId('job')
  const { event } = await persistGuardedStructuredPlan({
    id, userId, title, prompt, steps,
    autoRetry,
    ...modelSnapshot,
    taskPlanGuard: runtime.taskPlanGuard,
  })
  runtime.jobUserCache.set(id, userId)
  runtime.emit(event)
  return runtime.getJob(id, { userId })
}
