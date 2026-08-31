import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-session-sync-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb } = await import('../server/db.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const { getTurnPersistenceAdapterStatus } = await import('../server/core/turnPersistenceAdapter.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('../server/adapters/sqliteTurnPersistenceAdapter.js')
const {
  prepareSessionAdminPort,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
} = await import('../server/core/sessionAdminPort.js')
const {
  deleteSession,
  getSession,
  getSessionSnapshot,
  listMessages,
  replaceSessionMessages,
  SessionRevisionConflictError,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { saveTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const {
  createCompactionArchiveRecord,
  resolveCompactionArchiveStorage,
} = await import('../server/services/compactionArchiveStore.js')
const {
  buildAssistantModelContext,
  expandStoredMessages,
  extractVerifiedLocalFiles,
  materializeManagedAttachmentMessages,
  selectAttachmentIdsForModelRequest,
  selectStoredMessagesAfterCompaction,
  TURN_TOOL_CONTEXT_LIMITS,
} = await import('../server/services/turnMessageContext.js')
const { normalizeSessionMessagesForServer } = await import('../src/lib/sessionClient.js')
const { normalizeServerSessionSnapshot } = await import('../src/lib/turnClient.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({ env: process.env })

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeRequest({ method = 'GET', url, token, body = null }) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== null) req.headers['content-type'] = 'application/json'
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

async function invokeRoute(
  options,
  engine = { hasActiveSession: () => false },
  sessionAdmin = SQLITE_TURN_PERSISTENCE_ADAPTER.sessionAdmin,
) {
  const res = makeResponse()
  await handleSessionRequest(makeRequest(options), res, engine, sessionAdmin)
  return res
}

function createSessionAdminPort(overrides = {}) {
  const nullable = async () => null
  return prepareSessionAdminPort({
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: async () => [],
    listSessions: async () => [],
    getSessionSnapshot: nullable,
    getSessionBranches: nullable,
    forkSession: nullable,
    replaceSessionMessages: nullable,
    deleteSession: nullable,
    archiveSession: nullable,
    unarchiveSession: nullable,
    pinSession: nullable,
    unpinSession: nullable,
    ...overrides,
  })
}

test('unauthorized Session requests do not initialize the persistence adapter', async () => {
  const before = getTurnPersistenceAdapterStatus()
  assert.equal(before.configured, false)
  assert.equal(before.engineBound, false)

  const res = makeResponse()
  await handleSessionRequest(makeRequest({ url: '/api/sessions' }), res)

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'Unauthorized' })
  assert.deepEqual(getTurnPersistenceAdapterStatus(), before)
})

test('authenticated Session reads do not initialize TurnEngine', async () => {
  const { token } = issueTestSession({ email: 'session-read-port@example.com' })
  const before = getTurnPersistenceAdapterStatus()
  assert.equal(before.engineBound, false)
  const sessionAdmin = createSessionAdminPort()

  for (const url of [
    '/api/sessions/search?q=needle',
    '/api/sessions',
    '/api/sessions/read-only/snapshot',
    '/api/sessions/read-only/branches',
  ]) {
    const res = makeResponse()
    await handleSessionRequest(makeRequest({ url, token }), res, null, sessionAdmin)
    assert.ok([200, 404].includes(res.statusCode), url)
  }

  const defaultPortResponse = makeResponse()
  await handleSessionRequest(
    makeRequest({ url: '/api/sessions', token }),
    defaultPortResponse,
  )
  assert.equal(defaultPortResponse.statusCode, 503)
  assert.deepEqual(defaultPortResponse.json(), {
    error: {
      code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      message: 'turn runtime is not ready because persistence is not configured',
      action: 'restart_runtime',
    },
  })

  assert.deepEqual(getTurnPersistenceAdapterStatus(), before)
})

test('Session mutation responses keep the HTTP ok invariant', async () => {
  const { token } = issueTestSession({ email: 'session-ok-invariant@example.com' })
  const sessionId = 'session-ok-invariant'
  const sessionAdmin = createSessionAdminPort({
    forkSession: async () => ({
      session: { id: `${sessionId}-fork`, revision: 0 },
      totalMessages: 0,
      ok: false,
    }),
    replaceSessionMessages: async () => ({ revision: 1, totalMessages: 0, ok: false }),
    deleteSession: async () => ({ deleted: true, previousRevision: 1, ok: false }),
  })
  const engine = { hasActiveSession: async () => false }

  for (const request of [
    { method: 'POST', url: `/api/sessions/${sessionId}/fork`, body: {} },
    {
      method: 'PUT',
      url: `/api/sessions/${sessionId}/messages`,
      body: { expectedRevision: 0, messages: [] },
    },
    {
      method: 'DELETE',
      url: `/api/sessions/${sessionId}`,
      body: { expectedRevision: 1 },
    },
  ]) {
    const res = makeResponse()
    await handleSessionRequest(
      makeRequest({ ...request, token }),
      res,
      engine,
      sessionAdmin,
    )
    assert.ok([200, 201].includes(res.statusCode), `${request.method} ${request.url}`)
    assert.equal(res.json().ok, true, `${request.method} ${request.url}`)
  }
})

test('Session mutations fail closed when the TurnEngine host is unavailable', async () => {
  const { token } = issueTestSession({ email: 'session-host-unavailable@example.com' })
  const sessionId = 'session-host-unavailable'
  const mutationCalls = []
  const sessionAdmin = createSessionAdminPort({
    forkSession() {
      mutationCalls.push('forkSession')
      return null
    },
    replaceSessionMessages() {
      mutationCalls.push('replaceSessionMessages')
      return null
    },
    deleteSession() {
      mutationCalls.push('deleteSession')
      return null
    },
  })
  const mutations = [
    {
      name: 'fork',
      request: { method: 'POST', url: `/api/sessions/${sessionId}/fork`, body: {} },
    },
    {
      name: 'replace messages',
      request: {
        method: 'PUT',
        url: `/api/sessions/${sessionId}/messages`,
        body: { expectedRevision: 0, messages: [] },
      },
    },
    {
      name: 'delete',
      request: {
        method: 'DELETE',
        url: `/api/sessions/${sessionId}`,
        body: { expectedRevision: 0 },
      },
    },
  ]
  const hostFailures = [
    {
      code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      message: 'turn runtime is not ready because persistence is not configured',
      action: 'restart_runtime',
      useDefaultHost: true,
    },
    {
      code: 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
      message: 'turn runtime is not ready because compaction storage is not configured',
      action: 'restart_runtime',
    },
    {
      code: 'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
      message: 'turn runtime is restarting; retry shortly',
      action: 'retry',
    },
    {
      code: 'TURN_ENGINE_SHUTTING_DOWN',
      message: 'turn runtime is restarting; retry shortly',
      action: 'retry',
    },
    {
      code: 'TURN_ENGINE_SHUTDOWN',
      message: 'turn runtime is restarting; retry shortly',
      action: 'retry',
    },
    {
      code: 'TURN_SESSION_ACTIVITY_CHECK_FAILED',
      message: 'turn activity could not be verified; retry shortly',
      action: 'retry',
    },
    ...[
      'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
      'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
      'TURN_ENGINE_HOST_CLEANUP_FAILED',
    ].map((code) => ({
      code,
      message: 'turn runtime cleanup is incomplete; retry shortly',
      action: 'retry',
    })),
  ]

  for (const failure of hostFailures) {
    const engine = failure.useDefaultHost ? null : {
      hasActiveSession() {
        throw Object.assign(new Error('internal host detail must not leak'), {
          code: failure.code,
        })
      },
    }
    for (const mutation of mutations) {
      const res = makeResponse()
      await handleSessionRequest(
        makeRequest({ ...mutation.request, token }),
        res,
        engine,
        sessionAdmin,
      )

      assert.equal(res.statusCode, 503, `${failure.code}: ${mutation.name}`)
      assert.deepEqual(res.json(), {
        error: {
          code: failure.code,
          message: failure.message,
          action: failure.action,
        },
      }, `${failure.code}: ${mutation.name}`)
      assert.deepEqual(mutationCalls, [], `${failure.code}: ${mutation.name}`)
    }
  }
})

test('Session routes fail closed on malformed backend results', async () => {
  const { token } = issueTestSession({ email: 'session-invalid-result@example.com' })
  const sessionAdmin = createSessionAdminPort({
    listSessions: () => [{ id: 'missing-revision' }],
    getSessionSnapshot: async () => ({
      session: { id: 'invalid-snapshot', revision: 0 },
      revision: 0,
      totalMessages: 0,
      complete: true,
      nextOffset: null,
      backendSecret: 'must-not-leak',
    }),
  })
  const expectedBody = {
    error: {
      code: 'SESSION_ADMIN_RESULT_INVALID',
      message: 'session persistence backend returned an invalid result',
    },
  }

  for (const url of [
    '/api/sessions',
    '/api/sessions/invalid-snapshot/snapshot',
  ]) {
    const res = makeResponse()
    await handleSessionRequest(makeRequest({ url, token }), res, null, sessionAdmin)
    assert.equal(res.statusCode, 500, url)
    assert.deepEqual(res.json(), expectedBody, url)
  }
})

test('Session routes serialize only public fields from valid adapter results', async () => {
  const { token } = issueTestSession({ email: 'session-public-dto@example.com' })
  const sessionAdmin = createSessionAdminPort({
    listSessions: () => [{
      id: 'public-session',
      title: 'Visible',
      revision: 0,
      backendSecret: 'must-not-leak',
    }],
  })
  const res = makeResponse()

  await handleSessionRequest(makeRequest({ url: '/api/sessions', token }), res, null, sessionAdmin)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    sessions: [{ id: 'public-session', title: 'Visible', revision: 0 }],
  })
})

