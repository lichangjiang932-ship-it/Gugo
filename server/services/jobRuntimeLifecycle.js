import { dispatchHooks } from './hooksService.js'
import { createNotification } from './notificationsStore.js'
import { getDb } from '../db.js'
import { appendJobEvent, getJobWithChildren } from './jobStore.js'
import { buildFinalOutput, buildJobOutcomeDiagnostics } from './jobWorkflow.js'

const RECOVERABLE_JOB_STATUSES = new Set(['planning', 'running'])

export function markJobAwaitingApproval(job, step = null, approval = null) {
  if (!job?.id || !job.userId) return
  try {
    const db = getDb()
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE jobs
         SET status = 'awaiting_approval', updated_at = ?
         WHERE id = ? AND user_id = ? AND cancel_requested = 0
           AND status = 'running'
      `).run(Date.now(), job.id, job.userId).changes === 1
      if (!changed) return false
      const snapshot = getJobWithChildren(job.id, { userId: job.userId }) || job
      const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
        reason: 'tool_approval_required',
        nextAction: 'review_approval',
        status: 'awaiting_approval',
      })
      appendJobEvent({
        jobId: job.id,
        stepId: step?.id || null,
        type: 'awaiting_approval',
        message: '等待用户批准一个工具调用',
        payload: {
          ...diagnostics,
          approvalId: approval?.id || null,
        },
      })
      return true
    }).immediate()
  } catch (error) {
    console.error('[jobs] 标记 awaiting_approval 失败:', error?.stack || error)
  }
}

export function markJobRunningAgain(job, step = null, decision = null) {
  if (!job?.id || !job.userId) return
  try {
    const db = getDb()
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE jobs
           SET status = 'running', updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'awaiting_approval'
           AND cancel_requested = 0
      `).run(Date.now(), job.id, job.userId).changes === 1
      if (!changed) return false
      appendJobEvent({
        jobId: job.id,
        stepId: step?.id || null,
        type: 'approval_resolved',
        message: decision?.proceed === false
          ? '工具调用审批已拒绝；任务继续处理该结果'
          : '工具调用审批已解决；任务恢复执行',
        payload: {
          approvalId: decision?.approvalId || null,
          proceed: decision?.proceed !== false,
          reason: decision?.reason || (decision?.proceed === false ? 'approval_denied' : 'approval_granted'),
          nextAction: 'resume_execution',
        },
      })
      return true
    }).immediate()
  } catch (error) {
    console.error('[jobs] 恢复 running 状态失败:', error?.stack || error)
  }
}

function terminalNotificationPayload(job, { status, body, payload = null }) {
  const snapshot = getJobWithChildren(job.id, { userId: job.userId }) || job
  const normalizedStatus = status === 'completed'
    ? 'completed'
    : status === 'cancelled'
      ? 'cancelled'
      : 'failed'
  if (normalizedStatus === 'completed') {
    const delivery = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : buildFinalOutput(snapshot)
    if (delivery.complete === false) {
      const reason = String(
        delivery.reason || delivery.summary || delivery.incompleteReason || '任务未全部完成',
      ).trim()
      const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
        reason,
        nextAction: delivery.nextAction || 'retry_job',
        status: 'failed',
      })
      return {
        ...diagnostics,
        ...delivery,
        status: 'failed',
        complete: false,
        error: reason,
        nextAction: delivery.nextAction || diagnostics.nextAction,
      }
    }
    return {
      ...delivery,
      status: 'completed',
      complete: true,
      error: null,
    }
  }
  const reason = String(job.error || body || '').trim() || '任务未完成'
  const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
    reason,
    nextAction: payload?.nextAction || 'retry_job',
    status: normalizedStatus,
  })
  return {
    ...diagnostics,
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}),
    status: normalizedStatus,
    complete: false,
    error: reason,
  }
}

export function notifyJobTerminal(job, { status, body, payload = null }) {
  if (!job?.id || !job.userId) return
  try {
    const terminalPayload = terminalNotificationPayload(job, { status, body, payload })
    const notificationBody = terminalPayload.complete === false
      ? terminalPayload.reason || terminalPayload.incompleteReason || body
      : body
    createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body: notificationBody,
      link: `/task?job=${encodeURIComponent(job.id)}`,
      data: {
        jobId: job.id,
        ...terminalPayload,
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
    hookInvocationId: `job:${job.id}:stop:${stepId || status}`,
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
