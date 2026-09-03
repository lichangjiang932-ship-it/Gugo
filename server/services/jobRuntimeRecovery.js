import { getLatestJobApproval } from './approvalStore.js'
import {
  appendJobEvent,
  getJob as getJobRow,
  listJobSteps,
  listRecoverableJobs,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { releaseAllJobSteeringLeases } from './jobSteeringStore.js'
import { clearResumedJobOutcomeDiagnostics } from './jobWorkflow.js'
import { latestPersistedOutcomeFields } from './jobRuntimeProjection.js'
import { hasValidPersistedJobIdentity } from './jobRuntimeIdentity.js'

const RECOVERABLE_STATUSES = new Set(['planning', 'running', 'awaiting_approval'])

function resetRunningSteps(jobId) {
  const runningSteps = listJobSteps(jobId).filter((step) => step.status === 'running')
  const diagnostics = latestPersistedOutcomeFields(runningSteps)
  for (const step of runningSteps) {
    updateJobStep(step.id, {
      status: 'queued',
      output: clearResumedJobOutcomeDiagnostics(step.output),
      error: null,
      startedAt: null,
      finishedAt: null,
    })
  }
  return diagnostics
}

function recoverOwnedJob(candidate, { cacheJobOwner, emit }) {
  const job = getJobRow(candidate.id)
  if (!job || !hasValidPersistedJobIdentity(job)) return null

  let event
  if (['planning', 'running'].includes(job.status)) {
    updateJob(job.id, { status: 'queued', error: null, finishedAt: null })
    const recoveredDiagnostics = resetRunningSteps(job.id)
    event = appendJobEvent({
      jobId: job.id,
      type: 'recovered',
      code: 'JOB_PROCESS_RESTART_RECOVERED',
      payload: {
        ...recoveredDiagnostics,
        reason: 'process_restart_recovery',
        nextAction: 'resume_execution',
      },
    })
  } else if (job.status === 'awaiting_approval') {
    const approval = getLatestJobApproval({ jobId: job.id, userId: job.userId })
    if (!approval || approval.status === 'pending') return null
    updateJob(job.id, { status: 'queued', error: null, finishedAt: null })
    const recoveredDiagnostics = resetRunningSteps(job.id)
    event = appendJobEvent({
      jobId: job.id,
      stepId: approval.stepId || null,
      type: 'approval_recovered',
      code: 'JOB_APPROVAL_RECOVERED',
      payload: {
        ...recoveredDiagnostics,
        approvalId: approval.id,
        decision: approval.status,
        reason: 'tool_approval_resolved',
        nextAction: 'resume_execution',
      },
    })
  } else {
    return null
  }

  cacheJobOwner(job.id, job.userId || null)
  emit(event)
  return { ...job, status: 'queued' }
}

export function recoverRuntimeJobs({ lease, cacheJobOwner, emit }) {
  releaseAllJobSteeringLeases()
  const recovered = []
  for (const candidate of listRecoverableJobs()) {
    if (!RECOVERABLE_STATUSES.has(candidate.status)) continue
    if (!hasValidPersistedJobIdentity(candidate)) continue
    const scope = { jobId: candidate.id }
    if (lease.isActive(scope)) continue
    const recoveryLease = lease.acquire(scope)
    if (!recoveryLease) continue
    try {
      const outcome = lease.runIfOwned(scope, () => recoverOwnedJob(candidate, {
        cacheJobOwner,
        emit,
      }))
      if (outcome?.owned && outcome.value) recovered.push(outcome.value)
    } finally {
      recoveryLease.release()
    }
  }
  return recovered
}
