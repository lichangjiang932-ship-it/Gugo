import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import {
  createTurnActivity,
  createTurnEvent,
  createTurnEventTransportEnvelope,
} from '../shared/turnEvents.js'
import { createTurnWebSocketFrame } from '../shared/turnWebSocketProtocol.js'
import { closeDb } from '../server/db.js'
import { publishTurnActivity } from '../server/services/turnActivityBus.js'
import { publishCommittedTurnEvents } from '../server/services/turnEventStore.js'
import {
  _turnWebSocketInternals,
  attachTurnWebSocketServer,
  createTurnWebSocketRateLimiter,
  isAllowedTurnWebSocketOrigin,
  parseTurnWebSocketClientFrame,
  pollTurnSubscriptions,
  subscribeTurnSubscription,
} from '../server/services/turnWebSocket.js'
import { issueTestSession } from './helpers/testAuth.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-websocket-'))
process.env.APP_DATA_DIR = tempDir

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('timed out waiting for asynchronous WebSocket subscription work')
}

function createFrameInbox(socket) {
  const frames = []
  const waiters = []
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(frame))
    if (waiterIndex >= 0) {
      const [{ resolve, timer }] = waiters.splice(waiterIndex, 1)
      clearTimeout(timer)
      resolve(frame)
      return
    }
    frames.push(frame)
  })
  return {
    next(predicate, timeoutMs = 5_000) {
      const frameIndex = frames.findIndex(predicate)
      if (frameIndex >= 0) return Promise.resolve(frames.splice(frameIndex, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Timed out waiting for WebSocket frame'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
  }
}

function waitForUpgradeRejection(socket) {
  return new Promise((resolve, reject) => {
    const onOpen = () => reject(new Error('WebSocket upgrade unexpectedly succeeded'))
    const onError = (error) => reject(error)
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('unexpected-response', (_request, response) => {
      socket.off('open', onOpen)
      socket.off('error', onError)
      const statusCode = response.statusCode
      response.resume()
      resolve(statusCode)
    })
  })
}

test('turn WebSocket production path sends the shared durable envelope and keeps activity live-only', async () => {
  const user = issueTestSession({ email: 'turn-envelope-wire@example.com' })
  const sessionId = 'turn-envelope-wire-session'
  const turnId = 'turn-envelope-wire-turn'
  const event = createTurnEvent({
    id: 'turn-envelope-wire-event',
    sessionId,
    turnId,
    sequence: 0,
    type: 'turn.completed',
    createdAt: 1,
  })
  const activity = createTurnActivity({
    sessionId,
    turnId,
    kind: 'tool_call_ready',
    toolName: 'read_file',
    createdAt: 2,
  })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, {
    listEvents: async ({ after }) => after < event.sequence ? [event] : [],
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )
  const inbox = createFrameInbox(socket)

  try {
    await once(socket, 'open')
    await inbox.next((frame) => frame.type === 'ready')
    socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
      sessionId,
      turnId,
      after: -1,
    })))

    const durableFrame = await inbox.next((frame) => frame.type === 'turn.event')
    assert.deepEqual(durableFrame, createTurnEventTransportEnvelope(event))
    await inbox.next((frame) => frame.type === 'subscribed.turn')

    publishTurnActivity({ userId: user.userId, activity })
    const activityFrame = await inbox.next((frame) => frame.type === 'turn.activity')
    assert.deepEqual(activityFrame, createTurnWebSocketFrame('turn.activity', { activity }))
    assert.equal(Object.hasOwn(activityFrame, 'event'), false)
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket preserves the host shutdown contract when initial subscription replay fails', async () => {
  const user = issueTestSession({ email: 'turn-host-shutdown-wire@example.com' })
  const sessionId = 'turn-host-shutdown-wire-session'
  const turnId = 'turn-host-shutdown-wire-turn'
  const failure = Object.assign(new Error('host is shutting down'), {
    code: 'TURN_ENGINE_SHUTTING_DOWN',
    statusCode: 503,
    retryable: true,
  })
  let replayAttempts = 0
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, {
    listEvents: async () => {
      replayAttempts += 1
      throw failure
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )
  const inbox = createFrameInbox(socket)

  try {
    await once(socket, 'open')
    await inbox.next((frame) => frame.type === 'ready')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
      sessionId,
      turnId,
      after: -1,
    })))

    const errorFrame = await inbox.next((frame) => frame.type === 'error')
    assert.deepEqual(errorFrame, createTurnWebSocketFrame('error', {
      code: 'TURN_ENGINE_SHUTTING_DOWN',
      message: 'turn runtime is restarting; retry shortly',
      action: 'retry',
      sessionId,
      turnId,
    }))
    const [closeCode, closeReason] = await closed
    assert.equal(closeCode, 1011)
    assert.equal(String(closeReason), 'Turn subscription failed')
    assert.equal(replayAttempts, 1, 'failed initial subscriptions must be removed before polling')
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket exposes persistence configuration failures as restart_runtime', async () => {
  const user = issueTestSession({ email: 'turn-host-persistence-wire@example.com' })
  const sessionId = 'turn-host-persistence-wire-session'
  const turnId = 'turn-host-persistence-wire-turn'
  const failure = Object.assign(new Error('private persistence adapter detail'), {
    code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
    statusCode: 503,
  })
  let replayAttempts = 0
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, {
    listEvents: async () => {
      replayAttempts += 1
      throw failure
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )
  const inbox = createFrameInbox(socket)

  try {
    await once(socket, 'open')
    await inbox.next((frame) => frame.type === 'ready')
    const closed = once(socket, 'close')
    socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
      sessionId,
      turnId,
      after: -1,
    })))

    const errorFrame = await inbox.next((frame) => frame.type === 'error')
    assert.deepEqual(errorFrame, createTurnWebSocketFrame('error', {
      code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      message: 'turn runtime is not ready because persistence is not configured',
      action: 'restart_runtime',
      sessionId,
      turnId,
    }))
    const [closeCode, closeReason] = await closed
    assert.equal(closeCode, 1011)
    assert.equal(String(closeReason), 'Turn subscription failed')
    assert.equal(replayAttempts, 1, 'failed initial subscriptions must be removed before polling')
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket normalizes async host failures and removes subscriptions before close', async (t) => {
  for (const source of ['poll', 'notification']) {
    await t.test(source, async () => {
      const user = issueTestSession({ email: `turn-host-${source}-wire@example.com` })
      const sessionId = `turn-host-${source}-wire-session`
      const turnId = `turn-host-${source}-wire-turn`
      const failure = Object.assign(new Error(`private ${source} shutdown detail`), {
        code: 'TURN_ENGINE_SHUTTING_DOWN',
        statusCode: 503,
        retryable: true,
      })
      let readAttempts = 0
      let cleanupProbePublished = false
      let cleanupProbeError = null
      const publishEvent = (sequence, suffix) => publishCommittedTurnEvents([{
        userId: user.userId,
        event: createTurnEvent({
          id: `turn-host-${source}-${suffix}-${sequence}`,
          sessionId,
          turnId,
          sequence,
          type: 'turn.started',
          createdAt: sequence + 1,
        }),
      }])
      const server = createServer((_req, res) => {
        res.writeHead(404)
        res.end()
      })
      attachTurnWebSocketServer(server, {
        listEvents: async () => {
          readAttempts += 1
          if (readAttempts === 1) return []
          throw failure
        },
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/api/realtime`,
        ['gugo.realtime', `bearer.${user.token}`],
      )
      const inbox = createFrameInbox(socket)
      socket.on('message', (raw) => {
        let frame
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (frame.type !== 'error'
          || frame.code !== 'TURN_ENGINE_SHUTTING_DOWN'
          || cleanupProbePublished) return
        cleanupProbePublished = true
        try {
          publishEvent(source === 'notification' ? 1 : 0, 'cleanup-probe')
        } catch (error) {
          cleanupProbeError = error
        }
      })

      try {
        await once(socket, 'open')
        await inbox.next((frame) => frame.type === 'ready')
        socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
          sessionId,
          turnId,
          after: -1,
        })))
        await inbox.next((frame) => frame.type === 'subscribed.turn')

        const closed = once(socket, 'close')
        const errorFramePromise = inbox.next((frame) => frame.type === 'error')
        if (source === 'notification') publishEvent(0, 'trigger')
        const errorFrame = await errorFramePromise

        assert.deepEqual(errorFrame, createTurnWebSocketFrame('error', {
          code: 'TURN_ENGINE_SHUTTING_DOWN',
          message: 'turn runtime is restarting; retry shortly',
          action: 'retry',
          sessionId,
          turnId,
        }))
        const [closeCode, closeReason] = await closed
        assert.equal(closeCode, 1011)
        assert.equal(String(closeReason), 'Turn subscription failed')
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(cleanupProbePublished, true)
        assert.equal(cleanupProbeError, null)
        assert.equal(readAttempts, 2, 'failed subscription listener must be removed before close')
      } finally {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          const closed = once(socket, 'close')
          socket.close()
          await closed
        }
        await new Promise((resolve) => server.close(resolve))
      }
    })
  }
})

test('turn WebSocket accepts same-machine origins and rejects cross-site or query credentials', async () => {
  const user = issueTestSession({ email: 'turn-origin-policy@example.com' })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `ws://127.0.0.1:${server.address().port}/api/realtime`

  try {
    const accepted = new WebSocket(
      endpoint,
      ['gugo.realtime', `bearer.${user.token}`],
      { origin: 'http://localhost:5173' },
    )
    await once(accepted, 'open')
    assert.equal(accepted.protocol, 'gugo.realtime')
    const acceptedClosed = once(accepted, 'close')
    accepted.close()
    await acceptedClosed

    const crossSite = new WebSocket(
      endpoint,
      ['gugo.realtime', `bearer.${user.token}`],
      { origin: 'https://attacker.example' },
    )
    assert.equal(await waitForUpgradeRejection(crossSite), 403)

    const queryCredential = new WebSocket(`${endpoint}?token=${encodeURIComponent(user.token)}`)
    assert.equal(await waitForUpgradeRejection(queryCredential), 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket origin policy is strict for remote hosts and tolerant across loopback spellings', () => {
  assert.equal(isAllowedTurnWebSocketOrigin({ headers: { host: 'app.example', origin: 'https://app.example' } }), true)
  assert.equal(isAllowedTurnWebSocketOrigin({ headers: { host: '127.0.0.1:3000', origin: 'http://localhost:5173' } }), true)
  assert.equal(isAllowedTurnWebSocketOrigin({ headers: { host: 'app.example', origin: 'null' } }), false)
  assert.equal(isAllowedTurnWebSocketOrigin({ headers: { host: 'app.example', origin: 'https://other.example' } }), false)
})

test('turn WebSocket transport rejects oversized and binary client frames', async () => {
  const user = issueTestSession({ email: 'turn-frame-boundaries@example.com' })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, { maxPayload: 256 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `ws://127.0.0.1:${server.address().port}/api/realtime`

  try {
    const oversized = new WebSocket(endpoint, ['gugo.realtime', `bearer.${user.token}`])
    await once(oversized, 'open')
    const oversizedClosed = once(oversized, 'close')
    oversized.send('x'.repeat(1024))
    const [oversizedCode] = await oversizedClosed
    assert.equal(oversizedCode, 1009)

    const binary = new WebSocket(endpoint, ['gugo.realtime', `bearer.${user.token}`])
    await once(binary, 'open')
    const binaryClosed = once(binary, 'close')
    binary.send(Buffer.from([1, 2, 3]))
    const [binaryCode] = await binaryClosed
    assert.equal(binaryCode, 1003)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket rate limiter closes message floods with a policy error', async () => {
  const user = issueTestSession({ email: 'turn-rate-limit@example.com' })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, {
    messageRateCapacity: 2,
    messageRateRefillPerSecond: 0,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )

  try {
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('{}')
    socket.send('{}')
    socket.send('{}')
    const [code] = await closed
    assert.equal(code, 1008)
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket serializes client frames and enforces the subscription cap', async () => {
  const user = issueTestSession({ email: 'turn-serialized-client-frames@example.com' })
  const firstGate = deferred()
  const firstStarted = deferred()
  const reads = []
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  attachTurnWebSocketServer(server, {
    maxSubscriptions: 1,
    listEvents: async ({ turnId }) => {
      reads.push(turnId)
      if (turnId === 'serialized-turn-a') {
        firstStarted.resolve()
        await firstGate.promise
      }
      return []
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )
  const inbox = createFrameInbox(socket)

  try {
    await once(socket, 'open')
    await inbox.next((frame) => frame.type === 'ready')
    socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
      sessionId: 'serialized-session-a',
      turnId: 'serialized-turn-a',
      after: -1,
    })))
    socket.send(JSON.stringify(createTurnWebSocketFrame('subscribe.turn', {
      sessionId: 'serialized-session-b',
      turnId: 'serialized-turn-b',
      after: -1,
    })))
    await firstStarted.promise
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(reads, ['serialized-turn-a'], 'the second frame must wait for the first handler')

    const closed = once(socket, 'close')
    firstGate.resolve()
    await inbox.next((frame) => frame.type === 'subscribed.turn' && frame.turnId === 'serialized-turn-a')
    const [code] = await closed
    assert.equal(code, 1008)
    assert.deepEqual(reads, ['serialized-turn-a'], 'a capped subscription must be rejected before replay')
  } finally {
    firstGate.resolve()
    if (socket.readyState === WebSocket.OPEN) socket.close()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('turn WebSocket backpressure helper fails closed and observes send callback errors', () => {
  const backpressuredCloses = []
  const backpressured = {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    bufferedAmount: _turnWebSocketInternals.MAX_SOCKET_BUFFERED_BYTES,
    close: (...args) => backpressuredCloses.push(args),
    send: () => assert.fail('backpressured socket must not send'),
  }
  assert.equal(_turnWebSocketInternals.send(backpressured, { type: 'ready' }), false)
  assert.deepEqual(backpressuredCloses, [[1013, 'Realtime client is too slow']])

  const failedCloses = []
  const failed = {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    bufferedAmount: 0,
    close: (...args) => failedCloses.push(args),
    send: (_payload, callback) => callback(new Error('write failed')),
  }
  assert.equal(_turnWebSocketInternals.send(failed, { type: 'ready' }), true)
  assert.deepEqual(failedCloses, [[1011, 'Realtime send failed']])
})

test('turn WebSocket replay notifications use an O(1) dirty marker', async () => {
  const key = 'dirty-session\u0000dirty-turn'
  const subscriptions = new Map()
  const replayGate = deferred()
  const replayStarted = deferred()
  const delivered = []
  let eventListener = null
  let reads = 0
  const pending = subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'dirty-user',
    sessionId: 'dirty-session',
    turnId: 'dirty-turn',
    after: -1,
    deliver: (subscription, event) => {
      delivered.push(event.id)
      subscription.cursor = event.sequence
    },
    subscribe: (_scope, listener) => {
      eventListener = listener
      return () => {}
    },
    subscribeActivities: () => () => {},
    listEvents: async () => {
      reads += 1
      if (reads === 1) {
        replayStarted.resolve()
        await replayGate.promise
        return [{ id: 'dirty-event-0', sequence: 0 }]
      }
      return reads === 2 ? [{ id: 'dirty-event-1', sequence: 1 }] : []
    },
  })

  await replayStarted.promise
  for (let index = 0; index < 10_000; index += 1) {
    eventListener({ id: `notification-${index}`, sequence: 1 })
  }
  assert.equal(subscriptions.get(key).pending, true)
  assert.equal(Array.isArray(subscriptions.get(key).pending), false)
  replayGate.resolve()
  const subscription = await pending
  assert.deepEqual(delivered, ['dirty-event-0', 'dirty-event-1'])
  subscription.unsubscribe()
})

test('turn WebSocket token bucket refills deterministically', () => {
  let now = 0
  const limiter = createTurnWebSocketRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now })
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), false)
  now = 1000
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), false)
})

test('turn WebSocket rejects and logs invalid client frames without leaking their payload', () => {
  const warnings = []
  const logSink = { warn: (message) => warnings.push(message) }
  const secret = 'do-not-log-this-secret'

  const invalidJson = parseTurnWebSocketClientFrame(`{"v":1,"secret":"${secret}"`, {
    userId: 'user-1',
    logSink,
  })
  const invalidFrame = parseTurnWebSocketClientFrame(JSON.stringify({
    v: 1,
    type: 'subscribe.turn',
    sessionId: '',
    turnId: 'turn-1',
    after: -1,
    secret,
  }), { userId: 'user-1', logSink })
  const incompatible = parseTurnWebSocketClientFrame(JSON.stringify({
    v: 2,
    type: 'subscribe.turn',
    sessionId: 'session-1',
    turnId: 'turn-1',
    after: -1,
  }), { userId: 'user-1', logSink })

  assert.deepEqual(invalidJson, { ok: false, code: 'INVALID_JSON' })
  assert.equal(invalidFrame.ok, false)
  assert.equal(invalidFrame.code, 'INVALID_FRAME')
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.code, 'VERSION_MISMATCH')
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /scope=realtime\.protocol/)
  assert.match(warnings[0], /code=INVALID_JSON/)
  assert.match(warnings[1], /code=INVALID_FRAME/)
  assert.match(warnings[2], /code=VERSION_MISMATCH/)
  assert.match(warnings[2], /expectedVersion=1/)
  assert.match(warnings[2], /receivedVersion=2/)
  assert.equal(warnings.some((message) => message.includes(secret)), false)
})

