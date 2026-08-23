import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-user-data-preview-'))
const dataDir = path.join(root, 'data')
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')
process.env.CREDENTIAL_KEY_PATH = path.join(dataDir, '.credentials.key')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  USER_DATA_CLEAR_CONFIRMATION,
  clearAuthoritativeUserData,
  previewAuthoritativeUserDataClear,
} = await import('../server/services/userDataGovernanceService.js')
const {
  activateTestCompactionArchivePort,
} = await import('./helpers/testCompactionArchivePort.js')

const db = getDb()
const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })
const now = Date.now()

function bucket(userId) {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32)
}

function addConversation(userId, marker, content = `secret-${marker}`) {
  createUser({ id: userId, email: `${marker}@example.com` })
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at, id, title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`session-${marker}`, userId, now + 60_000, now, `session-${marker}`, marker, now)
  db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, created_at, updated_at)
    VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
  `).run(`message-${marker}`, `session-${marker}`, userId, content, marker, now, now)
}

function preview(userId, options = {}) {
  return previewAuthoritativeUserDataClear({
    userId,
    db,
    env: process.env,
    cwd: root,
    tempDir: root,
    ...options,
  }).preview
}

function clear(userId, previewToken, options = {}) {
  return clearAuthoritativeUserData({
    userId,
    confirmation: USER_DATA_CLEAR_CONFIRMATION,
    previewToken,
    requirePreview: true,
    db,
    env: process.env,
    cwd: root,
    tempDir: root,
    ...options,
  })
}

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('clear preview is owner-scoped and exposes only category and managed-file counts', () => {
  addConversation('preview-owner-a', 'preview-a', 'owner-a-private-content')
  addConversation('preview-owner-b', 'preview-b', 'owner-b-private-content')
  const attachmentA = path.join(dataDir, 'attachments', bucket('preview-owner-a'))
  const attachmentB = path.join(dataDir, 'attachments', bucket('preview-owner-b'))
  fs.mkdirSync(attachmentA, { recursive: true })
  fs.mkdirSync(attachmentB, { recursive: true })
  fs.writeFileSync(path.join(attachmentA, 'a.txt'), 'abc')
  fs.writeFileSync(path.join(attachmentB, 'b.txt'), '1234567')

  const result = preview('preview-owner-a')
  assert.equal(result.databaseRows.total, 2)
  assert.equal(result.databaseRows.categories.conversations, 2)
  assert.deepEqual(result.managedFiles, {
    removable: 1,
    removableBytes: 3,
    preservedShared: 0,
    alreadyMissing: 0,
  })
  assert.equal(result.retained.accountIdentity, true)
  assert.equal(result.retained.loginSessions, true)
  assert.equal(result.retained.credentialVaultKey, true)
  assert.equal(result.irreversible, true)
  assert.doesNotMatch(JSON.stringify(result), /owner-[ab]-private-content|preview-owner-[ab]/)
})

test('empty accounts receive a valid zero-impact preview', () => {
  createUser({ id: 'preview-empty', email: 'preview-empty@example.com' })
  const result = preview('preview-empty')
  assert.equal(result.databaseRows.total, 0)
  assert.equal(result.managedFiles.removable, 0)
  assert.equal(result.managedFiles.removableBytes, 0)
  assert.equal(result.canClear, true)
  assert.equal(typeof result.token, 'string')
})

test('service clearing defaults to requiring a fresh preview token', () => {
  addConversation('preview-default-closed', 'preview-default-closed')
  assert.throws(
    () => clearAuthoritativeUserData({
      userId: 'preview-default-closed',
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      db,
      env: process.env,
      cwd: root,
      tempDir: root,
    }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_REQUIRED'
      && error.statusCode === 409,
  )
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
  ).get('preview-default-closed').count, 1)
})

test('preview tokens are owner-bound and cannot clear another account', () => {
  addConversation('preview-cross-a', 'preview-cross-a')
  addConversation('preview-cross-b', 'preview-cross-b')
  const token = preview('preview-cross-a').token
  assert.throws(
    () => clear('preview-cross-b', token),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_REQUIRED',
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('preview-cross-b').count, 1)
})

test('expired and drifted previews fail before deleting database rows or managed files', () => {
  addConversation('preview-expired', 'preview-expired')
  const expiring = preview('preview-expired', { now: 1_000 })
  assert.throws(
    () => clear('preview-expired', expiring.token, { previewNow: expiring.expiresAt }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_EXPIRED',
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('preview-expired').count, 1)

  addConversation('preview-drift', 'preview-drift')
  const drifted = preview('preview-drift')
  db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, created_at, updated_at)
    VALUES ('message-preview-drift-2', 'session-preview-drift', 'preview-drift', 'user',
      'new-after-preview', 'preview-drift', ?, ?)
  `).run(now + 1, now + 1)
  assert.throws(
    () => clear('preview-drift', drifted.token),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('preview-drift').count, 2)
})

test('content digests reject a same-size same-mtime replacement after preview', () => {
  const userId = 'preview-same-metadata-replacement'
  addConversation(userId, 'preview-same-metadata-replacement')
  const bucketPath = path.join(dataDir, 'attachments', bucket(userId))
  const filePath = path.join(bucketPath, 'payload.bin')
  const fixedTime = new Date('2026-01-02T03:04:05.000Z')
  fs.mkdirSync(bucketPath, { recursive: true })
  fs.writeFileSync(filePath, 'AAAA')
  fs.utimesSync(filePath, fixedTime, fixedTime)
  const authorization = preview(userId)
  const before = fs.statSync(filePath)
  fs.writeFileSync(filePath, 'BBBB')
  fs.utimesSync(filePath, fixedTime, fixedTime)
  const after = fs.statSync(filePath)
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeMs, before.mtimeMs)

  assert.throws(
    () => clear(userId, authorization.token),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'BBBB')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
})

