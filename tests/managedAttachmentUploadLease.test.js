import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-attachment-upload-lease-'))
const dataDir = path.join(suiteRoot, 'data')
const fallbackDir = path.join(suiteRoot, 'fallback')
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
process.env.CREDENTIAL_KEY_PATH = path.join(dataDir, '.credentials.key')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { createManagedAttachment } = await import('../server/services/managedAttachmentStore.js')
const {
  USER_DATA_CLEAR_CONFIRMATION,
  clearAuthoritativeUserData,
} = await import('../server/services/userDataGovernanceService.js')
const {
  activateTestCompactionArchivePort,
} = await import('./helpers/testCompactionArchivePort.js')

const db = getDb()
const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })

function createOwner(marker) {
  const userId = `attachment-upload-lease-${marker}`
  createUser({ id: userId, email: `${marker}@attachment-upload-lease.test` })
  return userId
}

function openClearingConnection() {
  const connection = new Database(process.env.APP_DB_PATH, { timeout: 5_000 })
  connection.pragma('foreign_keys = ON')
  connection.pragma('busy_timeout = 5000')
  return connection
}

function clearUser(userId, clearingDb) {
  return clearAuthoritativeUserData({
    userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    requirePreview: false,
    db: clearingDb,
    env: process.env,
    cwd: suiteRoot,
    tempDir: fallbackDir,
  })
}

function uploadBarrier() {
  let markReached
  let release
  const reached = new Promise((resolve) => { markReached = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  return {
    reached,
    release,
    async wait() {
      markReached()
      await blocked
    },
  }
}

function attachmentSource(content) {
  return (async function* source() {
    yield Buffer.from(content)
  })()
}

function uploadRow(uploadId) {
  return db.prepare(`
    SELECT upload_id, user_id, lease_pid, lease_expires_at
    FROM managed_attachment_upload_leases WHERE upload_id = ?
  `).get(uploadId)
}

function attachmentPath(userId, uploadId) {
  const bucket = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32)
  return path.join(dataDir, 'attachments', bucket, uploadId)
}

test('a live upload lease blocks cross-connection clear, then upload and clear both finish cleanly', async () => {
  const userId = createOwner('live-blocker')
  const uploadId = 'live-blocker-upload'
  const barrier = uploadBarrier()
  const clearingDb = openClearingConnection()
  const upload = createManagedAttachment({
    userId,
    id: uploadId,
    name: 'live-blocker.txt',
    mimeType: 'text/plain',
    source: attachmentSource('live upload content'),
    env: process.env,
    onUploadLeaseAcquired: () => barrier.wait(),
  })

  try {
    await barrier.reached
    assert.equal(uploadRow(uploadId)?.lease_pid, process.pid)
    assert.equal(fs.existsSync(attachmentPath(userId, uploadId)), false)
    assert.throws(
      () => clearUser(userId, clearingDb),
      (error) => error.code === 'USER_DATA_CLEAR_RUNTIME_ACTIVE'
        && error.statusCode === 409
        && error.blockers?.some((blocker) => (
          blocker.kind === 'attachment_upload' && blocker.uploadId === uploadId
        )),
    )

    barrier.release()
    const attachment = await upload
    assert.equal(fs.existsSync(attachment.fullPath), true)
    assert.equal(uploadRow(uploadId), undefined)
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM managed_attachments WHERE id = ?',
    ).get(uploadId).count, 1)

    const cleared = clearUser(userId, clearingDb)
    assert.equal(cleared.ok, true)
    assert.equal(fs.existsSync(attachment.fullPath), false)
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM managed_attachments WHERE id = ?',
    ).get(uploadId).count, 0)
    assert.equal(uploadRow(uploadId), undefined)
  } finally {
    barrier.release()
    await upload.catch(() => {})
    clearingDb.close()
  }
})

test('a late upload that loses its lease cannot resurrect files or metadata after clear', async () => {
  const userId = createOwner('lost-lease')
  const uploadId = 'lost-lease-upload'
  const barrier = uploadBarrier()
  const clearingDb = openClearingConnection()
  const finalPath = attachmentPath(userId, uploadId)
  const upload = createManagedAttachment({
    userId,
    id: uploadId,
    name: 'lost-lease.txt',
    mimeType: 'text/plain',
    source: attachmentSource('must not resurrect'),
    env: process.env,
    onUploadLeaseAcquired: () => barrier.wait(),
  })

  try {
    await barrier.reached
    assert.ok(uploadRow(uploadId))
    assert.equal(clearingDb.prepare(`
      DELETE FROM managed_attachment_upload_leases WHERE upload_id = ?
    `).run(uploadId).changes, 1)
    assert.equal(clearUser(userId, clearingDb).ok, true)

    barrier.release()
    await assert.rejects(
      upload,
      (error) => error.code === 'ATTACHMENT_UPLOAD_LEASE_LOST' && error.statusCode === 409,
    )
    assert.equal(fs.existsSync(finalPath), false)
    assert.equal(fs.existsSync(`${finalPath}.uploading`), false)
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM managed_attachments WHERE id = ?',
    ).get(uploadId).count, 0)
    assert.equal(uploadRow(uploadId), undefined)
  } finally {
    barrier.release()
    await upload.catch(() => {})
    clearingDb.close()
  }
})

test('clear reclaims an expired upload lease only after its process is dead', () => {
  const userId = createOwner('dead-expired')
  const uploadId = 'dead-expired-upload'
  const clearingDb = openClearingConnection()
  try {
    db.prepare(`
      INSERT INTO managed_attachment_upload_leases
        (upload_id, user_id, lease_owner, lease_pid, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'dead-worker', 2147483647, 0, 0, 0)
    `).run(uploadId, userId)
    assert.equal(clearUser(userId, clearingDb).ok, true)
    assert.equal(uploadRow(uploadId), undefined)
  } finally {
    clearingDb.close()
  }
})

test('an expired upload lease still blocks clear while its process is alive', () => {
  const userId = createOwner('live-expired')
  const uploadId = 'live-expired-upload'
  const clearingDb = openClearingConnection()
  try {
    db.prepare(`
      INSERT INTO managed_attachment_upload_leases
        (upload_id, user_id, lease_owner, lease_pid, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'live-worker', ?, 0, 0, 0)
    `).run(uploadId, userId, process.pid)
    assert.throws(
      () => clearUser(userId, clearingDb),
      (error) => error.code === 'USER_DATA_CLEAR_RUNTIME_ACTIVE'
        && error.blockers?.some((blocker) => blocker.kind === 'attachment_upload'),
    )
    assert.equal(uploadRow(uploadId)?.lease_pid, process.pid)
  } finally {
    db.prepare('DELETE FROM managed_attachment_upload_leases WHERE upload_id = ?').run(uploadId)
    clearingDb.close()
  }
})

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(suiteRoot, { recursive: true, force: true })
})