test('turn WebSocket accepts valid client frames without rejection logs', () => {
  const warnings = []
  const validation = parseTurnWebSocketClientFrame(JSON.stringify({
    v: 1,
    type: 'subscribe.turn',
    sessionId: 'session-1',
    turnId: 'turn-1',
    after: -1,
  }), { userId: 'user-1', logSink: { warn: (message) => warnings.push(message) } })

  assert.equal(validation.ok, true)
  assert.equal(warnings.length, 0)
})

test('turn WebSocket polling isolates a failed subscription and continues delivering others', async () => {
  const broken = { sessionId: 'session-broken', turnId: 'turn-broken', cursor: 3 }
  const healthy = { sessionId: 'session-healthy', turnId: 'turn-healthy', cursor: 7 }
  const subscriptions = new Map([
    ['broken', broken],
    ['healthy', healthy],
  ])
  const failure = new Error('database temporarily unavailable')
  const errors = []
  const deliveries = []

  await assert.doesNotReject(() => pollTurnSubscriptions({
    subscriptions,
    userId: 'user-1',
    listEvents: async ({ turnId }) => {
      await Promise.resolve()
      if (turnId === 'turn-broken') throw failure
      return [{ id: 'event-8', sequence: 8 }]
    },
    deliver: (subscription, event) => deliveries.push([subscription.turnId, event.id]),
    onError: (error, subscription) => errors.push([error, subscription.turnId]),
  }))

  assert.deepEqual(errors, [[failure, 'turn-broken']])
  assert.deepEqual(deliveries, [['turn-healthy', 'event-8']])
})

