import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-legacy-session-import-'))
process.env.APP_DATA_DIR = tempDir
process.env.AUTH_MODE = 'local'

const { closeDb, getDb } = await import('../server/db.js')
const {
  bootstrapAuth,
  issueEmailCode,
  verifyEmailCode,
} = await import('../server/adapters/authAccount.js')
const {
  prepareSessionAdminPort,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
} = await import('../server/core/sessionAdminPort.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const { SQLITE_SESSION_ADMIN_PORT } = await import('../server/services/sqliteSessionAdminPort.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { setWorkspaceTrust } = await import('../server/services/workspaceTrustService.js')

const LOCAL_ENV = { ...process.env, AUTH_MODE: 'local' }
const MULTI_USER_ENV = { ...process.env, AUTH_MODE: 'multi_user' }
const owner = bootstrapAuth({ env: LOCAL_ENV, now: Date.now() })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeRequest({ method = 'POST', url = '/api/sessions/import', token, body, address = '127.0.0.1' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== undefined) req.headers['content-type'] = 'application/json'
  req.socket = { remoteAddress: address }
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.from(String(chunk)))
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
    },
  }
}

async function invoke(options, sessionAdmin = SQLITE_SESSION_ADMIN_PORT, env = LOCAL_ENV) {
  const response = makeResponse()
  await handleSessionRequest(makeRequest(options), response, null, sessionAdmin, env)
  return response
}

function message(id, content = 'history') {
  return { id, role: 'user', content, createdAt: 10, updatedAt: 11 }
}

function legacySession(id, overrides = {}) {
  return {
    id,
    title: `Legacy ${id}`,
    createdAt: 5,
    updatedAt: 12,
    messages: [message(`${id}:message`)],
    ...overrides,
  }
}

function unsupportedPort() {
  const nullable = () => null
  return prepareSessionAdminPort({
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: () => [],
    listSessions: () => [],
    getSessionSnapshot: nullable,
    getSessionBranches: nullable,
    forkSession: nullable,
    replaceSessionMessages: nullable,
    deleteSession: nullable,
    archiveSession: nullable,
    unarchiveSession: nullable,
    pinSession: nullable,
    unpinSession: nullable,
  })
}

function createOtherUser() {
  const email = `legacy-import-other-${Date.now()}-${Math.random()}@example.com`
  issueEmailCode({ email, code: '424242' })
  const result = verifyEmailCode({ email, code: '424242' })
  return { token: result.token, userId: result.user.id }
}

test('legacy import requires authentication, local auth, loopback, and the fixed local owner', async () => {
  const body = { sessions: [legacySession('guarded-import')] }
  const unauthorized = await invoke({ body })
  assert.equal(unauthorized.statusCode, 401)

  const multiUser = await invoke({ token: owner.token, body }, SQLITE_SESSION_ADMIN_PORT, MULTI_USER_ENV)
  assert.equal(multiUser.statusCode, 403)
  assert.equal(multiUser.json().error.code, 'LOCAL_OWNER_ONLY')

  const remote = await invoke({ token: owner.token, body, address: '192.0.2.10' })
  assert.equal(remote.statusCode, 403)
  assert.equal(remote.json().error.code, 'LOCAL_OWNER_ONLY')

  const other = createOtherUser()
  const wrongOwner = await invoke({ token: other.token, body })
  assert.equal(wrongOwner.statusCode, 403)
  assert.equal(wrongOwner.json().error.code, 'LOCAL_OWNER_ONLY')
  assert.equal(getDb().prepare('SELECT 1 FROM sessions WHERE token = ?').get('guarded-import'), undefined)
})

test('adapters without the optional import capability remain valid and return unsupported', async () => {
  const port = unsupportedPort()
  assert.equal(port.importLegacySessions, undefined)
  const response = await invoke({
    token: owner.token,
    body: { sessions: [legacySession('unsupported-import')] },
  }, port)
  assert.equal(response.statusCode, 501)
  assert.equal(response.json().error.code, 'LEGACY_SESSION_IMPORT_UNSUPPORTED')

  const workspaceResponse = await invoke({
    method: 'PUT',
    url: '/api/sessions/unsupported-import/workspace',
    token: owner.token,
    body: { workspacePath: null },
  }, port)
  assert.equal(workspaceResponse.statusCode, 501)
  assert.equal(workspaceResponse.json().error.code, 'SESSION_WORKSPACE_UPDATE_UNSUPPORTED')
})

