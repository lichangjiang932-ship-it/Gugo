import { dispatchHooks } from './hooksService.js'
import { createNotification } from './notificationsStore.js'
import { appendJobEvent, getJob as getJobRow, updateJob } from './jobStore.js'

const RECOVERABLE_JOB_STATUSES = new Set(['planning', 'running'])

export function markJobAwaitingApproval(job) {
  if (!job?.id) return
  try {
    updateJob(job.id, { status: 'awaiting_approval' })
    appendJobEvent({
      jobId: job.id,
      type: 'awaiting_approval',
      message: '等待用户批准一个工具调用',
    })
  } catch (error) {
    console.error('[jobs] 标记 awaiting_approval 失败:', error?.stack || error)
  }
}

export function markJobRunningAgain(job) {
  if (!job?.id) return
  try {
    const fresh = getJobRow(job.id)
    if (fresh?.status === 'awaiting_approval') {
      updateJob(job.id, { status: 'running' })
    }
  } catch (error) {
    console.error('[jobs] 恢复 running 状态失败:', error?.stack || error)
  }
}

export function notifyJobTerminal(job, { status, body }) {
  if (!job?.id || !job.userId) return
  try {
    createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body,
      link: `/task?job=${encodeURIComponent(job.id)}`,
      data: {
        jobId: job.id,
        status,
        error: job.error || null,
      },
    })
  } catch (error) {
    console.error('[jobs] notification failed:', error?.stack || error)
  }
}

export function notifyJobStopHook(job, { status, error = null, stepId = null } = {}) {
  if (!job?.id || !job.userId) return
  dispatchHooks({
    userId: job.userId,
    event: 'stop',
    tool: 'job',
    args: { jobId: job.id, status, ...(error ? { error } : {}) },
    sessionId: job.id,
    requestId: stepId,
  }).catch(() => {})
}

export function lostJobExecutionLease(signal, error = null) {
  return error?.code === 'JOB_EXECUTION_LEASE_LOST'
    || signal?.reason?.code === 'JOB_EXECUTION_LEASE_LOST'
}

export function runOwnedJobTransition(executionLeases, jobId, callback) {
  if (typeof executionLeases?.runIfOwned === 'function') {
    return executionLeases.runIfOwned(jobId, callback)?.owned === true
  }
  if (typeof executionLeases?.owns === 'function' && !executionLeases.owns(jobId)) return false
  callback()
  return true
}

export function recoverInterruptedJobs(jobs = []) {
  return jobs
    .filter((job) => RECOVERABLE_JOB_STATUSES.has(job.status))
    .map((job) => ({ ...job, status: 'queued' }))
}
