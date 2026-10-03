import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-inline-directory-'))
const savedEnv = { APP_DATA_DIR: process.env.APP_DATA_DIR, APP_DB_PATH: process.env.APP_DB_PATH }
process.env.APP_DATA_DIR = root
process.env.APP_DB_PATH = path.join(root, 'app.db')
const { closeDb, getDb } = await import('../server/db.js')
const { handleLocalFileAccessRequest } = await import('../server/routes/localFileAccessRoutes.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { grantLocalPath, getGrantRows, getPersistentGrantRows, clearSessionLocalFileGrants } =
  await import('../server/services/localFileAccessGrantStore.js')
const { resolveAuthorizedLocalPath } = await import('../server/services/localFileAccessService.js')
const { grantTurnDirectory } = await import('../server/services/turnDirectoryInteractionService.js')
const server = createServer((req, res) => void handleLocalFileAccessRequest(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise(resolve => server.close(resolve))
  clearSessionLocalFileGrants()
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('gugo-inline-directory-'))
  fs.rmSync(root, { recursive: true, force: true })
})

function append(target, sequence, type, payload = {}) {
  appendTurnEvent({ userId: target.owner.userId, event: createTurnEvent({
    id: `${target.turnId}:${sequence}`, sessionId: target.sessionId, turnId: target.turnId,
    sequence, type, payload, createdAt: sequence + 1,
  }) })
}

function fixture(marker, { accessMode = 'read_only', requestType = 'directory' } = {}) {
  const owner = issueTestSession({ email: `${marker}@inline-directory.test` })
  const target = { owner, sessionId: `session-${marker}`, turnId: `turn-${marker}`, directory: path.join(root, marker) }
  fs.mkdirSync(target.directory)
  fs.writeFileSync(path.join(target.directory, 'source.txt'), 'fixture data')
  upsertSession({ id: target.sessionId, userId: owner.userId, title: marker })
  append(target, 0, 'turn.started')
  append(target, 1, 'turn.paused', { text: 'Directory authorization required.', clarification: {
    request_type: requestType, access_mode: accessMode, purpose: 'Read the selected fixture directory.',
    suggested_path: target.directory,
  } })
  target.body = { sessionId: target.sessionId, turnId: target.turnId, pausedSequence: 1,
    path: target.directory, accessMode, scope: 'session' }
  return target
}