test('first import commits once and a retry preserves the exact server revision and transcript', async () => {
  const id = 'legacy-idempotent'
  const workspacePath = path.join(tempDir, 'legacy-workspace')
  const body = {
    sessions: [legacySession(id, {
      workspacePath,
      messages: [
        message(`${id}:user`, 'hello'),
        {
          id: `${id}:assistant`,
          role: 'assistant',
          content: 'world',
          modelContext: { turnId: 'turn-1', streaming: true, pendingServerSync: true },
          createdAt: 12,
          updatedAt: 13,
        },
      ],
    })],
  }
  const first = await invoke({ token: owner.token, body })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().importedCount, 1)
  assert.equal(first.json().results[0].status, 'imported')
  assert.equal(first.json().results[0].session.workspacePath, workspacePath)

  const before = getDb().prepare(`
    SELECT title, revision, updated_at, workspace_path
    FROM sessions WHERE token = ?
  `).get(id)
  const messagesBefore = getDb().prepare(`
    SELECT id, role, content, model_context_json, created_at, updated_at
    FROM messages WHERE session_id = ? ORDER BY created_at, rowid
  `).all(id)
  assert.deepEqual(JSON.parse(messagesBefore[1].model_context_json), { turnId: 'turn-1' })

  const second = await invoke({ token: owner.token, body: {
    sessions: [legacySession(id, {
      title: 'must not overwrite',
      workspacePath: path.join(tempDir, 'must-not-overwrite'),
      messages: [message('different', 'different')],
    })],
  } })
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().serverAuthoritativeCount, 1)
  assert.equal(second.json().results[0].status, 'server_authoritative')
  assert.deepEqual(
    getDb().prepare(`
      SELECT title, revision, updated_at, workspace_path
      FROM sessions WHERE token = ?
    `).get(id),
    before,
  )
  assert.deepEqual(getDb().prepare(`
    SELECT id, role, content, model_context_json, created_at, updated_at
    FROM messages WHERE session_id = ? ORDER BY created_at, rowid
  `).all(id), messagesBefore)
})

test('empty legacy sessions remain visible after import', async () => {
  const id = 'legacy-empty'
  const response = await invoke({
    token: owner.token,
    body: { sessions: [legacySession(id, { messages: [] })] },
  })

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().importedCount, 1)
  assert.equal(response.json().results[0].status, 'imported')
  assert.deepEqual(
    getDb().prepare('SELECT token, title, revision FROM sessions WHERE token = ?').get(id),
    { token: id, title: `Legacy ${id}`, revision: 0 },
  )
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(id).count,
    0,
  )
})

test('workspace updates are owner-scoped, authorized, canonical, and explicitly clearable', async () => {
  const id = 'workspace-metadata-session'
  const imported = await invoke({
    token: owner.token,
    body: { sessions: [legacySession(id, { workspacePath: undefined })] },
  })
  assert.equal(imported.statusCode, 200)

  grantLocalPath({
    userId: owner.user.id,
    rootPath: tempDir,
    accessMode: 'read_write',
  })
  setWorkspaceTrust({
    userId: owner.user.id,
    rootPath: tempDir,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
  })
  const canonicalPath = fs.realpathSync(tempDir)
  const selected = await invoke({
    method: 'PUT',
    url: `/api/sessions/${encodeURIComponent(id)}/workspace`,
    token: owner.token,
    body: { workspacePath: tempDir },
  })
  assert.equal(selected.statusCode, 200)
  assert.equal(selected.json().session.workspacePath, canonicalPath)
  assert.equal(
    getDb().prepare('SELECT workspace_path FROM sessions WHERE token = ?').get(id).workspace_path,
    canonicalPath,
  )

  const other = createOtherUser()
  const foreignClear = await invoke({
    method: 'PUT',
    url: `/api/sessions/${encodeURIComponent(id)}/workspace`,
    token: other.token,
    body: { workspacePath: null },
  })
  assert.equal(foreignClear.statusCode, 404)
  assert.equal(
    getDb().prepare('SELECT workspace_path FROM sessions WHERE token = ?').get(id).workspace_path,
    canonicalPath,
  )

  const cleared = await invoke({
    method: 'PUT',
    url: `/api/sessions/${encodeURIComponent(id)}/workspace`,
    token: owner.token,
    body: { workspacePath: null },
  })
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.json().session.workspacePath, null)
  assert.equal(
    getDb().prepare('SELECT workspace_path FROM sessions WHERE token = ?').get(id).workspace_path,
    null,
  )
})

