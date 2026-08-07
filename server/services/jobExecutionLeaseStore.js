import { getDb } from '../db.js'

export const DEFAULT_JOB_EXECUTION_LEASE_MS = 30_000

export function claimJobExecutionLease({
  jobId,
  ownerId,
  now = Date.now(),
  leaseMs = DEFAULT_JOB_EXECUTION_LEASE_MS,
} = {}) {
  if (!jobId || !ownerId) return false
  const expiresAt = now + Math.max(1_000, Number(leaseMs) || DEFAULT_JOB_EXECUTION_LEASE_MS)
  return getDb().transaction(() => {
    const result = getDb().prepare(`
      INSERT INTO job_execution_leases (job_id, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE job_execution_leases.owner_id = excluded.owner_id
         OR job_execution_leases.expires_at <= excluded.acquired_at
    `).run(jobId, ownerId, now, expiresAt)
    return result.changes === 1
  })()
}

export function renewJobExecutionLease({
  jobId,
  ownerId,
  now = Date.now(),
  leaseMs = DEFAULT_JOB_EXECUTION_LEASE_MS,
} = {}) {
  if (!jobId || !ownerId) return false
  const expiresAt = now + Math.max(1_000, Number(leaseMs) || DEFAULT_JOB_EXECUTION_LEASE_MS)
  return getDb().prepare(`
    UPDATE job_execution_leases
    SET expires_at = ?
    WHERE job_id = ? AND owner_id = ? AND expires_at > ?
  `).run(expiresAt, jobId, ownerId, now).changes === 1
}

export function releaseJobExecutionLease({ jobId, ownerId } = {}) {
  if (!jobId || !ownerId) return false
  return getDb().prepare(
    'DELETE FROM job_execution_leases WHERE job_id = ? AND owner_id = ?',
  ).run(jobId, ownerId).changes === 1
}

export function pruneExpiredJobExecutionLeases(now = Date.now()) {
  return getDb().prepare(
    'DELETE FROM job_execution_leases WHERE expires_at <= ?',
  ).run(now).changes
}