test('Session routes map invalid v2 inputs to 400 without backend invocation', async () => {
  const { token } = issueTestSession({ email: 'session-invalid-input@example.com' })
  const calls = []
  const sessionAdmin = createSessionAdminPort({
    listSessions() {
      calls.push('listSessions')
      return []
    },
    deleteSession() {
      calls.push('deleteSession')
      return null
    },
  })
  const engine = { hasActiveSession: async () => false }

  for (const request of [
    { method: 'GET', url: '/api/sessions?limit=0' },
    { method: 'DELETE', url: '/api/sessions/missing-revision', body: {} },
  ]) {
    const res = makeResponse()
    await handleSessionRequest(
      makeRequest({ ...request, token }),
      res,
      engine,
      sessionAdmin,
    )
    assert.equal(res.statusCode, 400, `${request.method} ${request.url}`)
    assert.equal(res.json().error.code, 'SESSION_ADMIN_INPUT_INVALID')
  }
  assert.deepEqual(calls, [])
})

test('Session routes preserve request body size errors as 413', async () => {
  const { token } = issueTestSession({ email: 'session-body-limit@example.com' })
  let backendCalls = 0
  const sessionAdmin = createSessionAdminPort({
    forkSession() {
      backendCalls += 1
      return null
    },
  })
  const res = makeResponse()

  await handleSessionRequest(
    makeRequest({
      method: 'POST',
      url: '/api/sessions/body-limit/fork',
      token,
      body: { label: 'x'.repeat(70 * 1024) },
    }),
    res,
    { hasActiveSession: async () => false },
    sessionAdmin,
  )

  assert.equal(res.statusCode, 413)
  assert.deepEqual(res.json(), {
    error: {
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'request body is too large',
    },
  })
  assert.equal(backendCalls, 0)
})

test('Session routes reject extra path segments without calling the backend', async () => {
  const { token } = issueTestSession({ email: 'session-route-tail@example.com' })
  const calls = []
  const unused = (name) => async () => {
    calls.push(name)
    return null
  }
  const sessionAdmin = prepareSessionAdminPort({
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: unused('searchMessages'),
    listSessions: unused('listSessions'),
    getSessionSnapshot: unused('getSessionSnapshot'),
    getSessionBranches: unused('getSessionBranches'),
    forkSession: unused('forkSession'),
    replaceSessionMessages: unused('replaceSessionMessages'),
    deleteSession: unused('deleteSession'),
    archiveSession: unused('archiveSession'),
    unarchiveSession: unused('unarchiveSession'),
    pinSession: unused('pinSession'),
    unpinSession: unused('unpinSession'),
  })
  const engine = {
    hasActiveSession() {
      calls.push('hasActiveSession')
      return false
    },
  }

  for (const [method, suffix] of [
    ['GET', 'snapshot'],
    ['PUT', 'messages'],
    ['POST', 'archive'],
    ['POST', 'unarchive'],
    ['POST', 'pin'],
    ['POST', 'unpin'],
  ]) {
    const res = makeResponse()
    await handleSessionRequest(
      makeRequest({ method, url: `/api/sessions/session-tail/${suffix}/extra`, token }),
      res,
      engine,
      sessionAdmin,
    )
    assert.equal(res.statusCode, 404, `${method} ${suffix}`)
    assert.deepEqual(res.json(), { error: 'not found' }, `${method} ${suffix}`)
  }

  assert.deepEqual(calls, [])
})