test('turn WebSocket subscription cleans up when the initial durable replay fails', async () => {
  let previousUnsubscribes = 0
  let eventUnsubscribes = 0
  let activityUnsubscribes = 0
  const key = 'session-1\u0000turn-1'
  const subscriptions = new Map([[
    key,
    { unsubscribe: () => { previousUnsubscribes += 1 } },
  ]])
  const failure = new Error('database temporarily unavailable')

  await assert.rejects(
    subscribeTurnSubscription({
      subscriptions,
      key,
      userId: 'user-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      after: -1,
      deliver: () => {},
      subscribe: () => () => { eventUnsubscribes += 1 },
      subscribeActivities: () => () => { activityUnsubscribes += 1 },
      listEvents: async () => { throw failure },
    }),
    failure,
  )

  assert.equal(previousUnsubscribes, 1)
  assert.equal(eventUnsubscribes, 1)
  assert.equal(activityUnsubscribes, 1)
  assert.equal(subscriptions.has(key), false)
})

test('turn WebSocket subscription leaves no stale entry when listener setup fails', async () => {
  const key = 'session-2\u0000turn-2'
  const subscriptions = new Map()
  const failure = new Error('listener unavailable')

  await assert.rejects(
    subscribeTurnSubscription({
      subscriptions,
      key,
      userId: 'user-1',
      sessionId: 'session-2',
      turnId: 'turn-2',
      after: -1,
      deliver: () => {},
      subscribe: () => { throw failure },
      listEvents: async () => [],
    }),
    failure,
  )

  assert.equal(subscriptions.has(key), false)
})

