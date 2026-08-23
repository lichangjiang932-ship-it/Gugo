import crypto from 'node:crypto'

import { assertUserDataMutationAllowed } from './userDataClearGuard.js'

export const DEFAULT_MANAGED_ATTACHMENT_UPLOAD_LEASE_MS = 60_000
const MAX_MANAGED_ATTACHMENT_UPLOAD_LEASE_MS = 60 * 60 * 1000

function uploadLeaseError(message, code = 'ATTACHMENT_UPLOAD_LEASE_LOST') {
  return Object.assign(new Error(message), {
    code,
    statusCode: 409,
  })
}

function safeTimestamp(value, field) {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return timestamp
}

function safePid(value = process.pid) {
  const pid = Number(value)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('leasePid must be a positive safe integer')
  return pid
}

function leaseIdentity(lease = {}) {
  const uploadId = String(lease.uploadId || '').trim()
  const userId = String(lease.userId || '').trim()
  const leaseOwner = String(lease.leaseOwner || '').trim()
  if (!uploadId || !userId || !leaseOwner) throw new TypeError('upload lease identity is incomplete')
  return {
    uploadId,
    userId,
    leaseOwner,
    leasePid: safePid(lease.leasePid),
  }
}

function leaseTableExists(db) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'managed_attachment_upload_leases'
  `).get()
}

export function managedAttachmentUploadLeaseDuration(value) {
  const duration = Number(value)
  if (!Number.isSafeInteger(duration) || duration < 1_000) {
    return DEFAULT_MANAGED_ATTACHMENT_UPLOAD_LEASE_MS
  }
  return Math.min(duration, MAX_MANAGED_ATTACHMENT_UPLOAD_LEASE_MS)
}

export function isManagedAttachmentUploadProcessAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function leaseIsActive(row, now, processIsAlive) {
  return Number(row.lease_expires_at) > now || processIsAlive(row.lease_pid)
}

export function listManagedAttachmentUploadBlockers({
  db,
  userId,
  now = Date.now(),
  processIsAlive = isManagedAttachmentUploadProcessAlive,
} = {}) {
  const ownerId = String(userId || '').trim()
  const timestamp = safeTimestamp(now, 'now')
  if (!ownerId || !leaseTableExists(db)) return []
  return db.prepare(`
    SELECT upload_id, lease_pid, lease_expires_at
    FROM managed_attachment_upload_leases
    WHERE user_id = ?
    ORDER BY updated_at DESC, upload_id ASC
  `).all(ownerId)
    .filter((row) => leaseIsActive(row, timestamp, processIsAlive))
    .map((row) => ({
      kind: 'attachment_upload',
      uploadId: row.upload_id,
    }))
}

/**
 * Must be called while the caller owns SQLite's write lock. Only an expired
 * lease whose process is also dead can be reclaimed; expiry alone is not
 * sufficient because a synchronous local operation may delay heartbeats.
 */
export function reapDeadManagedAttachmentUploadLeases({
  db,
  userId,
  now = Date.now(),
  processIsAlive = isManagedAttachmentUploadProcessAlive,
} = {}) {
  const ownerId = String(userId || '').trim()
  const timestamp = safeTimestamp(now, 'now')
  if (!ownerId || !leaseTableExists(db)) return 0
  const rows = db.prepare(`
    SELECT upload_id, lease_owner, lease_pid, lease_expires_at
    FROM managed_attachment_upload_leases
    WHERE user_id = ? AND lease_expires_at <= ?
  `).all(ownerId, timestamp)
  const remove = db.prepare(`
    DELETE FROM managed_attachment_upload_leases
    WHERE upload_id = ? AND user_id = ? AND lease_owner = ?
      AND lease_pid = ? AND lease_expires_at = ?
  `)
  let removed = 0
  for (const row of rows) {
    if (processIsAlive(row.lease_pid)) continue
    removed += remove.run(
      row.upload_id,
      ownerId,
      row.lease_owner,
      row.lease_pid,
      row.lease_expires_at,
    ).changes
  }
  return removed
}

export function acquireManagedAttachmentUploadLease({
  db,
  uploadId,
  userId,
  leaseOwner = `attachment-upload-${process.pid}-${crypto.randomUUID()}`,
  leasePid = process.pid,
  leaseMs = DEFAULT_MANAGED_ATTACHMENT_UPLOAD_LEASE_MS,
  now = Date.now(),
} = {}) {
  const identity = leaseIdentity({ uploadId, userId, leaseOwner, leasePid })
  const timestamp = safeTimestamp(now, 'now')
  const duration = managedAttachmentUploadLeaseDuration(leaseMs)
  const leaseExpiresAt = timestamp + duration
  if (!Number.isSafeInteger(leaseExpiresAt)) throw new TypeError('upload lease expiration is invalid')

  db.transaction(() => {
    assertUserDataMutationAllowed(
      db,
      identity.userId,
      'Attachments cannot be uploaded while local data is being cleared',
    )
    const existing = db.prepare(`
      SELECT upload_id, user_id, lease_owner, lease_pid, lease_expires_at
      FROM managed_attachment_upload_leases WHERE upload_id = ?
    `).get(identity.uploadId)
    if (existing) {
      if (leaseIsActive(existing, timestamp, isManagedAttachmentUploadProcessAlive)) {
        throw uploadLeaseError('An attachment upload with this ID is already active', 'ATTACHMENT_UPLOAD_IN_PROGRESS')
      }
      db.prepare(`
        DELETE FROM managed_attachment_upload_leases
        WHERE upload_id = ? AND user_id = ? AND lease_owner = ?
          AND lease_pid = ? AND lease_expires_at = ?
      `).run(
        existing.upload_id,
        existing.user_id,
        existing.lease_owner,
        existing.lease_pid,
        existing.lease_expires_at,
      )
    }
    db.prepare(`
      INSERT INTO managed_attachment_upload_leases
        (upload_id, user_id, lease_owner, lease_pid, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.uploadId,
      identity.userId,
      identity.leaseOwner,
      identity.leasePid,
      leaseExpiresAt,
      timestamp,
      timestamp,
    )
  }).immediate()

  return { ...identity, leaseMs: duration, leaseExpiresAt }
}