test('session route awaits the selected async admin port without SQLite fallback', async () => {
  const { token, userId } = issueTestSession({ email: 'session-admin-async@example.com' })
  const calls = []
  let releaseList
  const pendingList = new Promise((resolve) => { releaseList = resolve })
  const unused = (name, result = null) => async () => {
    calls.push(name)
    return result
  }
  const sessionAdmin = prepareSessionAdminPort({
    contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
    searchMessages: unused('searchMessages', []),
    async listSessions(input) {
      calls.push(['listSessions', input])
      return pendingList
    },
    getSessionSnapshot: unused('getSessionSnapshot'),
    getSessionBranches: unused('getSessionBranches'),
    forkSession: unused('forkSession'),
    replaceSessionMessages: unused('replaceSessionMessages'),
    deleteSession: unused('deleteSession'),
    archiveSession: unused('archiveSession'),
    unarchiveSession: unused('unarchiveSession'),
    pinSession: unused('pinSession'),
    unpinSession: unused('unpinSession'),
  })
  const res = makeResponse()
  const handling = handleSessionRequest(
    makeRequest({ url: '/api/sessions?archived=all&limit=3&offset=2', token }),
    res,
    { hasActiveSession: async () => false },
    sessionAdmin,
  )

  await Promise.resolve()
  assert.equal(res.statusCode, 0)
  releaseList([{ id: 'async-session', title: 'Async backend', revision: 0 }])
  await handling

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    sessions: [{ id: 'async-session', title: 'Async backend', revision: 0 }],
  })
  assert.deepEqual(calls, [[
    'listSessions',
    { userId, archived: 'all', limit: 3, offset: 2 },
  ]])
})

test('session snapshots paginate complete histories without changing revision', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-pages@example.com' })
  const sessionId = 'session-pages'
  upsertSession({ id: sessionId, userId, title: 'Paged history', createdAt: 1, updatedAt: 1 })
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
    VALUES (?, ?, ?, 'user', ?, 'Paged history', '{}', ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < 2005; index += 1) {
      insert.run(`page-message-${index}`, sessionId, userId, `message ${index}`, index + 1, index + 1)
    }
  })()

  const first = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=0`,
    token,
  })
  assert.equal(first.statusCode, 200)
  const firstSnapshot = first.json().snapshot
  assert.equal(firstSnapshot.messages.length, 2000)
  assert.equal(firstSnapshot.totalMessages, 2005)
  assert.equal(firstSnapshot.complete, false)
  assert.equal(firstSnapshot.nextOffset, 2000)

  const second = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=${firstSnapshot.nextOffset}`,
    token,
  })
  assert.equal(second.statusCode, 200)
  const secondSnapshot = second.json().snapshot
  assert.equal(secondSnapshot.messages.length, 5)
  assert.equal(secondSnapshot.messages[0].id, 'page-message-2000')
  assert.equal(secondSnapshot.complete, true)
  assert.equal(secondSnapshot.nextOffset, null)
  assert.equal(secondSnapshot.revision, firstSnapshot.revision)
})

test('legacy TURN_INCOMPLETE messages recover only their scoped checkpoint reason', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'legacy-incomplete-scope@example.com' })
  const { userId: otherUserId } = issueTestSession({ email: 'legacy-incomplete-scope-other@example.com' })
  const turnId = 'shared-legacy-incomplete-turn'
  const targetSessionId = 'legacy-incomplete-target'
  const sameUserOtherSessionId = 'legacy-incomplete-same-user-other-session'
  const otherUserSessionId = 'legacy-incomplete-other-user-session'
  const isolatedSessionId = 'legacy-incomplete-isolated'
  for (const [ownerId, sessionId] of [
    [userId, targetSessionId],
    [userId, sameUserOtherSessionId],
    [otherUserId, otherUserSessionId],
    [userId, isolatedSessionId],
  ]) {
    upsertSession({ id: sessionId, userId: ownerId, title: sessionId, createdAt: 1, updatedAt: 1 })
  }
  const legacyContext = {
    version: 1,
    turnId,
    turnEvidence: true,
    evidenceState: 'failed',
    error: { code: 'TURN_INCOMPLETE', message: 'Task incomplete.', retryable: true },
  }
  upsertMessage({
    id: 'legacy-incomplete-target:assistant',
    userId,
    sessionId: targetSessionId,
    role: 'assistant',
    content: '',
    modelContext: legacyContext,
    createdAt: 2,
    updatedAt: 2,
  })
  upsertMessage({
    id: 'legacy-incomplete-isolated:assistant',
    userId,
    sessionId: isolatedSessionId,
    role: 'assistant',
    content: '',
    modelContext: legacyContext,
    createdAt: 2,
    updatedAt: 2,
  })
  saveTurnCheckpoint({
    userId,
    sessionId: sameUserOtherSessionId,
    turnId,
    eventSequence: 1,
    state: { final: { incomplete: true, reason: 'artifact_delivery_not_converged' } },
    now: 3,
  })
  saveTurnCheckpoint({
    userId: otherUserId,
    sessionId: otherUserSessionId,
    turnId,
    eventSequence: 1,
    state: { final: { incomplete: true, reason: 'deliverable_selection_missing' } },
    now: 3,
  })
  saveTurnCheckpoint({
    userId,
    sessionId: targetSessionId,
    turnId,
    eventSequence: 1,
    state: {
      final: {
        incomplete: true,
        reason: 'post_mutation_verification_missing',
        budgetExceeded: false,
        noProgress: false,
      },
    },
    now: 4,
  })

  const recovered = getSessionSnapshot({ userId, sessionId: targetSessionId }).messages[0].modelContext.error
  assert.equal(recovered.incompleteReason, 'post_mutation_verification_missing')
  assert.deepEqual(recovered.missingRequirements, ['mutation_readback', 'diff_or_project_check'])

  const isolated = getSessionSnapshot({ userId, sessionId: isolatedSessionId }).messages[0].modelContext.error
  assert.equal(Object.hasOwn(isolated, 'incompleteReason'), false)
  assert.equal(Object.hasOwn(isolated, 'missingRequirements'), false)
})

