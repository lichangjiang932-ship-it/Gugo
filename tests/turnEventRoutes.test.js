import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-event-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import('../server/adapters/sqliteTurnPersistenceAdapter.js')
const { createTurnPersistenceAdapterController } = await import('../server/core/turnPersistenceAdapter.js')
const { closeDb, createUser, getDb } = await import('../server/db.js')
const { closeTurnEngine } = await import('../server/services/turnEngineHost.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { publishTurnActivity } = await import('../server/services/turnActivityBus.js')
const { handleTurnEventRequest } = await import('../server/routes/turnEventRoutes.js')
const { TurnSteeringError } = await import('../server/services/turnSteeringStore.js')
const { ModelReadinessError } = await import('../server/services/modelReadinessService.js')
const { createTurnActivity, createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')
const persistence = createTurnPersistenceAdapterController(SQLITE_TURN_PERSISTENCE_ADAPTER, {
  source: 'test.turn-event-routes',
})
persistence.activate()
const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.turn-event-routes',
})

const server = createAppServer({
  getEnv: () => ({ TURN_EVENT_STREAM_POLL_INTERVAL_MS: '100' }),
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await closeTurnEngine()
  compactionArchiveController.release()
  persistence.release()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function auth(token) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }

async function withTurnRouteEngine(engine, callback, options = {}) {
  const routeServer = createServer((req, res) => {
    void handleTurnEventRequest(req, res, engine, {
      env: { AUTH_MODE: 'multi_user' },
      ...options,
    })
  })
  await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve))
  const routeOrigin = `http://127.0.0.1:${routeServer.address().port}`
  try {
    return await callback(routeOrigin)
  } finally {
    await new Promise((resolve) => routeServer.close(resolve))
  }
}

function createLegacyTurn({ ownerId, sessionId, turnId, terminal = false }) {
  createUser({ id: ownerId, email: `${ownerId}@example.com` })
  upsertSession({ id: sessionId, userId: ownerId, title: 'Legacy chat' })
  appendTurnEvent({
    userId: ownerId,
    event: createTurnEvent({
      id: `${turnId}:started`, sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: { content: 'legacy turn' }, createdAt: 1,
    }),
  })
  if (terminal) {
    appendTurnEvent({
      userId: ownerId,
      event: createTurnEvent({
        id: `${turnId}:completed`, sessionId, turnId, sequence: 1,
        type: 'turn.completed', payload: {}, createdAt: 2,
      }),
    })
  }
}

