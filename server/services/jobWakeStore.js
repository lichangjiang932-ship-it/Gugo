import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import {
  clearResumedJobOutcomeDiagnostics,
  persistedJobOutcomeFields,
} from './jobWorkflow.js'

export const DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS = 30_000

// SQLite trim(value) only removes U+0020. Keep claim eligibility aligned with
// JavaScript String#trim, which is the persisted runtime identity contract.
const SQLITE_RUNTIME_IDENTITY_TRIM_CHARS = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'

function validRuntimeIdentitySql(column) {
  return `typeof(${column}) = 'text' AND trim(${column}, ${SQLITE_RUNTIME_IDENTITY_TRIM_CHARS}) <> ''`
}

function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function mapWake(row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    stepId: row.step_id,
    userId: row.user_id,
    wakeAt: row.wake_at,
    kind: row.wake_kind || 'resume',
    reason: row.reason || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firedAt: row.fired_at ?? null,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.retry_attempt == null ? {} : { retryAttempt: Number(row.retry_attempt) }),
    ...(row.diagnostics && Object.keys(row.diagnostics).length > 0
      ? { diagnostics: row.diagnostics }
      : {}),
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

export function scheduleJobWake({
  jobId,
  stepId,
  userId,
  wakeAt,
  reason = null,
  wakeKind = 'resume',
  now = Date.now(),
} = {}) {
  const timestamp = Number(wakeAt)
  if (!Number.isFinite(timestamp)) throw new Error('wakeAt must be finite')
  if (!['resume', 'auto_retry'].includes(wakeKind)) throw new Error('invalid job wake kind')
  if (!ownsStep({ jobId, stepId, userId })) return null
  getDb().prepare(`
    INSERT INTO job_wakeups
      (job_id, step_id, user_id, wake_at, reason, wake_kind, status, created_at, updated_at, fired_at, claim_token)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, NULL, NULL)
    ON CONFLICT(job_id) DO UPDATE SET
      step_id = excluded.step_id,
      user_id = excluded.user_id,
      wake_at = excluded.wake_at,
      reason = excluded.reason,
      wake_kind = excluded.wake_kind,
      status = 'scheduled',
      updated_at = excluded.updated_at,
      fired_at = NULL,
      claim_token = NULL
  `).run(jobId, stepId, userId, timestamp, reason, wakeKind, now, now)
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
       SET status = 'cancelled', claim_token = NULL, updated_at = ?
     WHERE job_id = ? AND user_id = ?
       AND (status = 'scheduled' OR (status = 'fired' AND claim_token IS NOT NULL))
  `).run(now, jobId, userId).changes || 0
}

export function cancelClaimedAutoRetryWake({
  jobId,
  stepId,
  userId,
  wakeAt,
  claimedAt,
  retryAttempt,
  claimToken,
  now = Date.now(),
} = {}) {
  const wakeTimestamp = Number(wakeAt)
  const claimTimestamp = Number(claimedAt)
  const attempt = Number(retryAttempt)
  if (!jobId || !stepId || !userId
    || !Number.isFinite(wakeTimestamp)
    || !Number.isFinite(claimTimestamp)
    || !Number.isInteger(attempt)) return 0
  return getDb().prepare(`
    UPDATE job_wakeups
       SET status = 'cancelled', claim_token = NULL, updated_at = ?
     WHERE job_id = ? AND step_id = ? AND user_id = ?
       AND wake_kind = 'auto_retry' AND status = 'fired' AND claim_token = ?
       AND wake_at = ? AND fired_at = ?
       AND EXISTS (
         SELECT 1
           FROM jobs AS job
           JOIN job_steps AS step
             ON step.id = job_wakeups.step_id AND step.job_id = job.id
          WHERE job.id = job_wakeups.job_id AND job.user_id = job_wakeups.user_id
            AND job.status = 'failed' AND job.cancel_requested = 0
            AND job.auto_retry_attempts = ? AND step.status = 'failed'
       )
  `).run(
    now,
    jobId,
    stepId,
    userId,
    claimToken,
    wakeTimestamp,
    claimTimestamp,
    attempt,
  ).changes || 0
}

export function claimDueJobWakes({
  now = Date.now(),
  limit = 100,
  autoRetryClaimMs = DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS,
} = {}) {
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const claimMs = Math.max(1_000, Number(autoRetryClaimMs) || DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS)
  const staleClaimAt = now - claimMs
  const db = getDb()
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT wake.*, step.output_json AS step_output_json,
             job.auto_retry_attempts AS retry_attempt
        FROM job_wakeups AS wake
        JOIN job_steps AS step
          ON step.id = wake.step_id AND step.job_id = wake.job_id
        JOIN jobs AS job
          ON job.id = wake.job_id AND job.user_id = wake.user_id
       WHERE ${validRuntimeIdentitySql('wake.job_id')}
         AND ${validRuntimeIdentitySql('wake.user_id')}
         AND ${validRuntimeIdentitySql('job.id')}
         AND ${validRuntimeIdentitySql('job.user_id')}
         AND (
           (wake.status = 'scheduled' AND wake.wake_at <= ?)
           OR (
             wake.wake_kind = 'auto_retry' AND wake.status = 'fired'
             AND wake.claim_token IS NOT NULL
             AND wake.fired_at IS NOT NULL AND wake.fired_at <= ?
             AND step.status = 'failed' AND job.status = 'failed'
             AND job.cancel_requested = 0
           )
         )
       ORDER BY wake.wake_at ASC LIMIT ?
    `).all(now, staleClaimAt, capped)
    const claimed = []
    const requeueStep = db.prepare(`
      UPDATE job_steps
         SET status = 'queued', output_json = ?, error = NULL, started_at = NULL,
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
         SET status = 'fired', claim_token = ?, fired_at = ?, updated_at = ?
       WHERE job_id = ? AND step_id = ? AND user_id = ?
         AND ${validRuntimeIdentitySql('job_id')}
         AND ${validRuntimeIdentitySql('user_id')}
         AND status = 'scheduled' AND wake_at <= ? AND wake_at = ?
    `)
    const cancelStale = db.prepare(`
      UPDATE job_wakeups
         SET status = 'cancelled', claim_token = NULL, updated_at = ?
       WHERE job_id = ? AND step_id = ? AND user_id = ? AND status = 'scheduled'
    `)
    const armAutoRetry = db.prepare(`
      UPDATE jobs
         SET status = 'failed', updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'waiting'
         AND EXISTS (
           SELECT 1 FROM job_steps
            WHERE id = ? AND job_id = jobs.id AND status = 'failed'
         )
    `)
    const autoRetryIsRecoverable = db.prepare(`
      SELECT 1
        FROM jobs AS job
        JOIN job_steps AS step
          ON step.id = ? AND step.job_id = job.id
       WHERE job.id = ? AND job.user_id = ? AND job.auto_retry_attempts = ?
         AND job.status = 'failed' AND job.cancel_requested = 0
         AND step.status = 'failed'
    `)
    const reclaimAutoRetry = db.prepare(`
      UPDATE job_wakeups
         SET claim_token = ?, fired_at = ?, updated_at = ?
       WHERE job_id = ? AND step_id = ? AND user_id = ?
         AND ${validRuntimeIdentitySql('job_id')}
         AND ${validRuntimeIdentitySql('user_id')}
         AND wake_kind = 'auto_retry' AND status = 'fired'
         AND claim_token = ?
         AND wake_at = ? AND fired_at = ?
         AND EXISTS (
           SELECT 1 FROM jobs
            WHERE id = job_wakeups.job_id AND user_id = job_wakeups.user_id
              AND auto_retry_attempts = ?
         )
    `)
    for (const row of rows) {
      if (row.wake_kind === 'auto_retry') {
        // fired_at is a durable claim lease. Concurrent schedulers cannot take
        // the same generation; a process exit leaves a stale, fenced claim for
        // a later runtime to recover without replaying a newer scheduled wake.
        armAutoRetry.run(now, row.job_id, row.user_id, row.step_id)
        const recoverable = autoRetryIsRecoverable.get(
          row.step_id,
          row.job_id,
          row.user_id,
          row.retry_attempt,
        )
        if (!recoverable) {
          cancelStale.run(now, row.job_id, row.step_id, row.user_id)
          continue
        }
        const claimToken = randomUUID()
        const claimedNow = row.status === 'scheduled'
          ? fire.run(
              claimToken,
              now,
              now,
              row.job_id,
              row.step_id,
              row.user_id,
              now,
              row.wake_at,
            ).changes === 1
          : reclaimAutoRetry.run(
              claimToken,
              now,
              now,
              row.job_id,
              row.step_id,
              row.user_id,
              row.claim_token,
              row.wake_at,
              row.fired_at,
              row.retry_attempt,
            ).changes === 1
        if (!claimedNow) continue
        claimed.push(mapWake({
          ...row,
          status: 'fired',
          claim_token: claimToken,
          fired_at: now,
          updated_at: now,
        }))
        continue
      }
      const previousOutput = parseJson(row.step_output_json)
      const diagnostics = persistedJobOutcomeFields(previousOutput)
      const resumedOutput = clearResumedJobOutcomeDiagnostics(previousOutput)
      requeueStep.run(
        resumedOutput == null ? null : JSON.stringify(resumedOutput),
        now,
        row.step_id,
        row.job_id,
        row.user_id,
      )
      const awakened = requeueJob.run(now, row.job_id, row.user_id, row.step_id).changes === 1
      if (!awakened) {
        cancelStale.run(now, row.job_id, row.step_id, row.user_id)
        continue
      }
      const fired = fire.run(
        null,
        now,
        now,
        row.job_id,
        row.step_id,
        row.user_id,
        now,
        row.wake_at,
      ).changes === 1
      if (!fired) throw new Error('job wake claim lost its compare-and-swap race')
      claimed.push(mapWake({
        ...row,
        diagnostics,
        status: 'fired',
        fired_at: now,
        updated_at: now,
      }))
    }
    return claimed
  }).immediate()
}