function request(target, patch = {}, owner = target.owner) {
  return fetch(`${origin}/api/local-files/grants/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(owner ? { Authorization: `Bearer ${owner.token}` } : {}) },
    body: JSON.stringify({ ...target.body, ...patch }),
  })
}

function persistentState(userId) {
  return { grants: getPersistentGrantRows(userId), settings: getDb().prepare(
    'SELECT * FROM local_file_access_settings WHERE user_id = ?',
  ).all(userId) }
}

test('an inline directory grant is authenticated, exact, temporary by default and actually permits its read', async () => {
  const target = fixture('valid')
  const before = persistentState(target.owner.userId)
  assert.equal((await request(target, {}, null)).status, 401)
  assert.deepEqual(getGrantRows(target.owner.userId), [])
  const response = await request(target)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.interaction, { sessionId: target.sessionId, turnId: target.turnId, pausedSequence: 1,
    requestedPath: target.directory, canonicalPath: fs.realpathSync(target.directory), accessMode: 'read_only', scope: 'session' })
  assert.deepEqual(result.boundary, { id: `${target.turnId}:1`, sequence: 1, type: 'turn.paused' })
  assert.equal(result.grant.scope, 'session')
  assert.equal(result.grant.accessMode, 'read_only')
  assert.equal(result.grant.resourceType, 'directory')
  assert.deepEqual(persistentState(target.owner.userId), before)
  const readable = resolveAuthorizedLocalPath({ userId: target.owner.userId,
    rawPath: path.join(target.directory, 'source.txt'), allowWorkspace: false })
  assert.equal(fs.readFileSync(readable.fullPath, 'utf8'), 'fixture data')
})

test('wrong owner, session, turn, sequence and request mode never create a grant', async () => {
  const target = fixture('wrong-boundary')
  const other = issueTestSession({ email: 'foreign@inline-directory.test' })
  assert.equal((await request(target, {}, other)).status, 409)
  for (const patch of [
    { sessionId: 'foreign' }, { turnId: 'foreign' }, { pausedSequence: 0 },
    { pausedSequence: 2 }, { accessMode: 'read_write' }, { scope: 'all' },
    { pausedSequence: '1' }, { pausedSequence: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.ok([400, 409].includes((await request(target, patch)).status), JSON.stringify(patch))
  assert.deepEqual(getGrantRows(target.owner.userId), [])
  assert.deepEqual(getGrantRows(other.userId), [])
})

test('a scoped directory request cannot authorize a file or a relative path', async () => {
  const target = fixture('invalid-path')
  for (const selected of ['relative', path.join(target.directory, 'source.txt'), path.join(root, 'missing')]) {
    assert.equal((await request(target, { path: selected })).status, 400)
  }
  assert.deepEqual(getGrantRows(target.owner.userId), [])
})

for (const type of ['turn.cancelled', 'turn.resumed', 'turn.completed']) {
  test(`a late directory decision after ${type} cannot grant access`, async () => {
    const target = fixture(type.replace('.', '-'))
    const payloads = {
      'turn.cancelled': { code: 'TURN_CANCELLED' },
      'turn.resumed': { resolution: { type: 'directory_authorization', approved: true,
        path: target.directory, access_mode: 'read_only', authorization_scope: 'session',
        grant_id: 'fixture-grant', resource_type: 'directory', paused_sequence: 1 }, pausedSequence: 1 },
      'turn.completed': { text: 'done' },
    }
    append(target, 2, type, payloads[type])
    assert.equal((await request(target)).status, 409)
    assert.deepEqual(getGrantRows(target.owner.userId), [])
  })
}

test('a generic clarification cannot be substituted for a directory pause', async () => {
  const target = fixture('clarification', { requestType: 'question' })
  assert.equal((await request(target)).status, 409)
  assert.deepEqual(getGrantRows(target.owner.userId), [])
})

test('an existing permanent grant is reused with proof without rewriting it or account settings', async () => {
  const target = fixture('preexisting')
  const prior = grantLocalPath({ userId: target.owner.userId, rootPath: target.directory,
    accessMode: 'read_write', scope: 'persistent' })
  const before = persistentState(target.owner.userId)
  const response = await request(target)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.grant.id, prior.id)
  assert.equal(result.grant.accessMode, 'read_write')
  assert.deepEqual(result.preexistingPermission, { id: prior.id, path: prior.path,
    accessMode: 'read_write', scope: 'persistent' })
  assert.deepEqual(persistentState(target.owner.userId), before)
})

test('explicit permanent directory authorization remains an intentional supported choice', async () => {
  const target = fixture('explicit-persistent')
  const response = await request(target, { scope: 'persistent' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).grant.scope, 'persistent')
  assert.equal(getPersistentGrantRows(target.owner.userId).length, 1)
})

test('the actual grant mutation happens while the current directory boundary transaction is held', () => {
  const target = fixture('atomic')
  const db = getDb()
  const originalPrepare = db.prepare
  let sawTransactionalGrantRead = false
  db.prepare = function (sql) {
    if (/^SELECT \* FROM local_file_grants/u.test(sql)) {
      assert.equal(db.inTransaction, true)
      sawTransactionalGrantRead = true
    }
    return originalPrepare.call(this, sql)
  }
  try {
    grantTurnDirectory({ ...target.body, userId: target.owner.userId, rootPath: target.directory })
    assert.equal(sawTransactionalGrantRead, true)
  } finally { db.prepare = originalPrepare }
})