test('turn event endpoints require authentication', async () => {
  assert.equal((await fetch(`${origin}/api/turns/events?sessionId=s&turnId=t`)).status, 401)
  assert.equal((await fetch(`${origin}/api/turns/stream?sessionId=s&turnId=t`)).status, 401)
  assert.equal((await fetch(`${origin}/api/turns/events`, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(`${origin}/api/turns/t/steer`, { method: 'POST', body: '{}' })).status, 401)
})

test('turn routes resolve the host lazily and expose unavailable persistence as 503', async () => {
  const user = issueTestSession({ email: 'turn-host-unavailable@example.com' })
  let resolutionCount = 0
  const resolveEngine = () => {
    resolutionCount += 1
    const error = new Error('adapter missing')
    error.code = 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
    throw error
  }

  await withTurnRouteEngine(null, async (routeOrigin) => {
    const failures = await fetch(`${routeOrigin}/api/turns/event-write-failures`, {
      headers: auth(user.token),
    })
    assert.equal(failures.status, 200)

    const unknown = await fetch(`${routeOrigin}/api/turns/not-a-route/extra`, {
      headers: auth(user.token),
    })
    assert.equal(unknown.status, 405)
    assert.equal(resolutionCount, 0)

    const missingTarget = await fetch(`${routeOrigin}/api/turns/stream`, {
      headers: auth(user.token),
    })
    assert.equal(missingTarget.status, 400)
    assert.equal(resolutionCount, 0)

    const response = await fetch(`${routeOrigin}/api/turns/events?sessionId=s&turnId=t`, {
      headers: auth(user.token),
    })
    assert.equal(response.status, 503)
    assert.deepEqual((await response.json()).error, {
      code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      message: 'turn runtime is not ready because persistence is not configured',
      action: 'restart_runtime',
    })
    assert.equal(resolutionCount, 1)
  }, { resolveEngine })
})

test('turn routes expose an engine shutdown handoff as a retryable 503', async () => {
  const user = issueTestSession({ email: 'turn-host-restarting@example.com' })
  let failureCode = 'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE'
  const resolveEngine = () => {
    const error = new Error('old engine still owns the adapter lease')
    error.code = failureCode
    throw error
  }

  await withTurnRouteEngine(null, async (routeOrigin) => {
    for (failureCode of [
      'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
      'TURN_ENGINE_SHUTTING_DOWN',
      'TURN_ENGINE_SHUTDOWN',
    ]) {
      const response = await fetch(`${routeOrigin}/api/turns/events?sessionId=s&turnId=t`, {
        headers: auth(user.token),
      })
      assert.equal(response.status, 503, failureCode)
      assert.deepEqual((await response.json()).error, {
        code: failureCode,
        message: 'turn runtime is restarting; retry shortly',
        action: 'retry',
      })
    }
  }, { resolveEngine })
})

test('turn routes expose host configuration and cleanup failures as actionable 503 responses', async () => {
  const user = issueTestSession({ email: 'turn-host-cleanup-unavailable@example.com' })
  let failureCode = 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED'
  const resolveEngine = () => {
    const error = new Error('host unavailable')
    error.code = failureCode
    error.retryable = true
    throw error
  }
  const cases = [
    {
      code: 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
      message: 'turn runtime is not ready because compaction storage is not configured',
      action: 'restart_runtime',
    },
    {
      code: 'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
      message: 'turn runtime cleanup is incomplete; retry shortly',
      action: 'retry',
    },
    {
      code: 'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
      message: 'turn runtime cleanup is incomplete; retry shortly',
      action: 'retry',
    },
    {
      code: 'TURN_ENGINE_HOST_CLEANUP_FAILED',
      message: 'turn runtime cleanup is incomplete; retry shortly',
      action: 'retry',
    },
  ]

  await withTurnRouteEngine(null, async (routeOrigin) => {
    for (const expected of cases) {
      failureCode = expected.code
      const response = await fetch(`${routeOrigin}/api/turns/events?sessionId=s&turnId=t`, {
        headers: auth(user.token),
      })
      assert.equal(response.status, 503, failureCode)
      assert.deepEqual((await response.json()).error, expected)
    }
  }, { resolveEngine })
})

test('turn run route preserves structured model readiness failures', async () => {
  const user = issueTestSession({ email: 'turn-readiness-route@example.com' })
  let failure = new ModelReadinessError('MODEL_CONFIG_MISSING', {
    details: { missing: ['MODEL_BASE_URL', 'MODEL_NAME'] },
  })
  const engine = {
    async startTurn() { throw failure },
  }
  await withTurnRouteEngine(engine, async (routeOrigin) => {
    const post = () => fetch(`${routeOrigin}/api/turns/run`, {
      method: 'POST',
      headers: auth(user.token),
      body: JSON.stringify({ sessionId: 'readiness-session', content: 'hello' }),
    })

    const missing = await post()
    assert.equal(missing.status, 503)
    const missingError = (await missing.json()).error
    assert.match(missingError.message, /设置.*模型/)
    assert.deepEqual(failure.details, { missing: ['MODEL_BASE_URL', 'MODEL_NAME'] })
    assert.deepEqual({ ...missingError, message: '<localized>' }, {
      code: 'MODEL_CONFIG_MISSING',
      message: '<localized>',
      action: 'configure_model',
      providerId: null,
      modelName: null,
      configRevision: null,
    })
    assert.equal(Object.hasOwn(missingError, 'details'), false)
    assert.doesNotMatch(JSON.stringify(missingError), /"missing"|MODEL_BASE_URL|MODEL_NAME/)

    failure = new ModelReadinessError('MODEL_PROVIDER_CONFIG_CHANGED', {
      providerId: 'provider-uuid',
      modelName: 'bound-model',
      configRevision: 7,
      details: { expectedRevision: 7, currentRevision: 8 },
    })
    const changed = await post()
    assert.equal(changed.status, 409)
    assert.deepEqual((await changed.json()).error, {
      code: 'MODEL_PROVIDER_CONFIG_CHANGED',
      message: '任务绑定的模型 Provider 配置已变更或不可用。为避免静默切换模型，请重新测试 Provider 后创建新任务。',
      action: 'recreate_job',
      providerId: 'provider-uuid',
      modelName: 'bound-model',
      configRevision: 7,
    })
    assert.deepEqual(failure.details, { expectedRevision: 7, currentRevision: 8 })
  })
})

test('turn resume route forwards only an explicit recovery retry request', async () => {
  const user = issueTestSession({ email: 'turn-recovery-route@example.com' })
  const captured = []
  const engine = {
    async resumeTurn(input) {
      captured.push(input)
      return { sessionId: input.sessionId, turnId: input.turnId, status: 'running' }
    },
  }
  await withTurnRouteEngine(engine, async (routeOrigin) => {
    for (const retryRecovery of [undefined, true]) {
      const response = await fetch(`${routeOrigin}/api/turns/recovery-route-turn/resume`, {
        method: 'POST',
        headers: auth(user.token),
        body: JSON.stringify({
          sessionId: 'recovery-route-session',
          ...(retryRecovery ? { retryRecovery } : {}),
        }),
      })
      assert.equal(response.status, 202)
    }
  })
  assert.equal(captured[0].retryRecovery, false)
  assert.equal(captured[1].retryRecovery, true)
})

test('turn resume route forwards only an explicit failed retry request', async () => {
  const user = issueTestSession({ email: 'turn-failed-retry-route@example.com' })
  const captured = []
  const engine = {
    async resumeTurn(input) {
      captured.push(input)
      return { sessionId: input.sessionId, turnId: input.turnId, status: 'running' }
    },
  }
  await withTurnRouteEngine(engine, async (routeOrigin) => {
    for (const retryFailed of [undefined, true]) {
      const response = await fetch(`${routeOrigin}/api/turns/failed-retry-route-turn/resume`, {
        method: 'POST',
        headers: auth(user.token),
        body: JSON.stringify({
          sessionId: 'failed-retry-route-session',
          ...(retryFailed ? { retryFailed } : {}),
        }),
      })
      assert.equal(response.status, 202)
    }
  })
  assert.equal(captured[0].retryFailed, false)
  assert.equal(captured[1].retryFailed, true)
})

test('turn resume route returns a structured manual-repair dead letter', async () => {
  const user = issueTestSession({ email: 'turn-blocked-route@example.com' })
  const engine = {
    async resumeTurn() {
      const error = new Error('permission context changed; repair it before retrying')
      error.code = 'TURN_RECOVERY_DEAD_LETTER'
      error.statusCode = 409
      error.recovery = {
        status: 'dead_letter',
        retryable: false,
        manualRetryable: true,
        attemptCount: 1,
        errorCode: 'TURN_PERMISSION_CONTEXT_DRIFT',
        errorMessage: 'permission context changed; repair it before retrying',
      }
      throw error
    },
  }
  await withTurnRouteEngine(engine, async (routeOrigin) => {
    const response = await fetch(`${routeOrigin}/api/turns/blocked-route-turn/resume`, {
      method: 'POST',
      headers: auth(user.token),
      body: JSON.stringify({ sessionId: 'blocked-route-session' }),
    })
    assert.equal(response.status, 409)
    assert.deepEqual((await response.json()).error, {
      code: 'TURN_RECOVERY_DEAD_LETTER',
      message: 'permission context changed; repair it before retrying',
      recovery: {
        status: 'dead_letter',
        retryable: false,
        manualRetryable: true,
        attemptCount: 1,
        error: {
          code: 'TURN_PERMISSION_CONTEXT_DRIFT',
          message: 'permission context changed; repair it before retrying',
        },
      },
    })
  })
})

test('turn steering route preserves validation, ownership, conflict, and idempotency semantics', async () => {
  const user = issueTestSession({ email: 'turn-route-steering@example.com' })
  const requests = []
  const acceptedByRequestId = new Map()
  let cancellationCalls = 0
  const engine = {
    async steerTurn(input) {
      requests.push(input)
      if (!input.content) {
        throw new TurnSteeringError(
          'TURN_STEERING_CONTENT_REQUIRED',
          'steering content is required',
        )
      }
      if (input.content === 'missing') {
        throw new TurnSteeringError('TURN_NOT_FOUND', 'turn not found', 404)
      }
      if (input.content === 'closed') {
        throw new TurnSteeringError('TURN_STEERING_INBOX_CLOSED', 'turn is finishing', 409)
      }
      const previous = acceptedByRequestId.get(input.clientRequestId)
      if (previous) return previous
      const steering = {
        id: `steering-${acceptedByRequestId.size + 1}`,
        turnId: input.turnId,
        clientRequestId: input.clientRequestId,
        content: input.content,
        status: 'queued',
      }
      acceptedByRequestId.set(input.clientRequestId, steering)
      return steering
    },
    cancelTurn() {
      cancellationCalls += 1
      throw new Error('steering must not cancel the active turn')
    },
  }

  await withTurnRouteEngine(engine, async (routeOrigin) => {
    const endpoint = `${routeOrigin}/api/turns/turn-steering-route/steer`
    const post = (body, headers = auth(user.token)) => fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const unauthorized = await post({ sessionId: 's', content: 'hello', clientRequestId: 'u' }, {})
    assert.equal(unauthorized.status, 401)

    const invalid = await post({ sessionId: 's', clientRequestId: 'invalid' })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error.code, 'TURN_STEERING_CONTENT_REQUIRED')

    const missing = await post({ sessionId: 's', content: 'missing', clientRequestId: 'missing' })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'TURN_NOT_FOUND')

    const closed = await post({ sessionId: 's', content: 'closed', clientRequestId: 'closed' })
    assert.equal(closed.status, 409)
    assert.equal((await closed.json()).error.code, 'TURN_STEERING_INBOX_CLOSED')

    const payload = { sessionId: 's', content: 'continue with this', clientRequestId: 'request-1' }
    const accepted = await post(payload)
    assert.equal(accepted.status, 202)
    const first = (await accepted.json()).steering
    assert.equal(first.id, 'steering-1')

    const replayed = await post(payload)
    assert.equal(replayed.status, 202)
    assert.deepEqual((await replayed.json()).steering, first)
  })

  assert.equal(cancellationCalls, 0)
  assert.equal(requests.length, 5, 'unauthorized requests must not reach the turn engine')
  assert.equal(requests.at(-1).userId, user.userId)
  assert.equal(requests.at(-1).authMode, 'multi_user')
})