test('legacy TURN_INCOMPLETE recovery preserves unknown reasons and rejects non-boolean flags', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'legacy-incomplete-unknown@example.com' })
  const sessionId = 'legacy-incomplete-unknown'
  const turnId = 'legacy-incomplete-unknown-turn'
  upsertSession({ id: sessionId, userId, title: sessionId, createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'legacy-incomplete-unknown:assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: '',
    modelContext: {
      version: 1,
      turnId,
      turnEvidence: true,
      evidenceState: 'failed',
      error: { code: 'TURN_INCOMPLETE', retryable: true },
    },
    createdAt: 2,
    updatedAt: 2,
  })
  saveTurnCheckpoint({
    userId,
    sessionId,
    turnId,
    eventSequence: 1,
    state: {
      final: {
        incomplete: true,
        reason: 'private_internal_reason',
        budgetExceeded: 'true',
        noProgress: 1,
      },
    },
    now: 3,
  })

  const failure = getSessionSnapshot({ userId, sessionId }).messages[0].modelContext.error
  assert.equal(failure.incompleteReason, 'private_internal_reason')
  assert.deepEqual(failure.missingRequirements, ['remaining_task_steps'])
  assert.equal(Object.hasOwn(failure, 'budgetExceeded'), false)
  assert.equal(Object.hasOwn(failure, 'noProgress'), false)
})

test('legacy TURN_INCOMPLETE recovery never overwrites existing structured fields', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'legacy-incomplete-preserve@example.com' })
  const sessionId = 'legacy-incomplete-preserve'
  const turnId = 'legacy-incomplete-preserve-turn'
  const expected = {
    incompleteReason: 'deliverable_selection_missing',
    missingRequirements: ['deliverable_selection'],
    budgetExceeded: false,
    noProgress: true,
  }
  upsertSession({ id: sessionId, userId, title: sessionId, createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'legacy-incomplete-preserve:assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: '',
    modelContext: {
      version: 1,
      turnId,
      turnEvidence: true,
      evidenceState: 'failed',
      error: { code: 'TURN_INCOMPLETE', retryable: true, ...expected },
    },
    createdAt: 2,
    updatedAt: 2,
  })
  saveTurnCheckpoint({
    userId,
    sessionId,
    turnId,
    eventSequence: 1,
    state: {
      final: {
        incomplete: true,
        reason: 'artifact_delivery_not_converged',
        budgetExceeded: true,
        noProgress: false,
      },
    },
    now: 3,
  })

  const failure = getSessionSnapshot({ userId, sessionId }).messages[0].modelContext.error
  assert.deepEqual({
    incompleteReason: failure.incompleteReason,
    missingRequirements: failure.missingRequirements,
    budgetExceeded: failure.budgetExceeded,
    noProgress: failure.noProgress,
  }, expected)
})

test('session snapshots recover legacy incomplete diagnostics from scoped checkpoints without rewriting history', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-legacy-incomplete@example.com' })
  const sessionId = 'session-legacy-incomplete'
  upsertSession({ id: sessionId, userId, title: 'Legacy incomplete', createdAt: 1, updatedAt: 1 })

  const legacyFailure = {
    code: 'TURN_INCOMPLETE',
    message: '任务尚未完全通过验证。',
    retryable: true,
  }
  for (const [turnId, failure] of [
    ['legacy-mutation-verification', legacyFailure],
    ['legacy-budget', legacyFailure],
    ['legacy-no-progress', legacyFailure],
    ['current-structured-diagnostic', {
      ...legacyFailure,
      incompleteReason: 'execution_evidence_missing',
      missingRequirements: ['execution_evidence'],
    }],
  ]) {
    upsertMessage({
      id: `${turnId}:assistant`,
      userId,
      sessionId,
      role: 'assistant',
      content: '',
      modelContext: {
        turnId,
        turnEvidence: true,
        evidenceState: 'failed',
        error: failure,
      },
      createdAt: 2,
      updatedAt: 2,
    })
  }

  for (const [turnId, final] of [
    ['legacy-mutation-verification', {
      incomplete: true,
      reason: 'post_mutation_verification_missing',
    }],
    ['legacy-budget', { incomplete: true, budgetExceeded: true }],
    ['legacy-no-progress', { incomplete: true, noProgress: true }],
    ['current-structured-diagnostic', {
      incomplete: true,
      reason: 'post_mutation_verification_missing',
    }],
  ]) {
    saveTurnCheckpoint({
      userId,
      sessionId,
      turnId,
      eventSequence: 1,
      state: { messages: [], artifactIds: [], final },
      now: 3,
    })
  }

  const snapshot = getSessionSnapshot({ userId, sessionId })
  const failures = new Map(snapshot.messages.map((message) => [
    message.modelContext.turnId,
    message.modelContext.error,
  ]))
  assert.deepEqual(failures.get('legacy-mutation-verification'), {
    ...legacyFailure,
    incompleteReason: 'post_mutation_verification_missing',
    missingRequirements: ['mutation_readback', 'diff_or_project_check'],
  })
  assert.deepEqual(failures.get('legacy-budget'), {
    ...legacyFailure,
    incompleteReason: 'execution_budget_exhausted',
    missingRequirements: ['remaining_task_steps'],
  })
  assert.deepEqual(failures.get('legacy-no-progress'), {
    ...legacyFailure,
    incompleteReason: 'tool_no_progress',
    missingRequirements: ['progress_after_last_checkpoint'],
  })
  assert.deepEqual(failures.get('current-structured-diagnostic'), {
    ...legacyFailure,
    incompleteReason: 'execution_evidence_missing',
    missingRequirements: ['execution_evidence'],
  })

  const stored = new Map(listMessages({ userId, sessionId }).map((message) => [
    message.modelContext.turnId,
    message.modelContext.error,
  ]))
  assert.equal(stored.get('legacy-mutation-verification').incompleteReason, undefined)
  assert.equal(stored.get('legacy-mutation-verification').missingRequirements, undefined)
})

