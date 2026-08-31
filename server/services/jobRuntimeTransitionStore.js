import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { appendJobEvent } from './jobStore.js'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RETRYABLE_JOB_STATUSES = new Set(['failed', 'cancelled'])
const RETRYABLE_STEP_STATUSES = new Set(['failed', 'cancelled'])
const MAX_STEERING_LENGTH = 20_000

function parseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRetryableStepRow(row) {
  if (RETRYABLE_STEP_STATUSES.has(row?.status)) return true
  if (row?.status !== 'completed') return false
  const output = parseJson(row.output_json)
  if (row.kind === 'verify') {
    const verdict = String(output?.acceptance?.verdict || '').trim().toLowerCase()
    return Boolean(verdict && verdict !== 'pass')
  }
  return row.kind === 'finalize' && output?.complete === false
}

function cancelScheduledWake(db, { jobId, userId, now }) {
  return db.prepare(`
    UPDATE job_wakeups
       SET status = 'cancelled', updated_at = ?
     WHERE job_id = ? AND user_id = ? AND status = 'scheduled'
  `).run(now, jobId, userId).changes || 0
}

function mapSteeringMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    content: row.content,
    status: row.status,
    leaseId: row.lease_id || null,
    leasedAt: row.leased_at || null,
    consumedAt: row.consumed_at || null,
    createdAt: row.created_at,
  }
}