test('a chat session id cannot be used as a bearer token', async () => {
  const user = issueTestSession({ email: 'turn-route-chat-token@example.com' })
  upsertSession({ id: 'turn-route-chat-token', userId: user.userId, title: 'Not an auth token' })
  const response = await fetch(`${origin}/api/turns/events?sessionId=s&turnId=t`, {
    headers: auth('turn-route-chat-token'),
  })
  assert.equal(response.status, 401)
})

test('local auth claims legacy sessions before resuming or cancelling turns', async () => {
  const current = issueTestSession({ email: 'turn-route-local-owner@example.com' })
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(current.userId)

  createLegacyTurn({
    ownerId: 'turn-route-local-cancel-owner',
    sessionId: 'turn-route-local-cancel-session',
    turnId: 'turn-route-local-cancel-turn',
  })
  const cancelled = await fetch(`${origin}/api/turns/turn-route-local-cancel-turn/cancel`, {
    method: 'POST',
    headers: auth(current.token),
    body: JSON.stringify({ sessionId: 'turn-route-local-cancel-session' }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).turn.status, 'cancelled')
  assert.equal(
    getDb().prepare('SELECT user_id FROM sessions WHERE token = ?').get('turn-route-local-cancel-session').user_id,
    current.userId,
  )

  createLegacyTurn({
    ownerId: 'turn-route-local-resume-owner',
    sessionId: 'turn-route-local-resume-session',
    turnId: 'turn-route-local-resume-turn',
    terminal: true,
  })
  const resumed = await fetch(`${origin}/api/turns/turn-route-local-resume-turn/resume`, {
    method: 'POST',
    headers: auth(current.token),
    body: JSON.stringify({ sessionId: 'turn-route-local-resume-session' }),
  })
  assert.equal(resumed.status, 202)
  assert.equal((await resumed.json()).turn.status, 'completed')
  assert.equal(
    getDb().prepare('SELECT user_id FROM sessions WHERE token = ?').get('turn-route-local-resume-session').user_id,
    current.userId,
  )
})

test('runtime multi-user config never claims another user chat', async () => {
  const current = issueTestSession({ email: 'turn-route-current@example.com' })
  const legacyUserId = 'turn-route-legacy-owner'
  const sessionId = 'turn-route-legacy-session'
  createUser({ id: legacyUserId, email: 'turn-route-legacy-owner@example.com' })
  upsertSession({ id: sessionId, userId: legacyUserId, title: 'Legacy multi-user chat' })
  createLegacyTurn({
    ownerId: 'turn-route-multi-cancel-owner',
    sessionId: 'turn-route-multi-cancel-session',
    turnId: 'turn-route-multi-cancel-turn',
  })
  createLegacyTurn({
    ownerId: 'turn-route-multi-resume-owner',
    sessionId: 'turn-route-multi-resume-session',
    turnId: 'turn-route-multi-resume-turn',
    terminal: true,
  })
  getDb().prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(current.userId)

  const previousAuthMode = process.env.AUTH_MODE
  process.env.AUTH_MODE = 'local'
  const multiUserServer = createAppServer({ getEnv: () => ({ AUTH_MODE: 'multi_user' }) })
  await new Promise((resolve) => multiUserServer.listen(0, '127.0.0.1', resolve))
  const multiUserOrigin = `http://127.0.0.1:${multiUserServer.address().port}`
  try {
    const response = await fetch(`${multiUserOrigin}/api/turns/run`, {
      method: 'POST',
      headers: auth(current.token),
      body: JSON.stringify({ sessionId, turnId: 'turn-route-no-claim', content: 'do not claim' }),
    })
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'SESSION_NOT_FOUND')
    assert.equal(getDb().prepare('SELECT user_id FROM sessions WHERE token = ?').get(sessionId).user_id, legacyUserId)

    for (const action of ['cancel', 'resume']) {
      const actionSessionId = `turn-route-multi-${action}-session`
      const actionTurnId = `turn-route-multi-${action}-turn`
      const actionOwnerId = `turn-route-multi-${action}-owner`
      const actionResponse = await fetch(`${multiUserOrigin}/api/turns/${actionTurnId}/${action}`, {
        method: 'POST',
        headers: auth(current.token),
        body: JSON.stringify({ sessionId: actionSessionId }),
      })
      assert.equal(actionResponse.status, 404)
      assert.equal((await actionResponse.json()).error.code, 'TURN_NOT_FOUND')
      assert.equal(
        getDb().prepare('SELECT user_id FROM sessions WHERE token = ?').get(actionSessionId).user_id,
        actionOwnerId,
      )
    }
  } finally {
    await new Promise((resolve) => multiUserServer.close(resolve))
    if (previousAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = previousAuthMode
  }
})

test('turn event endpoint is read-only and replays ordered server events', async () => {
  const user = issueTestSession({ email: 'turn-route@example.com' })
  upsertSession({ id: 'session-route', userId: user.userId, title: 'Route turn' })
  for (const [id, sequence, type] of [['event-1', 0, 'turn.started'], ['event-2', 1, 'turn.completed']]) {
    appendTurnEvent({
      userId: user.userId,
      event: createTurnEvent({ id, sessionId: 'session-route', turnId: 'turn-route', sequence, type, payload: {}, createdAt: sequence + 1 }),
    })
  }
  const writeResponse = await fetch(`${origin}/api/turns/events`, {
    method: 'POST', headers: auth(user.token), body: '{}',
  })
  assert.equal(writeResponse.status, 405)
  const response = await fetch(`${origin}/api/turns/events?sessionId=session-route&turnId=turn-route`, { headers: auth(user.token) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).events.map((event) => event.id), ['event-1', 'event-2'])

  const afterZero = await fetch(`${origin}/api/turns/events?sessionId=session-route&turnId=turn-route&after=0`, { headers: auth(user.token) })
  assert.deepEqual((await afterZero.json()).events.map((event) => event.id), ['event-2'])

  const stream = await fetch(`${origin}/api/turns/stream?sessionId=session-route&turnId=turn-route&after=0`, { headers: auth(user.token) })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(stream.headers.get('x-accel-buffering'), 'no')
  assert.equal(stream.headers.get('x-gugo-turn-event-version'), null)
  const frames = await stream.text()
  assert.match(frames, /event: ready/)
  assert.match(frames, /id: 1/)
  assert.match(frames, /event: turn_event/)
  assert.match(frames, /"type":"turn.completed"/)
  assert.doesNotMatch(frames, /"type":"turn.event","event":/)
})

test('turn event SSE negotiates the shared v1 envelope and rejects unknown versions', async () => {
  const user = issueTestSession({ email: 'turn-route-envelope@example.com' })
  const sessionId = 'session-route-envelope'
  const turnId = 'turn-route-envelope'
  upsertSession({ id: sessionId, userId: user.userId, title: 'Envelope turn' })
  for (const [id, sequence, type] of [
    ['envelope-event-0', 0, 'turn.started'],
    ['envelope-event-1', 1, 'turn.completed'],
  ]) {
    appendTurnEvent({
      userId: user.userId,
      event: createTurnEvent({
        id, sessionId, turnId, sequence, type, payload: {}, createdAt: sequence + 1,
      }),
    })
  }

  const stream = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&after=0&turnEventVersion=1`,
    { headers: auth(user.token) },
  )
  assert.equal(stream.status, 200)
  assert.equal(stream.headers.get('x-gugo-turn-event-version'), '1')
  const frames = await stream.text()
  assert.match(
    frames,
    /event: turn_event\ndata: \{"v":1,"type":"turn.event","event":\{"id":"envelope-event-1"/,
  )

  const unsupported = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&turnEventVersion=2`,
    { headers: auth(user.token) },
  )
  assert.equal(unsupported.status, 400)
  assert.deepEqual((await unsupported.json()).error, {
    code: 'TURN_EVENT_TRANSPORT_VERSION_UNSUPPORTED',
    message: 'Turn event transport v1 is required',
    expectedVersion: 1,
    receivedVersion: '2',
  })

  const emptyVersion = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&turnEventVersion=`,
    { headers: auth(user.token) },
  )
  assert.equal(emptyVersion.status, 400)
  assert.deepEqual((await emptyVersion.json()).error, {
    code: 'TURN_EVENT_TRANSPORT_VERSION_UNSUPPORTED',
    message: 'Turn event transport v1 is required',
    expectedVersion: 1,
    receivedVersion: '',
  })
})

test('turn event replay and SSE cross superseded checkpoints without hiding later gaps', async () => {
  const user = issueTestSession({ email: 'turn-route-compacted@example.com' })
  const sessionId = 'session-route-compacted'
  const turnId = 'turn-route-compacted'
  upsertSession({ id: sessionId, userId: user.userId, title: 'Compacted route turn' })
  const append = (sequence, type, payload = {}, checkpointState = null) => appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: `${turnId}:${sequence}`, sessionId, turnId, sequence, type, payload, createdAt: sequence + 1,
    }),
    checkpointState,
  })
  append(0, 'turn.started')
  append(1, 'turn.checkpoint', { storage: 'turn_checkpoints', checkpointVersion: 1 }, { iterations: 1 })
  append(2, 'assistant.delta', { text: 'kept' })
  append(3, 'turn.checkpoint', { storage: 'turn_checkpoints', checkpointVersion: 1 }, { iterations: 2 })
  append(4, 'turn.completed', { text: 'done' })

  const replay = await fetch(
    `${origin}/api/turns/events?sessionId=${sessionId}&turnId=${turnId}&after=0&limit=1`,
    { headers: auth(user.token) },
  )
  const replayEvents = (await replay.json()).events
  assert.equal(replayEvents[0].sequence, 2)
  assert.equal(replayEvents[0].compactedThrough, 3)

  const stream = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&after=0`,
    { headers: auth(user.token) },
  )
  const frames = await stream.text()
  assert.doesNotMatch(frames, /event: error/)
  assert.match(frames, /"sequence":2[^\n]*"compactedThrough":3/)
  assert.match(frames, /"type":"turn.completed"/)
})

