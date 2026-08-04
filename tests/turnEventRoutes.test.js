import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-event-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
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

test('turn event endpoints require authentication', async () => {
  assert.equal((await fetch(`${origin}/api/turns/events?sessionId=s&turnId=t`)).status, 401)
  assert.equal((await fetch(`${origin}/api/turns/stream?sessionId=s&turnId=t`)).status, 401)
  assert.equal((await fetch(`${origin}/api/turns/events`, { method: 'POST', body: '{}' })).status, 401)
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
