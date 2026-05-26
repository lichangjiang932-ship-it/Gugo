import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-notification-routes-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { createNotification } = await import('../server/services/notificationsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

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

test('GET /api/notifications returns 200 with user notifications', async () => {
  const { token, userId } = issueTestSession()
  createNotification({ id: 'route-list-1', userId, title: 'Listed', now: 1000 })

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/notifications?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.notifications[0].id, 'route-list-1')
  })
})

test('GET /api/notifications/unread-count returns 200', async () => {
  const { token, userId } = issueTestSession()
  createNotification({ id: 'route-count-1', userId, title: 'Unread', now: 1000 })

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.count, 1)
  })
})

test('POST /api/notifications/mark-read returns 200', async () => {
  const { token, userId } = issueTestSession()
  createNotification({ id: 'route-mark-1', userId, title: 'Unread', now: 1000 })

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/notifications/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: ['route-mark-1'] }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.unreadCount, 0)
  })
})

test('notification routes reject unauthenticated requests with 401', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/notifications`)
    assert.equal(res.status, 401)
  })
})
