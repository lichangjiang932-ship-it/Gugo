import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-session-pinning-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { getDb } = await import('../server/db.js')
const {
  getSession,
  listSessions,
  pinSession,
  unpinSession,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function cleanDb() {
  const db = getDb()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM login_codes').run()
  db.prepare('DELETE FROM users').run()
  db.prepare('DELETE FROM rate_limits').run()
}

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test.beforeEach(cleanDb)
test.after(cleanDb)

test('session pinning persists stable order and stays isolated by user', () => {
  const owner = issueTestSession({ email: `pin-owner-${process.pid}@example.com` })
  const other = issueTestSession({ email: `pin-other-${process.pid}@example.com` })
  upsertSession({ id: 'pin-old', userId: owner.userId, title: 'Older pin', createdAt: 100, updatedAt: 200 })
  upsertSession({ id: 'pin-new', userId: owner.userId, title: 'Newer pin', createdAt: 300, updatedAt: 400 })
  upsertSession({ id: 'recent-unpinned', userId: owner.userId, title: 'Recent', createdAt: 500, updatedAt: 9000 })
  upsertSession({ id: 'other-session', userId: other.userId, title: 'Other', createdAt: 600, updatedAt: 10000 })

  assert.equal(pinSession({ userId: owner.userId, sessionId: 'pin-old', now: 5000 }).pinnedAt, 5000)
  assert.equal(pinSession({ userId: owner.userId, sessionId: 'pin-new', now: 6000 }).pinnedAt, 6000)
  assert.equal(pinSession({ userId: other.userId, sessionId: 'pin-old', now: 7000 }), null)

  assert.deepEqual(listSessions({ userId: owner.userId }).map(({ id }) => id), [
    'pin-new', 'pin-old', 'recent-unpinned',
  ])
  assert.equal(getSession({ userId: owner.userId, sessionId: 'pin-old' }).pinnedAt, 5000)
  assert.equal(getSession({ userId: other.userId, sessionId: 'pin-old' }), null)

  assert.equal(unpinSession({ userId: owner.userId, sessionId: 'pin-old' }).pinnedAt, null)
  assert.deepEqual(listSessions({ userId: owner.userId }).map(({ id }) => id), [
    'pin-new', 'recent-unpinned', 'pin-old',
  ])
})

test('session pin routes persist metadata and reject cross-user mutation', async () => {
  const owner = issueTestSession({ email: `pin-route-owner-${process.pid}@example.com` })
  const other = issueTestSession({ email: `pin-route-other-${process.pid}@example.com` })
  upsertSession({ id: 'route-pin', userId: owner.userId, title: 'Route pin', createdAt: 100, updatedAt: 200 })

  await withServer(async (baseUrl) => {
    const ownerHeaders = { Authorization: `Bearer ${owner.token}` }
    const otherHeaders = { Authorization: `Bearer ${other.token}` }

    const pinned = await fetch(`${baseUrl}/api/sessions/route-pin/pin`, { method: 'POST', headers: ownerHeaders })
    assert.equal(pinned.status, 200)
    const pinnedBody = await pinned.json()
    assert.ok(Number.isFinite(pinnedBody.session.pinnedAt))

    const listed = await fetch(`${baseUrl}/api/sessions?archived=false`, { headers: ownerHeaders })
    const listedBody = await listed.json()
    assert.equal(listedBody.sessions[0].id, 'route-pin')
    assert.equal(listedBody.sessions[0].pinnedAt, pinnedBody.session.pinnedAt)

    const crossUser = await fetch(`${baseUrl}/api/sessions/route-pin/unpin`, { method: 'POST', headers: otherHeaders })
    assert.equal(crossUser.status, 404)
    assert.equal(getSession({ userId: owner.userId, sessionId: 'route-pin' }).pinnedAt, pinnedBody.session.pinnedAt)

    const unpinned = await fetch(`${baseUrl}/api/sessions/route-pin/unpin`, { method: 'POST', headers: ownerHeaders })
    assert.equal(unpinned.status, 200)
    assert.equal((await unpinned.json()).session.pinnedAt, null)

    const unauthorized = await fetch(`${baseUrl}/api/sessions/route-pin/pin`, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
  })
})
