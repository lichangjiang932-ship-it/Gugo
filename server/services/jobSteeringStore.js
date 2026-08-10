import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

const MAX_STEERING_LENGTH = 20_000

function mapMessage(row) {
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

function ownedJobExists(db, jobId, userId) {
  return !!db.prepare('SELECT 1 FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)
}

export function enqueueJobSteering({ jobId, userId, content, now = Date.now() } = {}) {
  const text = String(content || '').trim()
  if (!jobId || !userId) throw new Error('jobId and userId are required')
  if (!text) throw new Error('steering content is required')
  if (text.length > MAX_STEERING_LENGTH) {
    throw new Error(`steering content exceeds ${MAX_STEERING_LENGTH} characters`)
  }
  const db = getDb()
  if (!ownedJobExists(db, jobId, userId)) return null
  const id = `steer-${randomUUID()}`
  db.prepare(`
    INSERT INTO job_steering_messages
      (id, job_id, user_id, content, status, created_at)
    VALUES (?, ?, ?, ?, 'queued', ?)
  `).run(id, jobId, userId, text, now)
  return mapMessage(db.prepare('SELECT * FROM job_steering_messages WHERE id = ?').get(id))
}

export function listJobSteering({ jobId, userId, status, limit = 100 } = {}) {
  if (!jobId || !userId) return []
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = status
    ? getDb().prepare(`
        SELECT * FROM job_steering_messages
        WHERE job_id = ? AND user_id = ? AND status = ?
        ORDER BY created_at, id LIMIT ?
      `).all(jobId, userId, status, safeLimit)
    : getDb().prepare(`
        SELECT * FROM job_steering_messages
        WHERE job_id = ? AND user_id = ?
        ORDER BY created_at, id LIMIT ?
      `).all(jobId, userId, safeLimit)
  return rows.map(mapMessage)
}

export function claimJobSteering({ jobId, userId, limit = 20, now = Date.now() } = {}) {
  if (!jobId || !userId) return { leaseId: null, messages: [] }
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20))
  const leaseId = `lease-${randomUUID()}`
  const db = getDb()
  return db.transaction(() => {
    if (!ownedJobExists(db, jobId, userId)) return { leaseId: null, messages: [] }
    db.prepare(`
      UPDATE job_steering_messages
      SET status = 'leased', lease_id = @leaseId, leased_at = @now
      WHERE id IN (
        SELECT id FROM job_steering_messages
        WHERE job_id = @jobId AND user_id = @userId AND status = 'queued'
        ORDER BY created_at, id LIMIT @limit
      )
    `).run({ leaseId, now, jobId, userId, limit: safeLimit })
    const messages = db.prepare(`
      SELECT * FROM job_steering_messages
      WHERE job_id = ? AND user_id = ? AND lease_id = ? AND status = 'leased'
      ORDER BY created_at, id
    `).all(jobId, userId, leaseId).map(mapMessage)
    return messages.length ? { leaseId, messages } : { leaseId: null, messages: [] }
  })()
}

export function acknowledgeJobSteering({ jobId, userId, leaseId, now = Date.now() } = {}) {
  if (!jobId || !userId || !leaseId) return 0
  return getDb().prepare(`
    UPDATE job_steering_messages
    SET status = 'consumed', consumed_at = ?, lease_id = NULL, leased_at = NULL
    WHERE job_id = ? AND user_id = ? AND lease_id = ? AND status = 'leased'
  `).run(now, jobId, userId, leaseId).changes
}

export function releaseJobSteeringLease({ jobId, userId, leaseId } = {}) {
  if (!jobId || !userId || !leaseId) return 0
  return getDb().prepare(`
    UPDATE job_steering_messages
    SET status = 'queued', lease_id = NULL, leased_at = NULL
    WHERE job_id = ? AND user_id = ? AND lease_id = ? AND status = 'leased'
  `).run(jobId, userId, leaseId).changes
}

/**
 * Internal startup recovery. Steering held by a live execution lease belongs
 * to another process and must not be made visible to a second model loop.
 */
export function releaseAllJobSteeringLeases({ now = Date.now() } = {}) {
  return getDb().prepare(`
    UPDATE job_steering_messages
    SET status = 'queued', lease_id = NULL, leased_at = NULL
    WHERE status = 'leased'
      AND NOT EXISTS (
        SELECT 1 FROM job_execution_leases AS lease
        WHERE lease.job_id = job_steering_messages.job_id
          AND lease.expires_at > ?
      )
  `).run(now).changes
}