test('turn WebSocket subscription cleans up durable listener when activity setup fails', async () => {
  const key = 'session-activity-fail\u0000turn-activity-fail'
  const subscriptions = new Map()
  const failure = new Error('activity listener unavailable')
  let eventUnsubscribes = 0

  await assert.rejects(
    subscribeTurnSubscription({
      subscriptions,
      key,
      userId: 'user-1',
      sessionId: 'session-activity-fail',
      turnId: 'turn-activity-fail',
      after: -1,
      deliver: () => {},
      subscribe: () => () => { eventUnsubscribes += 1 },
      subscribeActivities: () => { throw failure },
      listEvents: async () => [],
    }),
    failure,
  )

  assert.equal(eventUnsubscribes, 1)
  assert.equal(subscriptions.has(key), false)
})

test('turn WebSocket activity delivery does not advance the durable cursor', async () => {
  const key = 'session-activity\u0000turn-activity'
  const subscriptions = new Map()
  let activityListener = null
  const activities = []
  const subscription = await subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-activity',
    turnId: 'turn-activity',
    after: 7,
    deliver: () => {},
    deliverActivity: (current, activity) => activities.push([current.cursor, activity.toolName]),
    subscribe: () => () => {},
    subscribeActivities: (_scope, listener) => {
      activityListener = listener
      return () => {}
    },
    listEvents: async () => [],
  })

  activityListener({ toolName: 'bash_exec' })
  assert.equal(subscription.cursor, 7)
  assert.deepEqual(activities, [[7, 'bash_exec']])
  subscription.unsubscribe()
})

