import { hasValidPersistedJobIdentity } from './jobRuntimeIdentity.js'

export function claimJobRuntimeTick(runtime, dependencies) {
  const {
    listRecoverableJobs,
    SUSPENDED_JOB_STATUSES,
    createJobTickBudgetScope,
    getJobRow,
    TERMINAL_JOB_STATUSES,
  } = dependencies
  const runnableJobs = listRecoverableJobs().filter((candidate) => (
    hasValidPersistedJobIdentity(candidate)
    && !SUSPENDED_JOB_STATUSES.has(candidate.status)
    && !runtime.activeJobIds.has(candidate.id)
  ))
  const candidates = [
    ...runnableJobs.filter((candidate) => candidate.status === 'cancel_requested'),
    ...runnableJobs.filter((candidate) => candidate.status === 'queued'),
    ...runnableJobs.filter((candidate) => !['cancel_requested', 'queued'].includes(candidate.status)),
  ]
  const job = candidates.find((candidate) => runtime.runtimeCore.lease.claim({ jobId: candidate.id }))
  if (!job) return null

  const tickBudget = createJobTickBudgetScope(job)
  const controller = new AbortController()
  runtime.activeJobIds.add(job.id)
  runtime.activeControllers.set(job.id, controller)
  const leaseScope = { jobId: job.id }
  const releaseExecutionLease = runtime.runtimeCore.lease.hold(leaseScope, controller)
  const commitOwned = (callback, { allowCancellation = false } = {}) => {
    const outcome = runtime.runtimeCore.lease.runIfOwned(leaseScope, () => {
      const current = getJobRow(job.id)
      if (!current) return false
      if (!allowCancellation
        && (current.cancelRequested || current.status === 'cancel_requested')) return false
      callback(current)
      return true
    })
    return outcome?.owned === true && outcome.value === true
  }
  const leaseIsOwned = () => runtime.runtimeCore.lease.owns(leaseScope)
  const release = () => {
    releaseExecutionLease()
    if (runtime.activeControllers.get(job.id) === controller) {
      runtime.activeControllers.delete(job.id)
    }
    runtime.activeJobIds.delete(job.id)
    const finalJob = getJobRow(job.id)
    if (finalJob && TERMINAL_JOB_STATUSES.has(finalJob.status)) tickBudget.release()
  }
  return Object.freeze({
    job,
    tickBudget,
    controller,
    leaseScope,
    commitOwned,
    leaseIsOwned,
    release,
  })
}
