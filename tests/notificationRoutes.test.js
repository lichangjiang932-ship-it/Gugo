import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
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
const { handleNotificationRequest } = await import('../server/routes/notificationRoutes.js')
const { createNotification } = await import('../server/services/notificationsStore.js')
const { createStreamTicket } = await import('../server/utils/streamTicket.js')
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

    const ticketRes = await fetch(`${baseUrl}/api/notifications/stream-ticket`, { method: 'POST' })
    assert.equal(ticketRes.status, 401)
  })
})

test('notification SSE exchanges account auth for a one-time scoped ticket', async () => {
  const { token } = issueTestSession()
  await withServer(async (baseUrl) => {
    const ticketResponse = await fetch(`${baseUrl}/api/notifications/stream-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(ticketResponse.status, 201)
    const { ticket, expiresIn } = await ticketResponse.json()
    assert.equal(expiresIn, 60)
    assert.match(ticket, /^st_[a-f0-9]{48}$/)
    assert.equal(ticket.includes(token), false)

    const controller = new AbortController()
    const streamResponse = await fetch(
      `${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`,
      { signal: controller.signal },
    )
    assert.equal(streamResponse.status, 200)
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/)
    assert.equal(streamResponse.headers.get('cache-control'), 'no-cache, no-transform')
    assert.equal(streamResponse.headers.get('x-accel-buffering'), 'no')
    const reader = streamResponse.body.getReader()
    const firstChunk = await reader.read()
    assert.match(new TextDecoder().decode(firstChunk.value), /event: ready[\s\S]*data: \{"ok":true\}/)
    controller.abort()
    await reader.cancel().catch(() => {})

    const replay = await fetch(
      `${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`,
    )
    assert.equal(replay.status, 401)

    const durableTokenQuery = await fetch(
      `${baseUrl}/api/notifications/stream?token=${encodeURIComponent(token)}`,
    )
    assert.equal(durableTokenQuery.status, 401)
  })
})

test('notification SSE rejects a ticket issued for another stream scope', async () => {
  const { userId } = issueTestSession()
  const wrongScopeTicket = createStreamTicket(userId, { scope: 'channel:not-notifications' })
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/notifications/stream?ticket=${encodeURIComponent(wrongScopeTicket)}`,
    )
    assert.equal(response.status, 401)
  })
})

test('notification SSE sends heartbeats and cleans up once across both close signals', { concurrency: false }, async () => {
  const { userId } = issueTestSession()
  const ticket = createStreamTicket(userId, { scope: 'notifications' })
  const request = Readable.from([])
  request.method = 'GET'
  request.url = `/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`
  request.headers = {}
  const listeners = new Map()
  const response = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    write(chunk) { this.chunks.push(String(chunk)) },
    on(event, listener) {
      const current = listeners.get(event) || []
      current.push(listener)
      listeners.set(event, current)
      return this
    },
    emit(event) {
      for (const listener of listeners.get(event) || []) listener()
    },
  }

  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let heartbeat = null
  globalThis.setInterval = (callback, delay) => {
    heartbeat = {
      callback,
      delay,
      unrefCalled: false,
      unref() { this.unrefCalled = true },
    }
    return heartbeat
  }
  globalThis.clearInterval = (timer) => { timer.clearCount = (timer.clearCount || 0) + 1 }
  try {
    await handleNotificationRequest(request, response)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['Cache-Control'], 'no-cache, no-transform')
    assert.equal(response.headers['X-Accel-Buffering'], 'no')
    assert.equal(heartbeat.delay, 15_000)
    assert.equal(heartbeat.unrefCalled, true)
    heartbeat.callback()
    assert.match(response.chunks.join(''), /event: ready[\s\S]*: keep-alive\n\n/)

    request.emit('close')
    response.emit('close')
    assert.equal(heartbeat.clearCount, 1)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})
