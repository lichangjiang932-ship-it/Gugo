import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'
import { closeDb } from '../server/db.js'
import { resolveUsageEventLimit } from '../server/routes/usageRoutes.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { appendTurnEvent } from '../server/services/turnEventStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { USAGE_REPORT_LIMITS } from '../shared/usageReportLimits.js'
import { issueTestSession } from './helpers/testAuth.js'

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
})

let sequence = 0
function seed(userId, sessionId, { modelName = 'model-a', promptTokens = 10, completionTokens = 2 } = {}) {
  upsertSession({ id: sessionId, userId, title: sessionId })
  const turnId = `${sessionId}-turn-1`
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      userId, sessionId, turnId, id: `${turnId}-0`, sequence: 0, type: 'turn.started', payload: {},
    }),
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      userId,
      sessionId,
      turnId,
      id: `${turnId}-1`,
      sequence: 1,
      type: 'model.phase',
      payload: {
        phase: 'completed',
        modelName,
        usage: { promptTokens, completionTokens, cacheHitTokens: 6, cacheMissTokens: 4 },
      },
    }),
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      userId,
      sessionId,
      turnId,
      id: `${turnId}-2`,
      sequence: 2,
      type: 'turn.completed',
      payload: {
        text: 'done',
        turnModelUsage: { promptTokens, completionTokens, cacheHitTokens: 6, cacheMissTokens: 4 },
      },
    }),
  })
  sequence += 1
}

function get(path, token) {
  return fetch(`${origin}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

test('the usage endpoint requires a session and rejects non-report requests', async () => {
  const unauthorized = await get('/api/usage/report')
  assert.equal(unauthorized.status, 401)

  const session = issueTestSession({ email: `usage-route-routing-${sequence}@example.com` })
  assert.equal((await get('/api/usage/unknown', session.token)).status, 404)

  const posted = await fetch(`${origin}/api/usage/report`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: '{}',
  })
  assert.equal(posted.status, 405)
})

test('the report aggregates persisted turn and model usage for the caller', async () => {
  const session = issueTestSession({ email: `usage-route-report-${sequence}@example.com` })
  seed(session.userId, `usage-report-session-${sequence}`, { promptTokens: 100, completionTokens: 20 })
  seed(session.userId, `usage-report-session-${sequence}-b`, {
    modelName: 'model-b', promptTokens: 50, completionTokens: 5,
  })

  const response = await get('/api/usage/report', session.token)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.report.turns.total, 2)
  assert.equal(body.report.turns.completed, 2)
  assert.equal(body.report.totals.promptTokens, 150)
  assert.equal(body.report.totals.completionTokens, 25)
  assert.equal(body.report.cacheHitRatePercent, 60)
  assert.deepEqual(body.report.byModel.map((entry) => entry.key).sort(), ['model-a', 'model-b'])
  assert.equal(body.report.bySession.length, 2)
})

test('a report never includes another owner rows', async () => {
  const mine = issueTestSession({ email: `usage-route-owner-a-${sequence}@example.com` })
  const theirs = issueTestSession({ email: `usage-route-owner-b-${sequence}@example.com` })
  const mySession = `usage-owner-a-${sequence}`
  seed(mine.userId, mySession, { promptTokens: 7, completionTokens: 1 })
  seed(theirs.userId, `usage-owner-b-${sequence}`, { promptTokens: 999_999, completionTokens: 999_999 })

  const response = await get('/api/usage/report', mine.token)
  const { report } = await response.json()
  assert.equal(report.totals.promptTokens, 7)
  assert.deepEqual(report.bySession.map((entry) => entry.key), [mySession])
})

test('the endpoint resolves the event window to the shared default and bounded range', () => {
  for (const missing of [null, undefined, '', '   ']) {
    assert.equal(resolveUsageEventLimit(missing), USAGE_REPORT_LIMITS.DEFAULT_EVENTS, String(missing))
  }
  // `Number(null)` is 0 and a non-numeric value is NaN; neither may silently
  // become "one event", which would report a fraction of the usage as complete.
  assert.equal(resolveUsageEventLimit('abc'), USAGE_REPORT_LIMITS.DEFAULT_EVENTS)
  assert.equal(resolveUsageEventLimit('0'), 1)
  assert.equal(resolveUsageEventLimit('-5'), 1)
  assert.equal(resolveUsageEventLimit('250'), 250)
  assert.equal(resolveUsageEventLimit('250.7'), 250)
  assert.equal(resolveUsageEventLimit('1e9'), USAGE_REPORT_LIMITS.MAX_EVENTS)
})

test('a malformed since filter is refused instead of reading another window', async () => {
  const session = issueTestSession({ email: `usage-route-since-${sequence}@example.com` })
  for (const since of ['yesterday', '2026-13-01', '0']) {
    const response = await get(`/api/usage/report?since=${encodeURIComponent(since)}`, session.token)
    assert.equal(response.status, 400, since)
    assert.equal((await response.json()).code, 'USAGE_SINCE_INVALID', since)
  }

  const future = await get('/api/usage/report?since=2099-01-01', session.token)
  assert.equal(future.status, 200)
  assert.equal((await future.json()).report.turns.total, 0)
})