test('a file added between attachment preflight and rename is rolled back without database deletion', () => {
  const userId = 'preview-added-during-staging'
  addConversation(userId, 'preview-added-during-staging')
  const bucketPath = path.join(dataDir, 'attachments', bucket(userId))
  const originalPath = path.join(bucketPath, 'original.txt')
  const addedPath = path.join(bucketPath, 'added-after-preflight.txt')
  fs.mkdirSync(bucketPath, { recursive: true })
  fs.writeFileSync(originalPath, 'original')
  const authorization = preview(userId)
  let injected = false
  const fileSystem = {
    renameSync(source, destination) {
      if (!injected && path.resolve(source) === path.resolve(bucketPath)) {
        injected = true
        fs.writeFileSync(addedPath, 'added-after-preflight')
      }
      return fs.renameSync(source, destination)
    },
  }

  assert.throws(
    () => clear(userId, authorization.token, { fileSystem }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'original')
  assert.equal(fs.readFileSync(addedPath, 'utf8'), 'added-after-preflight')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?',
  ).get(userId).count, 0)
})

test('an artifact created after preview but before artifact staging aborts and preserves all data', () => {
  const userId = 'preview-artifact-appeared-during-staging'
  const marker = 'preview-artifact-appeared-during-staging'
  addConversation(userId, marker)
  db.prepare(`
    INSERT INTO jobs
      (id, user_id, title, prompt, status, progress, cancel_requested, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 100, 0, ?, ?)
  `).run(`job-${marker}`, userId, marker, marker, now, now)
  db.prepare(`
    INSERT INTO job_artifacts
      (id, job_id, user_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, ?)
  `).run(
    `artifact-${marker}`,
    `job-${marker}`,
    userId,
    marker,
    `/api/artifacts/${marker}.txt`,
    `${marker}.txt`,
    now,
  )
  const artifactPath = path.join(process.env.ARTIFACT_DIR, `${marker}.txt`)
  const bucketPath = path.join(dataDir, 'attachments', bucket(userId))
  const attachmentPath = path.join(bucketPath, 'keep.txt')
  fs.mkdirSync(bucketPath, { recursive: true })
  fs.writeFileSync(attachmentPath, 'keep')
  assert.equal(fs.existsSync(artifactPath), false)
  const authorization = preview(userId)
  let injected = false
  const fileSystem = {
    renameSync(source, destination) {
      if (!injected && path.resolve(source) === path.resolve(bucketPath)) {
        injected = true
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
        fs.writeFileSync(artifactPath, 'created-after-preview')
      }
      return fs.renameSync(source, destination)
    },
  }

  assert.throws(
    () => clear(userId, authorization.token, { fileSystem }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'created-after-preview')
  assert.equal(fs.readFileSync(attachmentPath, 'utf8'), 'keep')
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM job_artifacts WHERE id = ?',
  ).get(`artifact-${marker}`).count, 1)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM messages WHERE user_id = ?',
  ).get(userId).count, 1)
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM user_data_clear_operations WHERE owner_id = ?',
  ).get(userId).count, 0)
})

test('a concurrent write after attachment rename is detected and restored to active storage', () => {
  const userId = 'preview-write-during-staging'
  addConversation(userId, 'preview-write-during-staging')
  const bucketPath = path.join(dataDir, 'attachments', bucket(userId))
  const filePath = path.join(bucketPath, 'concurrent.txt')
  fs.mkdirSync(bucketPath, { recursive: true })
  fs.writeFileSync(filePath, 'before')
  const authorization = preview(userId)
  let injected = false
  const fileSystem = {
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination)
      if (!injected && path.resolve(source) === path.resolve(bucketPath)) {
        injected = true
        fs.appendFileSync(path.join(destination, 'concurrent.txt'), '-after-rename')
      }
      return result
    },
  }

  assert.throws(
    () => clear(userId, authorization.token, { fileSystem }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_CHANGED'
      && error.databaseCleared === false,
  )
  assert.equal(injected, true)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'before-after-rename')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(userId).count, 1)
})

test('preview rejects an attachments-root junction before reading or deleting outside bytes', (t) => {
  const userId = 'preview-attachment-root-junction'
  addConversation(userId, 'preview-attachment-root-junction')
  const isolatedData = path.join(root, 'junction-data')
  const attachmentPath = path.join(isolatedData, 'attachments')
  const outside = path.join(root, 'junction-outside')
  const outsideFile = path.join(outside, bucket(userId), 'outside.txt')
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true })
  fs.mkdirSync(isolatedData, { recursive: true })
  fs.writeFileSync(outsideFile, 'must-survive')
  try {
    fs.symlinkSync(outside, attachmentPath, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  const env = {
    ...process.env,
    APP_DATA_DIR: isolatedData,
    ARTIFACT_DIR: path.join(root, 'junction-artifacts'),
  }
  assert.throws(
    () => preview(userId, { env }),
    (error) => error.code === 'USER_DATA_CLEAR_PREVIEW_UNSAFE'
      && error.statusCode === 409,
  )
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'must-survive')
  fs.unlinkSync(attachmentPath)
})

test('a current preview authorizes only the previewed isolated data clear', () => {
  addConversation('preview-success', 'preview-success')
  const result = clear('preview-success', preview('preview-success').token)
  assert.equal(result.ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get('preview-success').count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('preview-success').count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get('preview-owner-b').count, 1)
})