test('turn WebSocket subscription awaits Promise-returning durable replay before resolving', async () => {
  const key = 'session-async-replay\u0000turn-async-replay'
  const subscriptions = new Map()
  const replayGate = deferred()
  const delivered = []
  let replayStarted = false

  const pendingSubscription = subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-async-replay',
    turnId: 'turn-async-replay',
    after: -1,
    deliver: (subscription, event) => {
      delivered.push(event.id)
      subscription.cursor = event.sequence
    },
    subscribe: () => () => {},
    subscribeActivities: () => () => {},
    listEvents: async ({ after }) => {
      replayStarted = true
      await replayGate.promise
      return after < 0 ? [{ id: 'async-event-0', sequence: 0 }] : []
    },
  })

  await waitFor(() => replayStarted)
  assert.deepEqual(delivered, [])
  replayGate.resolve()
  const subscription = await pendingSubscription

  assert.deepEqual(delivered, ['async-event-0'])
  assert.equal(subscription.cursor, 0)
  subscription.unsubscribe()
})

test('turn WebSocket serializes overlapping durable drains for one subscription', async () => {
  const key = 'session-serialized\u0000turn-serialized'
  const subscriptions = new Map()
  const firstDrainGate = deferred()
  const firstDrainStarted = deferred()
  const durableEvents = [
    { id: 'serialized-event-0', sequence: 0 },
    { id: 'serialized-event-1', sequence: 1 },
  ]
  const delivered = []
  let eventListener = null
  let reads = 0
  let activeReads = 0
  let maxActiveReads = 0

  const subscription = await subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-serialized',
    turnId: 'turn-serialized',
    after: -1,
    deliver: (current, event) => {
      if (event.sequence <= current.cursor) return
      delivered.push(event.id)
      current.cursor = event.sequence
    },
    subscribe: (_scope, listener) => {
      eventListener = listener
      return () => {}
    },
    subscribeActivities: () => () => {},
    listEvents: async ({ after }) => {
      reads += 1
      if (reads === 1) return []
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      try {
        if (reads === 2) {
          firstDrainStarted.resolve()
          await firstDrainGate.promise
        }
        return durableEvents.filter((event) => event.sequence > after)
      } finally {
        activeReads -= 1
      }
    },
  })

  const firstNotification = eventListener(durableEvents[0])
  await firstDrainStarted.promise
  const secondNotification = eventListener(durableEvents[1])
  await Promise.resolve()

  assert.equal(maxActiveReads, 1)
  assert.equal(reads, 2, 'a second notification must queue behind the active drain')

  firstDrainGate.resolve()
  await Promise.all([firstNotification, secondNotification].map((value) => Promise.resolve(value)))
  await waitFor(() => delivered.length === 2)

  assert.equal(maxActiveReads, 1)
  assert.deepEqual(delivered, ['serialized-event-0', 'serialized-event-1'])
  subscription.unsubscribe()
})

