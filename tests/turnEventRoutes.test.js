import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-event-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, createUser, getDb } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function auth(token) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }

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
  const frames = await stream.text()
  assert.match(frames, /event: ready/)
  assert.match(frames, /id: 1/)
  assert.match(frames, /event: turn_event/)
  assert.match(frames, /"type":"turn.completed"/)
})

test('turn event replay is isolated per user', async () => {
  const stranger = issueTestSession({ email: 'turn-route-stranger@example.com' })
  const response = await fetch(`${origin}/api/turns/events?sessionId=session-route&turnId=turn-route`, { headers: auth(stranger.token) })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).events, [])
})