export function renewManagedAttachmentUploadLease({
  db,
  lease,
  leaseMs = lease?.leaseMs,
  now = Date.now(),
} = {}) {
  const identity = leaseIdentity(lease)
  const timestamp = safeTimestamp(now, 'now')
  const duration = managedAttachmentUploadLeaseDuration(leaseMs)
  const leaseExpiresAt = timestamp + duration
  if (!Number.isSafeInteger(leaseExpiresAt)) return false
  const renewed = db.prepare(`
    UPDATE managed_attachment_upload_leases
    SET lease_expires_at = ?, updated_at = ?
    WHERE upload_id = ? AND user_id = ? AND lease_owner = ? AND lease_pid = ?
  `).run(
    leaseExpiresAt,
    timestamp,
    identity.uploadId,
    identity.userId,
    identity.leaseOwner,
    identity.leasePid,
  )
  return renewed.changes === 1
}

export function releaseManagedAttachmentUploadLease({ db, lease } = {}) {
  const identity = leaseIdentity(lease)
  return db.prepare(`
    DELETE FROM managed_attachment_upload_leases
    WHERE upload_id = ? AND user_id = ? AND lease_owner = ? AND lease_pid = ?
  `).run(
    identity.uploadId,
    identity.userId,
    identity.leaseOwner,
    identity.leasePid,
  ).changes === 1
}

export function finalizeManagedAttachmentUploadLease({ db, lease, commit } = {}) {
  if (typeof commit !== 'function') throw new TypeError('commit must be a function')
  const identity = leaseIdentity(lease)
  return db.transaction(() => {
    assertUserDataMutationAllowed(
      db,
      identity.userId,
      'Attachments cannot be uploaded while local data is being cleared',
    )
    const owned = db.prepare(`
      SELECT 1 FROM managed_attachment_upload_leases
      WHERE upload_id = ? AND user_id = ? AND lease_owner = ? AND lease_pid = ?
    `).get(
      identity.uploadId,
      identity.userId,
      identity.leaseOwner,
      identity.leasePid,
    )
    if (!owned) throw uploadLeaseError('The attachment upload lease was lost before commit')
    const result = commit()
    const released = releaseManagedAttachmentUploadLease({ db, lease: identity })
    if (!released) throw uploadLeaseError('The attachment upload lease changed before commit')
    return result
  }).immediate()
}

export function holdManagedAttachmentUploadLease({
  db,
  lease,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const duration = managedAttachmentUploadLeaseDuration(lease?.leaseMs)
  let stopped = false
  let failure = null
  const tick = () => {
    if (stopped || failure) return
    try {
      if (!renewManagedAttachmentUploadLease({ db, lease, leaseMs: duration, now: now() })) {
        failure = uploadLeaseError('The attachment upload lease was lost while writing')
      }
    } catch (error) {
      const code = String(error?.code || '')
      if (!code.startsWith('SQLITE_BUSY')) failure = error
    }
  }
  const timer = setIntervalFn(tick, Math.max(250, Math.floor(duration / 3)))
  timer?.unref?.()
  return {
    assertActive() {
      if (failure) throw failure
    },
    stop() {
      if (stopped) return
      stopped = true
      clearIntervalFn(timer)
    },
  }
}