test('turn WebSocket unsubscribe suppresses events from an already pending durable read', async () => {
  const key = 'session-unsubscribe\u0000turn-unsubscribe'
  const subscriptions = new Map()
  const delayedReadGate = deferred()
  const delayedReadStarted = deferred()
  const delivered = []
  let eventListener = null
  let reads = 0
  let eventUnsubscribes = 0

  const subscription = await subscribeTurnSubscription({
    subscriptions,
    key,
    userId: 'user-1',
    sessionId: 'session-unsubscribe',
    turnId: 'turn-unsubscribe',
    after: -1,
    deliver: (_current, event) => delivered.push(event.id),
    subscribe: (_scope, listener) => {
      eventListener = listener
      return () => { eventUnsubscribes += 1 }
    },
    subscribeActivities: () => () => {},
    listEvents: async () => {
      reads += 1
      if (reads === 1) return []
      delayedReadStarted.resolve()
      await delayedReadGate.promise
      return [{ id: 'late-event-0', sequence: 0 }]
    },
  })

  const pendingNotification = eventListener({ id: 'late-event-0', sequence: 0 })
  await delayedReadStarted.promise
  subscription.unsubscribe()
  assert.equal(eventUnsubscribes, 1)

  delayedReadGate.resolve()
  await Promise.resolve(pendingNotification)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(delivered, [])
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