export function requestJobCancellationTransition({ jobId, userId, now = Date.now() } = {}) {
  if (!jobId || !userId) return { found: false, changed: false, status: null, event: null }
  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT status, cancel_requested FROM jobs WHERE id = ? AND user_id = ?
    `).get(jobId, userId)
    if (!current) return { found: false, changed: false, status: null, event: null }
    if (TERMINAL_JOB_STATUSES.has(current.status)) {
      return { found: true, changed: false, status: current.status, event: null }
    }

    let changed = false
    if (current.status !== 'cancel_requested' || current.cancel_requested !== 1) {
      changed = db.prepare(`
        UPDATE jobs
           SET status = 'cancel_requested', cancel_requested = 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = ?
      `).run(now, jobId, userId, current.status).changes === 1
      if (!changed) throw new Error('job cancellation lost its compare-and-swap race')
    }
    cancelScheduledWake(db, { jobId, userId, now })
    const event = changed
      ? appendJobEvent({
          jobId,
          type: 'cancel_requested',
          message: '已请求终止任务',
          payload: { code: 'JOB_CANCEL_REQUESTED', reason: 'user_requested' },
          now,
        })
      : null
    return { found: true, changed, status: 'cancel_requested', event }
  }).immediate()
}

export function enqueueJobSteeringTransition({ jobId, userId, content, now = Date.now() } = {}) {
  const text = String(content || '').trim()
  if (!jobId || !userId) throw new Error('jobId and userId are required')
  if (!text) throw new Error('steering content is required')
  if (text.length > MAX_STEERING_LENGTH) {
    throw new Error(`steering content exceeds ${MAX_STEERING_LENGTH} characters`)
  }

  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare('SELECT status FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)
    if (!current) return { found: false, accepted: false, reason: 'missing', message: null, requeued: false }
    if (TERMINAL_JOB_STATUSES.has(current.status) || current.status === 'cancel_requested') {
      return {
        found: true,
        accepted: false,
        reason: current.status === 'cancel_requested' ? 'cancelling' : 'terminal',
        message: null,
        requeued: false,
      }
    }

    if (current.status === 'waiting') {
      const latestSuspension = db.prepare(`
        SELECT type FROM job_events
         WHERE job_id = ? AND type IN ('plan_proposed', 'awaiting_user')
         ORDER BY id DESC LIMIT 1
      `).get(jobId)
      if (latestSuspension?.type === 'plan_proposed') {
        return {
          found: true,
          accepted: false,
          reason: 'plan_approval_required',
          message: null,
          requeued: false,
        }
      }
    }

    const id = `steer-${randomUUID()}`
    db.prepare(`
      INSERT INTO job_steering_messages
        (id, job_id, user_id, content, status, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?)
    `).run(id, jobId, userId, text, now)

    let requeued = false
    if (current.status === 'waiting') {
      requeued = db.prepare(`
        UPDATE jobs
           SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'waiting'
      `).run(now, jobId, userId).changes === 1
      if (!requeued) throw new Error('job steering wake lost its compare-and-swap race')
      cancelScheduledWake(db, { jobId, userId, now })
    }

    const message = mapSteeringMessage(
      db.prepare('SELECT * FROM job_steering_messages WHERE id = ?').get(id),
    )
    return { found: true, accepted: true, reason: null, message, requeued }
  }).immediate()
}

export function resumeJobAfterApprovalTransition({
  jobId,
  userId,
  stepId = null,
  leaseOwnerId,
  now = Date.now(),
} = {}) {
  if (!jobId || !userId || !leaseOwnerId) {
    return { found: false, owned: false, changed: false, status: null, event: null }
  }
  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare('SELECT status FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)
    if (!current) return { found: false, owned: false, changed: false, status: null, event: null }
    if (current.status !== 'awaiting_approval') {
      return { found: true, owned: false, changed: false, status: current.status, event: null }
    }
    const owned = !!db.prepare(`
      SELECT 1 FROM job_execution_leases
       WHERE job_id = ? AND owner_id = ? AND expires_at > ?
    `).get(jobId, leaseOwnerId, now)
    if (!owned) return { found: true, owned: false, changed: false, status: current.status, event: null }

    if (stepId) {
      const step = db.prepare('SELECT status FROM job_steps WHERE id = ? AND job_id = ?').get(stepId, jobId)
      if (!step) {
        return { found: true, owned: true, changed: false, status: current.status, event: null }
      }
      if (step.status === 'running') {
        db.prepare(`
          UPDATE job_steps
             SET status = 'queued', error = NULL, started_at = NULL,
                 finished_at = NULL, updated_at = ?
           WHERE id = ? AND job_id = ? AND status = 'running'
        `).run(now, stepId, jobId)
      }
    } else {
      db.prepare(`
        UPDATE job_steps
           SET status = 'queued', error = NULL, started_at = NULL,
               finished_at = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'running'
      `).run(now, jobId)
    }

    const changed = db.prepare(`
      UPDATE jobs
         SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'awaiting_approval'
    `).run(now, jobId, userId).changes === 1
    if (!changed) throw new Error('job approval resume lost its compare-and-swap race')
    const event = appendJobEvent({
      jobId,
      stepId,
      type: 'approval_recovered',
      message: 'Approval decided after process restart; the interrupted turn was requeued',
      now,
    })
    return { found: true, owned: true, changed: true, status: 'queued', event }
  }).immediate()
}

/**
 * Atomically requeue a failed/cancelled job and the selected retryable steps.
 * The caller may prepare checkpoints before this transition while holding the
 * job execution lease; expected statuses prevent that old snapshot from
 * overwriting a newer terminal or already-retried state.
 */
export function retryJobTransition({
  jobId,
  userId,
  expectedJobStatus,
  steps = [],
  modelSnapshot,
  event,
  prepareCheckpoints = null,
  now = Date.now(),
} = {}) {
  if (!jobId || !userId) throw new Error('retryJobTransition requires jobId and userId')
  if (!RETRYABLE_JOB_STATUSES.has(expectedJobStatus)) {
    throw new Error('retryJobTransition requires a retryable expected job status')
  }
  if (!modelSnapshot?.modelName) throw new Error('retryJobTransition requires a model snapshot')
  if (!event?.type || !event?.message) throw new Error('retryJobTransition requires an event')
  if (prepareCheckpoints != null && typeof prepareCheckpoints !== 'function') {
    throw new Error('retryJobTransition prepareCheckpoints must be a function')
  }

  const targets = steps.map((step) => ({
    id: String(step?.id || '').trim(),
    status: String(step?.status || '').trim(),
  }))
  if (targets.some((step) => !step.id || !step.status)
    || new Set(targets.map((step) => step.id)).size !== targets.length) {
    throw new Error('retryJobTransition requires unique step identities and expected statuses')
  }

  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT status FROM jobs WHERE id = ? AND user_id = ?
    `).get(jobId, userId)
    if (!current) return { found: false, changed: false, status: null, event: null }
    if (current.status !== expectedJobStatus || !RETRYABLE_JOB_STATUSES.has(current.status)) {
      return { found: true, changed: false, status: current.status, event: null }
    }

    const readStep = db.prepare(`
      SELECT id, status, kind, output_json
        FROM job_steps
       WHERE id = ? AND job_id = ?
    `)
    const currentSteps = targets.map((target) => ({
      target,
      row: readStep.get(target.id, jobId),
    }))
    if (currentSteps.some(({ target, row }) => (
      !row || row.status !== target.status || !isRetryableStepRow(row)
    ))) {
      return { found: true, changed: false, status: current.status, event: null }
    }

    // Checkpoint terminal markers and durable retry state must change in the
    // same transaction. Cancellation deliberately bypasses the execution
    // lease; preparing checkpoints before this transaction could otherwise
    // mutate a failed checkpoint and then lose the job-status CAS to cancel.
    prepareCheckpoints?.()

    const requeueStep = db.prepare(`
      UPDATE job_steps
         SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND job_id = ? AND status = ?
    `)
    for (const { target } of currentSteps) {
      if (requeueStep.run(now, target.id, jobId, target.status).changes !== 1) {
        throw new Error('job retry step lost its compare-and-swap race')
      }
    }

    cancelScheduledWake(db, { jobId, userId, now })
    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM job_steps
       WHERE job_id = ?
    `).get(jobId)
    const total = Number(counts?.total) || 0
    const completed = Number(counts?.completed) || 0
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0
    const changed = db.prepare(`
      UPDATE jobs
         SET status = 'queued', progress = ?, cancel_requested = 0,
             model_name = ?, model_provider_id = ?, model_config_revision = ?,
             error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = ?
    `).run(
      progress,
      modelSnapshot.modelName,
      modelSnapshot.modelProviderId ?? null,
      modelSnapshot.modelConfigRevision ?? null,
      now,
      jobId,
      userId,
      expectedJobStatus,
    ).changes === 1
    if (!changed) throw new Error('job retry lost its compare-and-swap race')

    const persistedEvent = appendJobEvent({
      jobId,
      stepId: event.stepId || null,
      type: event.type,
      message: event.message,
      payload: event.payload ?? null,
      now,
    })
    return { found: true, changed: true, status: 'queued', event: persistedEvent }
  }).immediate()
}