test('turn activity is live-only, id-less, and does not consume the durable cursor', async () => {
  const user = issueTestSession({ email: 'turn-route-activity@example.com' })
  const sessionId = 'session-route-activity'
  const turnId = 'turn-route-activity'
  upsertSession({ id: sessionId, userId: user.userId, title: 'Activity turn' })
  appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: 'activity-started', sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: {}, createdAt: Date.now(),
    }),
  })

  const stream = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&after=-1`,
    { headers: auth(user.token) },
  )
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let frames = ''
  while (!frames.includes('"id":"activity-started"')) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    frames += decoder.decode(chunk.value, { stream: true })
  }
  publishTurnActivity({
    userId: user.userId,
    activity: createTurnActivity({
      sessionId,
      turnId,
      kind: 'tool_call_ready',
      toolName: 'bash_exec',
      modelName: 'stub-model',
      createdAt: Date.now(),
    }),
  })
  appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: 'activity-terminal', sessionId, turnId, sequence: 1,
      type: 'turn.completed', payload: {}, createdAt: Date.now() + 1,
    }),
  })

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    frames += decoder.decode(chunk.value, { stream: true })
  }
  frames += decoder.decode()
  const parsedFrames = frames.split(/\r?\n\r?\n/).filter(Boolean)
  const activityFrame = parsedFrames.find((frame) => frame.includes('event: turn_activity'))
  const durableFrame = parsedFrames.find((frame) => frame.includes('"id":"activity-terminal"'))
  assert.ok(activityFrame)
  assert.doesNotMatch(activityFrame, /^id:/m)
  assert.match(activityFrame, /"kind":"tool_call_ready"/)
  assert.match(durableFrame, /^id: 1$/m)

  const replay = await fetch(
    `${origin}/api/turns/events?sessionId=${sessionId}&turnId=${turnId}`,
    { headers: auth(user.token) },
  )
  assert.deepEqual(
    (await replay.json()).events.map((event) => event.id),
    ['activity-started', 'activity-terminal'],
  )
})

test('turn event stream closes an interrupted attempt while keeping it resumable', async () => {
  const user = issueTestSession({ email: 'turn-route-interrupted@example.com' })
  const sessionId = 'session-route-interrupted'
  const turnId = 'turn-route-interrupted'
  upsertSession({ id: sessionId, userId: user.userId, title: 'Interrupted route turn' })
  appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: `${turnId}:started`, sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: { content: 'recover me' }, createdAt: 1,
    }),
  })
  appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: `${turnId}:interrupted`, sessionId, turnId, sequence: 1,
      type: 'turn.interrupted',
      payload: {
        code: 'MODEL_HTTP_503',
        message: 'upstream unavailable',
        retryable: true,
        text: '',
        artifactIds: [],
        iterations: 2,
      },
      createdAt: 2,
    }),
  })

  const stream = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}&after=0`,
    { headers: auth(user.token) },
  )
  const frames = await stream.text()
  assert.match(frames, /"type":"turn.interrupted"/)

  const status = await fetch(
    `${origin}/api/turns/${turnId}?sessionId=${sessionId}`,
    { headers: auth(user.token) },
  )
  assert.equal((await status.json()).turn.status, 'interrupted')
})