test('legacy incomplete checkpoint recovery stays within the requested session', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-legacy-incomplete-scope@example.com' })
  const sessionId = 'session-legacy-incomplete-scope'
  const otherSessionId = 'session-legacy-incomplete-other'
  const turnId = 'shared-legacy-turn-id'
  upsertSession({ id: sessionId, userId, title: 'Target session' })
  upsertSession({ id: otherSessionId, userId, title: 'Other session' })
  upsertMessage({
    id: `${sessionId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: '',
    modelContext: {
      turnId,
      turnEvidence: true,
      evidenceState: 'failed',
      error: { code: 'TURN_INCOMPLETE', message: 'Incomplete.' },
    },
  })
  saveTurnCheckpoint({
    userId,
    sessionId: otherSessionId,
    turnId,
    eventSequence: 1,
    state: {
      messages: [],
      final: { incomplete: true, reason: 'post_mutation_verification_missing' },
    },
  })

  const message = getSessionSnapshot({ userId, sessionId }).messages[0]
  assert.equal(message.modelContext.error.incompleteReason, undefined)
  assert.equal(message.modelContext.error.missingRequirements, undefined)
})

test('CAS replacement preserves stored model context and rejects a stale revision', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-cas@example.com' })
  const sessionId = 'session-cas'
  upsertSession({ id: sessionId, userId, title: 'CAS history', createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'cas-assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: 'old',
    modelContext: {
      version: 1,
      toolTrace: [{ role: 'tool', tool_call_id: 'call-1', name: 'grep', content: 'result' }],
    },
    createdAt: 2,
    updatedAt: 2,
  })
  const before = getSessionSnapshot({ userId, sessionId })
  const result = replaceSessionMessages({
    userId,
    sessionId,
    expectedRevision: before.revision,
    now: 10,
    messages: [
      { id: 'cas-assistant', role: 'assistant', content: 'updated', createdAt: 2, updatedAt: 10 },
      { id: 'cas-user', role: 'user', content: 'next', createdAt: 3, updatedAt: 10 },
    ],
  })
  assert.ok(result.revision > before.revision)
  const stored = listMessages({ userId, sessionId })
  assert.equal(stored[0].content, 'updated')
  assert.equal(stored[0].modelContext.toolTrace[0].tool_call_id, 'call-1')
  assert.throws(
    () => replaceSessionMessages({
      userId,
      sessionId,
      expectedRevision: before.revision,
      messages: [],
    }),
    (error) => error instanceof SessionRevisionConflictError && error.currentRevision === result.revision,
  )
})

test('imported tool results survive snapshot editing and full-session replacement', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-imported-tools@example.com' })
  const sessionId = 'session-imported-tools'
  upsertSession({ id: sessionId, userId, title: 'Imported tools', createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'unrelated-user', userId, sessionId, role: 'user', content: 'delete me', createdAt: 1,
  })
  upsertMessage({
    id: 'imported-assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: 'I read the file.',
    modelContext: {
      toolCalls: [{
        id: 'imported-read-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    createdAt: 2,
  })
  upsertMessage({
    id: 'imported-tool-result',
    userId,
    sessionId,
    role: 'tool',
    content: '{"ok":true,"content":"README contents"}',
    modelContext: { toolCallId: 'imported-read-1', name: 'read_file' },
    createdAt: 3,
  })
  upsertMessage({
    id: 'keep-user', userId, sessionId, role: 'user', content: 'keep me', createdAt: 4,
  })

  const before = getSessionSnapshot({ userId, sessionId })
  const browserSnapshot = normalizeServerSessionSnapshot({ ...before, complete: true })
  const assistant = browserSnapshot.messages.find((message) => message.id === 'imported-assistant')
  assert.equal(assistant.meta.toolTrace[1].tool_call_id, 'imported-read-1')
  assert.match(assistant.meta.toolTrace[1].content, /README contents/)

  const editedMessages = browserSnapshot.messages.filter((message) => message.id !== 'unrelated-user')
  replaceSessionMessages({
    userId,
    sessionId,
    expectedRevision: before.revision,
    now: 10,
    messages: normalizeSessionMessagesForServer(editedMessages),
  })

  const stored = listMessages({ userId, sessionId })
  assert.deepEqual(stored.map((message) => message.id), ['imported-assistant', 'keep-user'])
  assert.equal(stored[0].modelContext.toolCalls, undefined)
  assert.equal(stored[0].modelContext.toolTrace[1].tool_call_id, 'imported-read-1')

  const expanded = expandStoredMessages(stored)
  const calls = expanded.filter((message) => message.role === 'assistant' && message.tool_calls)
  const results = expanded.filter((message) => message.role === 'tool')
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(calls[0].tool_calls[0].id, 'imported-read-1')
  assert.equal(results[0].tool_call_id, 'imported-read-1')
  assert.match(results[0].content, /README contents/)
})

test('stored system rows are not replayed beside freshly compiled system blocks', () => {
  const expanded = expandStoredMessages([
    {
      id: 'stale-system',
      role: 'system',
      content: 'STALE_IDENTITY_AND_UI_STATE_MUST_NOT_REPLAY',
      modelContext: { uiState: { spinner: true } },
    },
    { id: 'user-fact', role: 'user', content: 'Keep this user request.' },
    { id: 'assistant-fact', role: 'assistant', content: 'Keep this answer.' },
  ])

  assert.deepEqual(expanded.map((message) => message.role), ['user', 'assistant'])
  assert.doesNotMatch(JSON.stringify(expanded), /STALE_IDENTITY_AND_UI_STATE_MUST_NOT_REPLAY|spinner/)
  assert.match(JSON.stringify(expanded), /Keep this user request/)
})

test('terminal fallback errors do not replay as assistant-authored model context', () => {
  const terminalRows = [
    ['failed', 'Provider request failed.', 'Provider request failed.'],
    [
      'interrupted',
      '任务中断：后续模型请求未能继续，任务尚未完成。请重试以继续。\n\n已经完成的部分：\n- read_file：路径：README.md',
      'The runtime stopped before completion.',
    ],
    ['blocked', 'Approval is required.', 'Approval is required.'],
  ].map(([state, content, message]) => ({
    id: `legacy-${state}`,
    role: 'assistant',
    content,
    modelContext: {
      turnEvidence: true,
      evidenceState: state,
      error: { code: `${state.toUpperCase()}_ERROR`, message },
    },
  }))
  terminalRows.push({
    id: 'legacy-cancelled',
    role: 'assistant',
    content: 'Cancelled by user',
    modelContext: { turnEvidence: true, evidenceState: 'cancelled' },
  })
  terminalRows.push({
    id: 'failed-with-real-partial-output',
    role: 'assistant',
    content: 'A real partial model answer.',
    modelContext: {
      turnEvidence: true,
      evidenceState: 'failed',
      error: { code: 'STREAM_FAILED', message: 'The stream ended unexpectedly.' },
    },
  })
  terminalRows.push({
    id: 'cancelled-with-real-partial-output',
    role: 'assistant',
    content: 'A real partial model answer before cancellation.',
    modelContext: { turnEvidence: true, evidenceState: 'cancelled' },
  })
  terminalRows.push({
    id: 'interrupted-with-status-like-real-partial-output',
    role: 'assistant',
    content: '任务中断：这是模型对用户所给标题的真实分析内容。',
    modelContext: {
      turnEvidence: true,
      evidenceState: 'interrupted',
      error: { code: 'STREAM_FAILED', message: 'The stream ended unexpectedly.' },
    },
  })

  const expanded = expandStoredMessages(terminalRows)
  const assistantRows = expanded.filter((message) => message.role === 'assistant')
  assert.deepEqual(
    assistantRows.map((message) => message.content),
    [
      '',
      '',
      '',
      '',
      'A real partial model answer.',
      'A real partial model answer before cancellation.',
      '任务中断：这是模型对用户所给标题的真实分析内容。',
    ],
  )

  const priorOutcomes = expanded.filter((message) => (
    message.role === 'system' && message.content.startsWith('[PRIOR TURN OUTCOME]')
  ))
  assert.equal(priorOutcomes.length, 5)
  assert.match(priorOutcomes[2].content, /"state":"blocked"/)
  assert.match(priorOutcomes[2].content, /BLOCKED_ERROR/)
})

test('successful artifact calls retain a lightweight reference instead of 70k HTML source', () => {
  const tailMarker = '<!-- REVISION_SOURCE_TAIL: keep this exact footer -->'
  const html = `<!doctype html><html><body>${'x'.repeat(70_000)}${tailMarker}</body></html>`
  const argumentsText = JSON.stringify({ title: 'Large page', html })
  assert.ok(argumentsText.length > TURN_TOOL_CONTEXT_LIMITS.maxArgumentChars)

  const modelContext = buildAssistantModelContext({
    turnId: 'large-html-turn',
    checkpointMessages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'large-html-call',
        type: 'function',
        function: { name: 'create_html_app', arguments: argumentsText },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'large-html-call',
      name: 'create_html_app',
      content: JSON.stringify({
        ok: true,
        artifactId: 'large-html-artifact',
        filename: 'large-page.html',
      }),
    }],
    baselineToolCallIds: new Set(),
    artifactIds: ['large-html-artifact'],
  })

  const retainedArguments = modelContext.toolTrace[0].tool_calls[0].function.arguments
  const reference = JSON.parse(retainedArguments)
  assert.deepEqual(reference, {
    __artifactReference: true,
    artifactId: 'large-html-artifact',
    filename: 'large-page.html',
    type: 'html',
    title: 'Large page',
    source: {
      omittedFromHistory: true,
      readTool: 'read_artifact_source',
      artifact_id: 'large-html-artifact',
      instruction: 'Call read_artifact_source from offset 0 through complete=true before revising this artifact.',
    },
  })
  assert.equal(JSON.stringify(modelContext.toolTrace).includes(tailMarker), false)
  assert.ok(JSON.stringify(modelContext.toolTrace).length < 2_000)

  const expanded = expandStoredMessages([{
    id: 'large-html-assistant',
    role: 'assistant',
    content: '网页已生成。',
    modelContext,
  }])
  const expandedCall = expanded.find((message) => message.tool_calls)?.tool_calls[0]
  assert.deepEqual(JSON.parse(expandedCall.function.arguments), reference)
})

test('successful create_html_app local delivery becomes a verified file linked to its artifact', () => {
  const outputPath = path.join(tempDir, 'gallery-output.html')
  fs.writeFileSync(outputPath, '<!doctype html><html><body>gallery</body></html>')
  const checkpointMessages = [{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'verified-html-delivery',
      function: {
        name: 'create_html_app',
        arguments: JSON.stringify({ title: 'Gallery', html: '<!doctype html><html></html>' }),
      },
    }],
  }, {
    role: 'tool',
    tool_call_id: 'verified-html-delivery',
    name: 'create_html_app',
    content: JSON.stringify({
      ok: true,
      artifactId: 'verified-html-artifact',
      filename: 'gallery.html',
      path: outputPath,
      localPath: outputPath,
      outputPath,
    }),
  }]

  const receipts = extractVerifiedLocalFiles(checkpointMessages, {
    baselineToolCallIds: new Set(),
    resolvePath: ({ rawPath }) => ({ fullPath: rawPath }),
  })

  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].path, outputPath)
  assert.deepEqual(receipts[0].relatedArtifactIds, ['verified-html-artifact'])
})

test('artifact source page contents are omitted from persisted tool trace', () => {
  const sourceMarker = 'SOURCE_PAGE_MUST_NOT_PERSIST'
  const modelContext = buildAssistantModelContext({
    turnId: 'artifact-source-read-turn',
    checkpointMessages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'read-source-call',
        type: 'function',
        function: {
          name: 'read_artifact_source',
          arguments: JSON.stringify({ artifact_id: 'artifact-1', offset: 0, limit: 16000 }),
        },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'read-source-call',
      name: 'read_artifact_source',
      content: JSON.stringify({
        ok: true,
        artifactId: 'artifact-1',
        filename: 'page.html',
        sourceFormat: 'artifact_tool_arguments_json',
        offset: 0,
        returnedChars: 16000,
        totalChars: 70000,
        complete: false,
        nextOffset: 16000,
        content: sourceMarker.repeat(500),
      }),
    }],
    baselineToolCallIds: new Set(),
  })

  const retainedResult = JSON.parse(modelContext.toolTrace[1].content)
  assert.equal(retainedResult.sourceOmittedFromHistory, true)
  assert.equal(Object.hasOwn(retainedResult, 'content'), false)
  assert.equal(JSON.stringify(modelContext.toolTrace).includes(sourceMarker), false)
})

test('managed attachments stay lightweight in history and materialize only for a model request', async () => {
  const stored = [{
    id: 'attachment-user',
    role: 'user',
    content: '/vision Summarize the diagram.',
    modelContext: {
      modelContent: 'Summarize the diagram.',
      attachments: [{
        id: 'attachment-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 12,
        sha256: 'a'.repeat(64),
        status: 'ready',
        sessionId: 'session-1',
        messageId: null,
        uri: 'attachment://attachment-1',
        downloadUrl: '/api/attachments/attachment-1/content',
        fullPath: 'must-not-leak',
      }],
    },
  }]

  const history = expandStoredMessages(stored)
  assert.equal(history[0].content, 'Summarize the diagram.')
  assert.deepEqual(history[0].managedAttachments, [{
    id: 'attachment-1',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 12,
    sha256: 'a'.repeat(64),
    uri: 'attachment://attachment-1',
    downloadUrl: '/api/attachments/attachment-1/content',
    status: 'ready',
    sessionId: 'session-1',
    messageId: null,
  }])
  assert.doesNotMatch(JSON.stringify(history), /fullPath|base64,/)

  const preparedCalls = []
  const providerMessages = await materializeManagedAttachmentMessages(history, {
    userId: 'user-1',
    sessionId: 'session-1',
    prepareAttachments: async (input) => {
      preparedCalls.push(input)
      return {
        content: [
          { type: 'text', text: input.text },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        ],
      }
    },
  })

  assert.deepEqual(preparedCalls, [{
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: ['attachment-1'],
    expectedAttachments: [{
      id: 'attachment-1',
      name: 'diagram.png',
      mimeType: 'image/png',
      size: 12,
      sha256: 'a'.repeat(64),
      status: 'ready',
      sessionId: 'session-1',
      messageId: null,
      uri: 'attachment://attachment-1',
      downloadUrl: '/api/attachments/attachment-1/content',
    }],
    text: 'Summarize the diagram.',
  }])
  assert.match(JSON.stringify(providerMessages), /base64,/)
  assert.equal('managedAttachments' in providerMessages[0], false)
  assert.doesNotMatch(JSON.stringify(history), /base64,/)
})

test('managed attachments stay as references when a provider request does not need binary media', async () => {
  const history = expandStoredMessages([{
    id: 'prior-attachment-user',
    role: 'user',
    content: 'Summarize the diagram.',
    modelContext: {
      modelContent: 'Summarize the diagram.',
      attachments: [{
        id: 'attachment-reference-only',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 12,
        sha256: 'abc123',
        uri: 'attachment://attachment-reference-only',
      }],
    },
  }])
  let prepared = 0
  const providerMessages = await materializeManagedAttachmentMessages(history, {
    userId: 'user-1',
    sessionId: 'session-1',
    inlineAttachmentIds: [],
    prepareAttachments: async () => {
      prepared += 1
      throw new Error('reference-only requests must not read attachment bytes')
    },
  })

  assert.equal(prepared, 0)
  assert.doesNotMatch(JSON.stringify(providerMessages), /base64,/)
  assert.match(String(providerMessages[0].content), /attachment:\/\/attachment-reference-only/)
  assert.equal('managedAttachments' in providerMessages[0], false)

  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    prompt: 'Now explain the implementation choices.',
  }), [])
  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    prompt: 'What is shown in the same image?',
  }), ['attachment-reference-only'])
  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    currentAttachmentIds: ['new-upload'],
    prompt: 'Analyze this upload.',
  }), ['new-upload'])
})

test('server snapshots restore user attachments from persisted model context', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'attachment-user',
      role: 'user',
      content: 'Read this file.',
      createdAt: 1,
      modelContext: {
        attachments: [{
          id: 'attachment-2',
          name: 'folder\\report.pdf',
          mimeType: 'application/pdf',
          size: 2048,
          sha256: 'pdf-hash',
          downloadUrl: '/api/attachments/attachment-2/content',
        }],
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].attachments, [{
    id: 'attachment-2',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    sha256: 'pdf-hash',
    downloadUrl: '/api/attachments/attachment-2/content',
  }])
})

test('compaction boundary selects only the retained canonical tail', () => {
  const stored = [
    { id: 'archived-user', role: 'user', content: 'old request' },
    { id: 'archived-assistant', role: 'assistant', content: 'old reply' },
    { id: 'retained-user', role: 'user', content: 'current retained objective' },
    { id: 'retained-assistant', role: 'assistant', content: 'current reply' },
  ]

  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, { firstKeptMessageId: 'retained-user' })
      .map((message) => message.id),
    ['retained-user', 'retained-assistant'],
  )
  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, { lastCompactedMessageId: 'archived-assistant' })
      .map((message) => message.id),
    ['retained-user', 'retained-assistant'],
  )
  assert.equal(stored.length, 4, 'canonical UI/audit history must remain intact')
})

test('unmatched compaction boundary keeps messages after the archive reference', () => {
  const stored = [
    { id: 'archived-user', role: 'user', content: 'old request must stay archived' },
    { id: 'archived-assistant', role: 'assistant', content: 'old reply must stay archived' },
    { id: 'archive-reference', role: 'assistant', content: 'archive reference' },
    { id: 'current-turn:user', role: 'user', content: 'current request must survive' },
  ]

  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, {
      firstKeptMessageId: 'missing-retained-message',
      lastCompactedMessageId: 'missing-archived-message',
      referenceMessageId: 'archive-reference',
    }).map((message) => message.id),
    ['current-turn:user'],
  )
  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, {
      firstKeptMessageId: 'missing-retained-message',
      lastCompactedMessageId: 'missing-archived-message',
    }),
    [],
    'without any trustworthy anchor, archived history must remain excluded',
  )
  assert.equal(stored.length, 4, 'canonical UI/audit history must remain intact')
})

test('assistant model context and server snapshots preserve total turn duration', () => {
  const modelContext = buildAssistantModelContext({
    turnId: 'timed-turn',
    checkpointMessages: [],
    baselineToolCallIds: new Set(),
    turnStartedAt: 1_000,
    turnCompletedAt: 4_250,
  })

  assert.equal(modelContext.turnStartedAt, 1_000)
  assert.equal(modelContext.turnCompletedAt, 4_250)
  assert.equal(modelContext.latency, 3_250)

  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'timed-assistant',
      role: 'assistant',
      content: 'Finished.',
      createdAt: 4_250,
      modelContext: {
        ...modelContext,
        latency: undefined,
      },
    }],
  })

  assert.equal(snapshot.messages[0].meta.turnStartedAt, 1_000)
  assert.equal(snapshot.messages[0].meta.turnCompletedAt, 4_250)
  assert.equal(snapshot.messages[0].meta.latency, 3_250)
})

test('legacy server snapshots derive turn duration from matching user and assistant messages', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-turn:user',
      role: 'user',
      content: 'Start.',
      createdAt: 10_000,
      modelContext: { turnId: 'legacy-turn' },
    }, {
      id: 'legacy-turn:assistant',
      role: 'assistant',
      content: 'Finished.',
      createdAt: 13_750,
      modelContext: { turnId: 'legacy-turn' },
    }],
  })

  assert.equal(snapshot.messages[1].meta.turnStartedAt, 10_000)
  assert.equal(snapshot.messages[1].meta.turnCompletedAt, 13_750)
  assert.equal(snapshot.messages[1].meta.latency, 3_750)
})

test('session mutation routes return 409 for stale revisions and active turns', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-route-conflict@example.com' })
  const sessionId = 'session-route-conflict'
  upsertSession({ id: sessionId, userId, title: 'Route conflict' })
  upsertMessage({ id: 'route-message', userId, sessionId, role: 'user', content: 'hello' })
  const current = getSessionSnapshot({ userId, sessionId })

  const stale = await invokeRoute({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/messages`,
    token,
    body: { expectedRevision: current.revision - 1, messages: [] },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'SESSION_REVISION_CONFLICT')
  assert.equal(stale.json().error.currentRevision, current.revision)

  const activeEngine = { hasActiveSession: ({ userId: candidate, sessionId: candidateSession }) => (
    candidate === userId && candidateSession === sessionId
  ) }
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: current.revision, messages: [] }],
    ['DELETE', '', { expectedRevision: current.revision }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token,
      body,
    }, activeEngine)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, 'SESSION_ACTIVE')
  }
  assert.ok(getSession({ userId, sessionId }))
  assert.equal(listMessages({ userId, sessionId }).length, 1)
})

