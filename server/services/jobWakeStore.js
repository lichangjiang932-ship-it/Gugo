import { getDb } from '../db.js'

function mapWake(row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    stepId: row.step_id,
    userId: row.user_id,
    wakeAt: row.wake_at,
    reason: row.reason || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firedAt: row.fired_at || null,
  }
}

function ownsStep({ jobId, stepId, userId }) {
  if (!jobId || !stepId || !userId) return false
  return !!getDb().prepare(`
    SELECT 1
      FROM job_steps AS step
      JOIN jobs AS job ON job.id = step.job_id
     WHERE step.id = ? AND step.job_id = ? AND job.user_id = ?
  `).get(stepId, jobId, userId)
}

export function scheduleJobWake({ jobId, stepId, userId, wakeAt, reason = null, now = Date.now() } = {}) {
  const timestamp = Number(wakeAt)
  if (!Number.isFinite(timestamp)) throw new Error('wakeAt must be finite')
  if (!ownsStep({ jobId, stepId, userId })) return null
  getDb().prepare(`
    INSERT INTO job_wakeups
      (job_id, step_id, user_id, wake_at, reason, status, created_at, updated_at, fired_at)
    VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, NULL)
    ON CONFLICT(job_id) DO UPDATE SET
      step_id = excluded.step_id,
      user_id = excluded.user_id,
      wake_at = excluded.wake_at,
      reason = excluded.reason,
      status = 'scheduled',
      updated_at = excluded.updated_at,
      fired_at = NULL
  `).run(jobId, stepId, userId, timestamp, reason, now, now)
  return getJobWake({ jobId, userId })
}

export function getJobWake({ jobId, userId } = {}) {
  if (!jobId || !userId) return null
  return mapWake(getDb().prepare(`
    SELECT * FROM job_wakeups WHERE job_id = ? AND user_id = ?
  `).get(jobId, userId))
}

export function cancelJobWake({ jobId, userId, now = Date.now() } = {}) {
  if (!jobId || !userId) return 0
  return getDb().prepare(`
    UPDATE job_wakeups
       SET status = 'cancelled', updated_at = ?
     WHERE job_id = ? AND user_id = ? AND status = 'scheduled'
  `).run(now, jobId, userId).changes || 0
}

export function claimDueJobWakes({ now = Date.now(), limit = 100 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const db = getDb()
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM job_wakeups
       WHERE status = 'scheduled' AND wake_at <= ?
       ORDER BY wake_at ASC LIMIT ?
    `).all(now, capped)
    const claimed = []
    const requeueStep = db.prepare(`
      UPDATE job_steps
         SET status = 'queued', error = NULL, started_at = NULL,
             finished_at = NULL, updated_at = ?
       WHERE id = ? AND job_id = ? AND status IN ('queued', 'running')
         AND EXISTS (
           SELECT 1 FROM jobs
            WHERE id = job_steps.job_id AND user_id = ? AND status = 'waiting'
         )
    `)
    const requeueJob = db.prepare(`
      UPDATE jobs
         SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'waiting'
         AND EXISTS (
           SELECT 1 FROM job_steps
            WHERE id = ? AND job_id = jobs.id
         )
    `)
    const fire = db.prepare(`
      UPDATE job_wakeups
         SET status = 'fired', fired_at = ?, updated_at = ?
       WHERE job_id = ? AND step_id = ? AND user_id = ?
         AND status = 'scheduled' AND wake_at <= ?
    `)
    const cancelStale = db.prepare(`
      UPDATE job_wakeups
         SET status = 'cancelled', updated_at = ?
       WHERE job_id = ? AND step_id = ? AND user_id = ? AND status = 'scheduled'
    `)
    for (const row of rows) {
      requeueStep.run(now, row.step_id, row.job_id, row.user_id)
      const awakened = requeueJob.run(now, row.job_id, row.user_id, row.step_id).changes === 1
      if (!awakened) {
        cancelStale.run(now, row.job_id, row.step_id, row.user_id)
        continue
      }
      const fired = fire.run(now, now, row.job_id, row.step_id, row.user_id, now).changes === 1
      if (!fired) throw new Error('job wake claim lost its compare-and-swap race')
      claimed.push(mapWake({
        ...row,
        status: 'fired',
        fired_at: now,
        updated_at: now,
      }))
    }
    return claimed
  }).immediate()
}
