import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const MAX_STEERING_LENGTH = 20_000

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
  if (!jobId || !userId) return { found: false, changed: false, status: null }
  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT status, cancel_requested FROM jobs WHERE id = ? AND user_id = ?
    `).get(jobId, userId)
    if (!current) return { found: false, changed: false, status: null }
    if (TERMINAL_JOB_STATUSES.has(current.status)) {
      return { found: true, changed: false, status: current.status }
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
    return { found: true, changed, status: 'cancel_requested' }
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
    if (TERMINAL_JOB_STATUSES.has(current.status)) {
      return { found: true, accepted: false, reason: 'terminal', message: null, requeued: false }
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
    return { found: false, owned: false, changed: false, status: null }
  }
  const db = getDb()
  return db.transaction(() => {
    const current = db.prepare('SELECT status FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)
    if (!current) return { found: false, owned: false, changed: false, status: null }
    if (current.status !== 'awaiting_approval') {
      return { found: true, owned: false, changed: false, status: current.status }
    }
    const owned = !!db.prepare(`
      SELECT 1 FROM job_execution_leases
       WHERE job_id = ? AND owner_id = ? AND expires_at > ?
    `).get(jobId, leaseOwnerId, now)
    if (!owned) return { found: true, owned: false, changed: false, status: current.status }

    if (stepId) {
      const step = db.prepare('SELECT status FROM job_steps WHERE id = ? AND job_id = ?').get(stepId, jobId)
      if (!step) {
        return { found: true, owned: true, changed: false, status: current.status }
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
    return { found: true, owned: true, changed: true, status: 'queued' }
  }).immediate()
}