test('turn event stream polls cross-instance database writes without duplicating local events', async () => {
  const user = issueTestSession({ email: 'turn-route-cross-instance@example.com' })
  const sessionId = 'session-route-cross-instance'
  const turnId = 'turn-route-cross-instance'
  upsertSession({ id: sessionId, userId: user.userId, title: 'Cross-instance turn' })

  const stream = await fetch(
    `${origin}/api/turns/stream?sessionId=${sessionId}&turnId=${turnId}`,
    { headers: auth(user.token) },
  )
  assert.equal(stream.status, 200)

  appendTurnEvent({
    userId: user.userId,
    event: createTurnEvent({
      id: 'cross-instance-local', sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: {}, createdAt: Date.now(),
    }),
  })

  // Writing the row directly simulates an event committed by another Node.js
  // instance, whose process-local subscribers cannot notify this SSE handler.
  getDb().prepare(`
    INSERT INTO turn_events
      (id, user_id, session_id, turn_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'cross-instance-remote', user.userId, sessionId, turnId, 1,
    'turn.completed', '{}', Date.now() + 1,
  )

  const frames = await stream.text()
  assert.equal(frames.match(/"id":"cross-instance-local"/g)?.length, 1)
  assert.equal(frames.match(/"id":"cross-instance-remote"/g)?.length, 1)
  assert.ok(frames.indexOf('cross-instance-local') < frames.indexOf('cross-instance-remote'))
})

test('turn event replay is isolated per user', async () => {
  const stranger = issueTestSession({ email: 'turn-route-stranger@example.com' })
  const response = await fetch(`${origin}/api/turns/events?sessionId=session-route&turnId=turn-route`, { headers: auth(stranger.token) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).events, [])
})