test('same-user, cross-user, and auth-token ids are all server authoritative without owner disclosure', async () => {
  const db = getDb()
  const other = createOtherUser()
  const sameId = 'authoritative-same-owner'
  const crossId = 'authoritative-cross-owner'
  db.prepare(`
    INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sameId, sameId, owner.user.id, 'same owner original', Number.MAX_SAFE_INTEGER, 1, 1)
  db.prepare(`
    INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crossId, crossId, other.userId, 'cross owner secret', Number.MAX_SAFE_INTEGER, 1, 1)

  const response = await invoke({
    token: owner.token,
    body: {
      sessions: [
        legacySession(sameId),
        legacySession(crossId),
        legacySession(other.token),
      ],
    },
  })
  assert.equal(response.statusCode, 200)
  const result = response.json()
  assert.equal(result.importedCount, 0)
  assert.deepEqual(result.results.map(({ status }) => status), [
    'server_authoritative',
    'server_authoritative',
    'server_authoritative',
  ])
  assert.equal(result.results[0].session.title, 'same owner original')
  assert.equal(result.results[1].session, null)
  assert.equal(result.results[2].session, null)
  assert.doesNotMatch(JSON.stringify(result), /cross owner secret|user_id|userId/u)
})

test('invalid entries and database message collisions roll back the complete batch', async () => {
  const invalidFirst = 'invalid-batch-first'
  const invalidSecond = 'invalid-batch-second'
  const invalid = await invoke({
    token: owner.token,
    body: {
      sessions: [
        legacySession(invalidFirst),
        legacySession(invalidSecond, { messages: [{ id: 'bad-role', role: 'owner', content: 'bad' }] }),
      ],
    },
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error.code, 'SESSION_ADMIN_INPUT_INVALID')
  assert.equal(getDb().prepare('SELECT 1 FROM sessions WHERE token IN (?, ?)').get(invalidFirst, invalidSecond), undefined)

  const existingSession = 'message-collision-source'
  getDb().prepare(`
    INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(existingSession, existingSession, owner.user.id, 'source', Number.MAX_SAFE_INTEGER, 1, 1)
  getDb().prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
    VALUES (?, ?, ?, 'user', 'source', 'source', '{}', 1, 1)
  `).run('occupied-message-id', existingSession, owner.user.id)

  const collisionIds = ['collision-batch-first', 'collision-batch-second']
  const collision = await invoke({
    token: owner.token,
    body: {
      sessions: [
        legacySession(collisionIds[0]),
        legacySession(collisionIds[1], { messages: [message('occupied-message-id')] }),
      ],
    },
  })
  assert.equal(collision.statusCode, 409)
  assert.equal(collision.json().error.code, 'LEGACY_SESSION_IMPORT_CONFLICT')
  assert.equal(getDb().prepare('SELECT 1 FROM sessions WHERE token IN (?, ?)').get(...collisionIds), undefined)
})

test('legacy import enforces session, message, content, and HTTP body limits before writes', async () => {
  const cases = [
    {
      body: { sessions: Array.from({ length: 21 }, (_, index) => legacySession(`too-many-sessions-${index}`)) },
      status: 400,
    },
    {
      body: {
        sessions: [legacySession('too-many-session-messages', {
          messages: Array.from({ length: 1_001 }, (_, index) => message(`too-many:${index}`)),
        })],
      },
      status: 400,
    },
    {
      body: {
        sessions: Array.from({ length: 3 }, (_, sessionIndex) => legacySession(`too-many-total-${sessionIndex}`, {
          messages: Array.from({ length: 700 }, (_, messageIndex) => (
            message(`too-many-total:${sessionIndex}:${messageIndex}`)
          )),
        })),
      },
      status: 400,
    },
    {
      body: {
        sessions: [legacySession('content-too-large', {
          messages: [message('content-too-large:message', 'x'.repeat(1_000_001))],
        })],
      },
      status: 400,
    },
    {
      body: {
        sessions: [legacySession('body-too-large', {
          messages: Array.from({ length: 9 }, (_, index) => (
            message(`body-too-large:${index}`, 'x'.repeat(1_000_000))
          )),
        })],
      },
      status: 413,
    },
  ]

  for (const entry of cases) {
    const response = await invoke({ token: owner.token, body: entry.body })
    assert.equal(response.statusCode, entry.status)
  }
  assert.equal(getDb().prepare("SELECT 1 FROM sessions WHERE token LIKE 'too-many-%' OR token IN ('content-too-large', 'body-too-large')").get(), undefined)
})