test('cross-user session mutations return 404 without changing the owner history', { concurrency: false }, async () => {
  const owner = issueTestSession({ email: 'session-owner@example.com' })
  const intruder = issueTestSession({ email: 'session-intruder@example.com' })
  const sessionId = 'session-owned'
  upsertSession({ id: sessionId, userId: owner.userId, title: 'Owned' })
  upsertMessage({ id: 'owned-message', userId: owner.userId, sessionId, role: 'user', content: 'private' })
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: 0, messages: [] }],
    ['DELETE', '', { expectedRevision: 0 }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token: intruder.token,
      body,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'SESSION_NOT_FOUND')
  }
  assert.equal(listMessages({ userId: owner.userId, sessionId })[0].content, 'private')
})

test('CAS session deletion cascades strong references and clears weak references', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-delete@example.com' })
  const sessionId = 'session-delete'
  const db = getDb()
  upsertSession({ id: sessionId, userId, title: 'Delete me' })
  upsertMessage({ id: 'delete-message', userId, sessionId, role: 'user', content: 'bye' })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'delete-event',
      sessionId,
      turnId: 'delete-turn',
      sequence: 0,
      type: 'turn.started',
      payload: {},
      createdAt: 2,
    }),
  })
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES ('delete-artifact', ?, ?, 'delete-turn', 'file', 'Delete', '/delete', 'session-delete.txt', 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO pending_approvals
      (id, user_id, origin, session_id, tool_name, args_json, risk, status, created_at, updated_at)
    VALUES ('delete-approval', ?, 'chat', ?, 'write_file', '{}', 'medium', 'pending', 2, 2)
  `).run(userId, sessionId)
  db.prepare('INSERT INTO session_meters (session_id, user_id, updated_at) VALUES (?, ?, 2)')
    .run(sessionId, userId)
  createCompactionArchiveRecord({
    id: 'delete-archive',
    userId,
    sessionId,
    archivedMessages: [{ role: 'user', content: 'delete this private archive body' }],
    summaryText: 'summary',
    now: 2,
    db,
  })
  const archiveRow = db.prepare('SELECT * FROM compaction_archive WHERE id = ?')
    .get('delete-archive')
  const archivePath = resolveCompactionArchiveStorage({
    userId,
    id: archiveRow.id,
    storagePath: archiveRow.storage_path,
  }).fullPath
  assert.equal(fs.existsSync(archivePath), true)
  db.prepare(`
    INSERT INTO memories
      (id, user_id, type, title, slug, body, frontmatter_json, pinned,
       source_session_id, source_message_id, created_at, updated_at)
    VALUES ('delete-memory', ?, 'project', 'Delete memory', 'delete-memory', 'body', '{}', 0, ?, 'delete-message', 2, 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO subagent_runs
      (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, created_at)
    VALUES ('delete-subagent', ?, ?, 'delete-message', 'general', 'prompt', 'completed', 2)
  `).run(userId, sessionId)

  const revision = getSessionSnapshot({ userId, sessionId }).revision
  assert.deepEqual(deleteSession({ userId, sessionId, expectedRevision: revision }), {
    deleted: true,
    previousRevision: revision,
  })
  assert.equal(getSession({ userId, sessionId }), null)
  assert.equal(fs.existsSync(archivePath), false)
  for (const [table, column, value] of [
    ['messages', 'id', 'delete-message'],
    ['turn_events', 'id', 'delete-event'],
    ['turn_artifacts', 'id', 'delete-artifact'],
    ['pending_approvals', 'id', 'delete-approval'],
    ['compaction_archive', 'id', 'delete-archive'],
    ['session_meters', 'session_id', sessionId],
  ]) {
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value), undefined, table)
  }
  assert.deepEqual(
    db.prepare('SELECT source_session_id, source_message_id FROM memories WHERE id = ?').get('delete-memory'),
    { source_session_id: null, source_message_id: null },
  )
  assert.deepEqual(
    db.prepare('SELECT parent_session_id, parent_message_id FROM subagent_runs WHERE id = ?').get('delete-subagent'),
    { parent_session_id: null, parent_message_id: null },
  )
})
