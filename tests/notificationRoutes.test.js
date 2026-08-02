import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// ★ 目录只按 pid 区分是不够的:PID 会被系统回收,撞上以前某次跑测试
// 留下的同名目录就会读到那次的 DB —— 而本文件用的是 'route-list-1' 这类
// 固定 id,于是 createNotification 直接 UNIQUE constraint failed。
// (临时目录里已经堆了两千多个 yma-* 残留,撞上只是时间问题。)
// 加一个随机后缀，每次跑都是全新的空库。
process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'yma-notification-routes-tests',
  `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
)

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
