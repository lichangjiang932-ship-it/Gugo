import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnActivity, createTurnEvent } from '../shared/turnEvents.js'
import { setAuthToken } from '../src/lib/accountClient.js'
import {
  dispatchTurnActivity,
  dispatchTurnEvent,
  fetchServerSessionSnapshot,
  normalizeServerSessionSnapshot,
  reconnectDelayForAttempt,
  replayServerTurn,
  runServerTurn,
  startServerTurn,
  steerServerTurn,
  streamServerTurnEventsWebSocket,
  streamServerTurnEvents,
} from '../src/lib/turnClient.js'
import { createTurnFailureError, normalizeTurnFailurePayload } from '../src/lib/turnClient/turnEventDispatch.js'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function sseResponse(events) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: turn_event\ndata: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return { ok: true, status: 200, body, json: async () => ({}) }
}

class FakeWebSocket {
  static OPEN = 1

  OPEN = FakeWebSocket.OPEN

  readyState = 0

  listeners = new Map()

  sent = []

  closed = false

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, value = {}) {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN
    for (const listener of this.listeners.get(type) || []) listener(value)
  }

  send(value) {
    this.sent.push(value)
  }

  close() {
    this.closed = true
    this.readyState = 3
  }
}

async function withWebSocketAuth(run) {
  const previousWindow = globalThis.window
  if (previousWindow === undefined) globalThis.window = {}
  setAuthToken('test-token')
  try {
    return await run()
  } finally {
    setAuthToken('')
    if (previousWindow === undefined) delete globalThis.window
  }
}

test('WebSocket turn stream times out while connecting and closes the socket', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    await assert.rejects(
      streamServerTurnEventsWebSocket({
        sessionId: 's-connect-timeout',
        turnId: 't-connect-timeout',
        connectTimeoutMs: 5,
        webSocketFactory: () => socket,
      }),
      (error) => error.code === 'TURN_WEBSOCKET_CONNECT_TIMEOUT' && error.name !== 'AbortError',
    )
    assert.equal(socket.closed, true)
  })
})

test('WebSocket turn stream times out without a subscription acknowledgement', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-subscribe-timeout',
      turnId: 't-subscribe-timeout',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 5,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    await assert.rejects(
      stream,
      (error) => error.code === 'TURN_WEBSOCKET_SUBSCRIBE_TIMEOUT' && error.name !== 'AbortError',
    )
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'subscribe.turn',
      sessionId: 's-subscribe-timeout',
      turnId: 't-subscribe-timeout',
      after: -1,
    })
    assert.equal(socket.closed, true)
  })
})

test('WebSocket acknowledgement clears the subscription timeout and allows terminal delivery', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-ack',
      turnId: 't-ack',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 5,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ type: 'subscribed.turn', sessionId: 's-ack', turnId: 't-ack' }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    socket.emit('message', { data: JSON.stringify({
      type: 'turn.event',
      event: createTurnEvent({ id: 'ws-done', sessionId: 's-ack', turnId: 't-ack', sequence: 0, type: 'turn.completed', createdAt: 1 }),
    }) })
    const terminal = await stream
    assert.equal(terminal.id, 'ws-done')
  })
})

test('first WebSocket turn event also clears the subscription timeout', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-event',
      turnId: 't-event',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 5,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({
      type: 'turn.event',
      event: createTurnEvent({ id: 'ws-start', sessionId: 's-event', turnId: 't-event', sequence: 0, type: 'turn.started', createdAt: 1 }),
    }) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    socket.emit('message', { data: JSON.stringify({
      type: 'turn.event',
      event: createTurnEvent({ id: 'ws-event-done', sessionId: 's-event', turnId: 't-event', sequence: 1, type: 'turn.completed', createdAt: 2 }),
    }) })
    const terminal = await stream
    assert.equal(terminal.id, 'ws-event-done')
  })
})

test('WebSocket terminal delivery completes before an immediate close is treated as truncated', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    let releaseDelivery
    let markDeliveryStarted
    const deliveryStarted = new Promise((resolve) => { markDeliveryStarted = resolve })
    const deliveryBlocked = new Promise((resolve) => { releaseDelivery = resolve })
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-close-race',
      turnId: 't-close-race',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 100,
      webSocketFactory: () => socket,
      onEvent: async () => {
        markDeliveryStarted()
        await deliveryBlocked
      },
    })
    let settled = false
    stream.then(() => { settled = true }, () => { settled = true })
    const completed = createTurnEvent({
      id: 'ws-close-race-done',
      sessionId: 's-close-race',
      turnId: 't-close-race',
      sequence: 0,
      type: 'turn.completed',
      createdAt: 1,
    })

    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ type: 'turn.event', event: completed }) })
    socket.emit('close')
    await deliveryStarted
    await Promise.resolve()
    assert.equal(settled, false)
    releaseDelivery()

    const terminal = await stream
    assert.equal(terminal.id, completed.id)
  })
})

test('WebSocket protocol errors fail immediately without waiting for acknowledgement timeout', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-protocol-error',
      turnId: 't-protocol-error',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 60_000,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ type: 'error', code: 'TURN_SUBSCRIBE_FAILED' }) })
    await assert.rejects(stream, (error) => error.code === 'TURN_SUBSCRIBE_FAILED')
    assert.equal(socket.closed, true)
  })
})

test('startServerTurn sends a canonical explicit tools configuration', async () => {
  let requestBody = null
  await startServerTurn({
    sessionId: 's-tools',
    content: 'use configured tools',
    agentId: ' agent-primary ',
    skillIds: [' skill-review ', 'skill-review', '', 42],
    intentMode: 'execute',
    toolsConfig: {
      enabled: ['write_file', ' read_file ', 'write_file', '', 42],
      disabled: ['bash_exec', 'write_file', 'bash_exec', null],
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/turns/run')
      requestBody = JSON.parse(options.body)
      return response({ turn: { sessionId: 's-tools', turnId: 't-tools', status: 'running' } }, 202)
    },
  })

  assert.deepEqual(requestBody.toolsConfig, {
    enabled: ['read_file'],
    disabled: ['bash_exec', 'write_file'],
  })
  assert.equal(requestBody.agentId, 'agent-primary')
  assert.deepEqual(requestBody.skillIds, ['skill-review'])
  assert.equal(requestBody.intentMode, 'execute')
})

test('WebSocket delivers transient activity before the durable event without treating it as terminal', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const seen = []
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-activity',
      turnId: 't-activity',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 100,
      webSocketFactory: () => socket,
      onActivity: (activity) => seen.push(`activity:${activity.toolName}`),
      onEvent: (event) => seen.push(`event:${event.sequence}`),
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({
      type: 'turn.activity',
      activity: createTurnActivity({
        sessionId: 's-activity', turnId: 't-activity', kind: 'tool_call_ready',
        toolName: 'bash_exec', modelName: 'stub', createdAt: 1,
      }),
    }) })
    socket.emit('message', { data: JSON.stringify({
      type: 'turn.event',
      event: createTurnEvent({
        id: 'ws-activity-done', sessionId: 's-activity', turnId: 't-activity',
        sequence: 0, type: 'turn.completed', createdAt: 2,
      }),
    }) })

    const terminal = await stream
    assert.equal(terminal.sequence, 0)
    assert.deepEqual(seen, ['activity:bash_exec', 'event:0'])
  })
})

test('SSE delivers id-less activity without consuming the durable sequence', async () => {
  const encoder = new TextEncoder()
  const activity = createTurnActivity({
    sessionId: 's-sse-activity', turnId: 't-sse-activity', kind: 'tool_call_ready',
    toolName: 'write_file', createdAt: 1,
  })
  const completed = createTurnEvent({
    id: 'sse-activity-done', sessionId: 's-sse-activity', turnId: 't-sse-activity',
    sequence: 0, type: 'turn.completed', createdAt: 2,
  })
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: turn_activity\ndata: ${JSON.stringify(activity)}\n\n`))
      controller.enqueue(encoder.encode(`id: 0\nevent: turn_event\ndata: ${JSON.stringify(completed)}\n\n`))
      controller.close()
    },
  })
  const seen = []
  const terminal = await streamServerTurnEvents({
    sessionId: 's-sse-activity',
    turnId: 't-sse-activity',
    after: -1,
    fetchImpl: async () => ({ ok: true, status: 200, body, json: async () => ({}) }),
    onActivity: (value) => seen.push(`activity:${value.toolName}`),
    onEvent: (event) => seen.push(`event:${event.sequence}`),
  })
  assert.equal(terminal.sequence, 0)
  assert.deepEqual(seen, ['activity:write_file', 'event:0'])
})

test('steerServerTurn posts an idempotent steering request to the active turn', async () => {
  const signal = new AbortController().signal
  let captured = null
  const steering = await steerServerTurn({
    sessionId: 'session-1',
    turnId: 'turn/with spaces',
    content: 'Use the existing page and add a dark theme.',
    clientRequestId: 'steer-request-1',
    signal,
    fetchImpl: async (url, options) => {
      captured = { url, options }
      return response({
        steering: {
          messageId: 'steering-message-1',
          clientRequestId: 'steer-request-1',
          content: 'Use the existing page and add a dark theme.',
          createdAt: 42,
        },
      })
    },
  })

  assert.equal(captured.url, '/api/turns/turn%2Fwith%20spaces/steer')
  assert.equal(captured.options.method, 'POST')
  assert.equal(captured.options.signal, signal)
  assert.deepEqual(JSON.parse(captured.options.body), {
    sessionId: 'session-1',
    content: 'Use the existing page and add a dark theme.',
    clientRequestId: 'steer-request-1',
  })
  assert.deepEqual(steering, {
    messageId: 'steering-message-1',
    clientRequestId: 'steer-request-1',
    content: 'Use the existing page and add a dark theme.',
    createdAt: 42,
  })
})

test('runServerTurn starts once, consumes SSE events, and stops at terminal', async () => {
  const urls = []
  const seen = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 't1', status: 'running' } }, 202)
    return sseResponse([
      createTurnEvent({ id: 'e0', sessionId: 's1', turnId: 't1', sequence: 0, type: 'turn.started', createdAt: 1 }),
      createTurnEvent({ id: 'e1', sessionId: 's1', turnId: 't1', sequence: 1, type: 'assistant.delta', payload: { text: 'hi' }, createdAt: 2 }),
      createTurnEvent({ id: 'e2', sessionId: 's1', turnId: 't1', sequence: 2, type: 'turn.completed', payload: { text: 'hi' }, createdAt: 3 }),
    ])
  }
  const result = await runServerTurn({
    sessionId: 's1', content: 'hello', history: [{ role: 'user', content: 'old' }],
    fetchImpl, onEvent: (event) => seen.push(event.type),
  })
  assert.equal(result.terminal.type, 'turn.completed')
  assert.deepEqual(seen, ['turn.started', 'assistant.delta', 'turn.completed'])
  assert.match(urls[1], /^\/api\/turns\/stream\?.*after=-1/)
  assert.equal(urls.some((url) => String(url).startsWith('/api/turns/events?')), false)
})

test('runServerTurn keeps using SSE after an unacknowledged WebSocket fails', async () => {
  await withWebSocketAuth(async () => {
    const sockets = []
    let sseCalls = 0
    const seen = []
    const fetchImpl = async (url) => {
      if (url === '/api/turns/run') {
        return response({ turn: { sessionId: 's-ws-fallback', turnId: 't-ws-fallback', status: 'running' } }, 202)
      }
      if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
      if (String(url).startsWith('/api/turns/stream?')) {
        sseCalls += 1
        if (sseCalls === 1) return sseResponse([])
        return sseResponse([createTurnEvent({
          id: 'sse-fallback-done',
          sessionId: 's-ws-fallback',
          turnId: 't-ws-fallback',
          sequence: 0,
          type: 'turn.completed',
          createdAt: 1,
        })])
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const result = await runServerTurn({
      sessionId: 's-ws-fallback',
      content: 'hello',
      fetchImpl,
      reconnectDelayMs: 0,
      webSocketConnectTimeoutMs: 100,
      webSocketSubscribeTimeoutMs: 5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.emit('open'))
        return socket
      },
      onEvent: (event) => seen.push(event.type),
    })

    assert.equal(result.terminal.id, 'sse-fallback-done')
    assert.equal(sockets.length, 1)
    assert.equal(sseCalls, 2)
    assert.deepEqual(seen, ['turn.completed'])
  })
})

test('runServerTurn resumes from the persisted sequence', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === '/api/turns/t1/resume') return response({ turn: { sessionId: 's1', turnId: 't1', status: 'running' } }, 202)
    return sseResponse([createTurnEvent({ id: 'e8', sessionId: 's1', turnId: 't1', sequence: 8, type: 'turn.completed', createdAt: 3 })])
  }
  const result = await runServerTurn({
    sessionId: 's1', turnId: 't1', resume: true, afterSequence: 7, fetchImpl,
  })
  assert.equal(result.lastSequence, 8)
  assert.equal(urls[0], '/api/turns/t1/resume')
  assert.match(urls[1], /^\/api\/turns\/stream\?.*after=7/)
})

test('runServerTurn exits without polling when resume response is already terminal', async () => {
  const urls = []
  const lastEvent = createTurnEvent({ id: 'e5', sessionId: 's1', turnId: 't1', sequence: 5, type: 'turn.completed', createdAt: 3 })
  const fetchImpl = async (url) => {
    urls.push(url)
    return response({ turn: { sessionId: 's1', turnId: 't1', status: 'completed', lastEvent } })
  }
  const result = await runServerTurn({ sessionId: 's1', turnId: 't1', resume: true, afterSequence: 5, fetchImpl })
  assert.equal(result.terminal.type, 'turn.completed')
  assert.deepEqual(urls, ['/api/turns/t1/resume'])
})

test('runServerTurn waits for a terminal cancellation event after the stop is acknowledged', async () => {
  const urls = []
  const controller = new AbortController()
  const cancelled = createTurnEvent({
    id: 'cancelled', sessionId: 's1', turnId: 't-stop', sequence: 0,
    type: 'turn.cancelled', payload: { reason: 'user stopped' }, createdAt: 1,
  })
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 't-stop', status: 'running' } }, 202)
    if (url === '/api/turns/t-stop/cancel') return response({ turn: { turnId: 't-stop', status: 'cancelling' } })
    if (String(url).startsWith('/api/turns/stream?')) return sseResponse([cancelled])
    return response({ turn: { turnId: 't-stop', status: 'cancelling' } })
  }
  const result = await runServerTurn({
    sessionId: 's1', turnId: 't-stop', content: 'stop', signal: controller.signal, fetchImpl,
    onStarted: () => controller.abort(),
  })
  assert.equal(result.terminal.type, 'turn.cancelled')
  assert.equal(urls.includes('/api/turns/t-stop/cancel'), true)
})

test('reconnect delay is exponential and capped', () => {
  assert.equal(reconnectDelayForAttempt(1, 500, 4_000), 500)
  assert.equal(reconnectDelayForAttempt(2, 500, 4_000), 1_000)
  assert.equal(reconnectDelayForAttempt(5, 500, 4_000), 4_000)
})

test('replay request forwards the abort signal', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  await replayServerTurn({
    sessionId: 's1',
    turnId: 't1',
    signal: controller.signal,
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal
      return response({ events: [] })
    },
  })
  assert.equal(receivedSignal, controller.signal)
})

test('runServerTurn reports reconnect state and reports connected after the stream recovers', async () => {
  let streamCalls = 0
  const states = []
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'recover', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    streamCalls += 1
    if (streamCalls === 1) return sseResponse([])
    return sseResponse([createTurnEvent({ id: 'done', sessionId: 's1', turnId: 'recover', sequence: 0, type: 'turn.completed', createdAt: 1 })])
  }
  const result = await runServerTurn({
    sessionId: 's1', content: 'hello', fetchImpl, reconnectDelayMs: 0,
    onConnectionState: (state) => states.push(state.status),
  })
  assert.equal(result.terminal.type, 'turn.completed')
  assert.deepEqual(states, ['reconnecting', 'connected'])
})

test('runServerTurn wakes an unfinished turn after replay when the server process restarts', async () => {
  let streamCalls = 0
  let resumeCalls = 0
  const seen = []
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') {
      return response({ turn: { sessionId: 's1', turnId: 'server-restart', status: 'running' } }, 202)
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (url === '/api/turns/server-restart/resume') {
      resumeCalls += 1
      return response({ turn: { sessionId: 's1', turnId: 'server-restart', status: 'running' } }, 202)
    }
    streamCalls += 1
    if (streamCalls === 1) return sseResponse([])
    return sseResponse([
      createTurnEvent({
        id: 'restart-attempt', sessionId: 's1', turnId: 'server-restart', sequence: 0,
        type: 'turn.attempt',
        payload: {
          attempt: 2,
          reason: 'turn_resume',
          resetStreaming: true,
          checkpointSequence: null,
          previousStreamSequence: 0,
          assistantText: '',
          reasoningText: '',
        },
        createdAt: 1,
      }),
      createTurnEvent({
        id: 'restart-delta', sessionId: 's1', turnId: 'server-restart', sequence: 1,
        type: 'assistant.delta', payload: { text: 'recovered' }, createdAt: 2,
      }),
      createTurnEvent({
        id: 'restart-done', sessionId: 's1', turnId: 'server-restart', sequence: 2,
        type: 'turn.completed', payload: { text: 'recovered' }, createdAt: 3,
      }),
    ])
  }

  const result = await runServerTurn({
    sessionId: 's1',
    content: 'hello',
    fetchImpl,
    reconnectDelayMs: 0,
    onEvent: (event) => seen.push(event.type),
  })

  assert.equal(result.terminal.type, 'turn.completed')
  assert.equal(resumeCalls, 1)
  assert.deepEqual(seen, ['turn.attempt', 'assistant.delta', 'turn.completed'])
})

test('runServerTurn treats turn.interrupted as resumable and waits for a real terminal event', async () => {
  let streamCalls = 0
  let resumeCalls = 0
  const seen = []
  const interrupted = createTurnEvent({
    id: 'interrupted', sessionId: 's1', turnId: 'interrupted-turn', sequence: 0,
    type: 'turn.interrupted',
    payload: { code: 'PROCESS_RESTARTED', message: 'worker restarted', retryable: true },
    createdAt: 1,
  })
  const completed = createTurnEvent({
    id: 'interrupted-done', sessionId: 's1', turnId: 'interrupted-turn', sequence: 1,
    type: 'turn.completed', payload: { text: 'resumed answer' }, createdAt: 2,
  })
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'interrupted-turn', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/interrupted-turn?')) {
      return response({ turn: { turnId: 'interrupted-turn', status: 'interrupted', lastEvent: interrupted } })
    }
    if (url === '/api/turns/interrupted-turn/resume') {
      resumeCalls += 1
      return response({ turn: { turnId: 'interrupted-turn', status: 'running', lastEvent: interrupted } }, 202)
    }
    streamCalls += 1
    return sseResponse(streamCalls === 1 ? [interrupted] : [completed])
  }

  const result = await runServerTurn({
    sessionId: 's1', content: 'continue', fetchImpl, reconnectDelayMs: 0,
    onEvent: (event) => seen.push(event.type),
  })

  assert.equal(result.terminal.type, 'turn.completed')
  assert.equal(resumeCalls, 1)
  assert.deepEqual(seen, ['turn.interrupted', 'turn.completed'])
})

test('runServerTurn may wake the turn again after a recovered stream later disconnects', async () => {
  let streamCalls = 0
  let resumeCalls = 0
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') {
      return response({ turn: { sessionId: 's1', turnId: 'two-disconnects', status: 'running' } }, 202)
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/two-disconnects?')) {
      return response({ turn: { sessionId: 's1', turnId: 'two-disconnects', status: 'running' } })
    }
    if (url === '/api/turns/two-disconnects/resume') {
      resumeCalls += 1
      return response({ turn: { sessionId: 's1', turnId: 'two-disconnects', status: 'running' } }, 202)
    }
    streamCalls += 1
    if (streamCalls === 1) {
      return sseResponse([createTurnEvent({
        id: 'first-delta', sessionId: 's1', turnId: 'two-disconnects', sequence: 0,
        type: 'assistant.delta', payload: { text: 'one' }, createdAt: 1,
      })])
    }
    if (streamCalls === 2) {
      return sseResponse([createTurnEvent({
        id: 'second-delta', sessionId: 's1', turnId: 'two-disconnects', sequence: 1,
        type: 'assistant.delta', payload: { text: 'two' }, createdAt: 2,
      })])
    }
    return sseResponse([createTurnEvent({
      id: 'two-disconnects-done', sessionId: 's1', turnId: 'two-disconnects', sequence: 2,
      type: 'turn.completed', payload: { text: 'onetwo' }, createdAt: 3,
    })])
  }

  const result = await runServerTurn({
    sessionId: 's1', content: 'hello', fetchImpl, reconnectDelayMs: 0,
  })

  assert.equal(result.terminal.type, 'turn.completed')
  assert.equal(resumeCalls, 2)
  assert.equal(streamCalls, 3)
})

test('runServerTurn advances its cursor only after onEvent succeeds', async () => {
  const replayUrls = []
  let firstDelivery = true
  const attempts = []
  const started = createTurnEvent({ id: 'cursor-start', sessionId: 's1', turnId: 'cursor', sequence: 0, type: 'turn.started', createdAt: 1 })
  const completed = createTurnEvent({ id: 'cursor-done', sessionId: 's1', turnId: 'cursor', sequence: 1, type: 'turn.completed', payload: { text: 'done' }, createdAt: 2 })
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'cursor', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) {
      replayUrls.push(String(url))
      return response({ events: [started, completed] })
    }
    return sseResponse([started])
  }

  const result = await runServerTurn({
    sessionId: 's1',
    content: 'hello',
    fetchImpl,
    onEvent: async (event) => {
      attempts.push(event.id)
      if (firstDelivery) {
        firstDelivery = false
        throw new Error('render failed before acknowledgement')
      }
    },
  })

  assert.equal(result.terminal.id, 'cursor-done')
  assert.equal(result.lastSequence, 1)
  assert.deepEqual(attempts, ['cursor-start', 'cursor-start', 'cursor-done'])
  assert.match(replayUrls[0], /after=-1(?:&|$)/)
})

test('runServerTurn ignores replay overlap and never applies a delta twice', async () => {
  let deltaDeliveries = 0
  const delta = createTurnEvent({ id: 'overlap-delta', sessionId: 's1', turnId: 'overlap', sequence: 0, type: 'assistant.delta', payload: { text: 'hello' }, createdAt: 1 })
  const completed = createTurnEvent({ id: 'overlap-done', sessionId: 's1', turnId: 'overlap', sequence: 1, type: 'turn.completed', payload: { text: 'hello' }, createdAt: 2 })
  const replayUrls = []
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'overlap', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) {
      replayUrls.push(String(url))
      // Deliberately include the boundary event to simulate an overlapping
      // replay response. The acknowledged cursor still makes delivery idempotent.
      return response({ events: [delta, completed] })
    }
    return sseResponse([delta])
  }

  const result = await runServerTurn({
    sessionId: 's1',
    content: 'hello',
    fetchImpl,
    reconnectDelayMs: 0,
    onEvent: (event) => {
      if (event.type === 'assistant.delta') deltaDeliveries += 1
    },
  })

  assert.equal(result.terminal.id, 'overlap-done')
  assert.equal(deltaDeliveries, 1)
  assert.match(replayUrls[0], /after=0(?:&|$)/)
})

test('runServerTurn enters low-frequency recovery after reconnect exhaustion and still observes completion', async () => {
  const states = []
  let streamCalls = 0
  let replayCalls = 0
  const completed = createTurnEvent({
    id: 'eventually-done', sessionId: 's1', turnId: 'exhaust', sequence: 0,
    type: 'turn.completed', payload: { text: 'finished on the server' }, createdAt: 1,
  })
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'exhaust', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) {
      replayCalls += 1
      return response({ events: replayCalls >= 3 ? [completed] : [] })
    }
    if (String(url).startsWith('/api/turns/exhaust?')) return response({ turn: { turnId: 'exhaust', status: 'running' } })
    if (url === '/api/turns/exhaust/resume') return response({ turn: { sessionId: 's1', turnId: 'exhaust', status: 'running' } }, 202)
    streamCalls += 1
    return sseResponse([])
  }
  const result = await runServerTurn({
    sessionId: 's1', content: 'hello', fetchImpl, reconnectDelayMs: 0,
    reconnectMaxAttempts: 2, recoveryPollIntervalMs: 0,
    onConnectionState: (state) => states.push(state),
  })
  assert.equal(result.terminal.type, 'turn.completed')
  assert.equal(streamCalls, 2)
  assert.equal(states.some((state) => state.status === 'failed'), false)
  assert.equal(states.some((state) => state.recoveryMode === true), true)
})

test('cancel retries after a network failure and does not finish before turn.cancelled', async () => {
  const controller = new AbortController()
  let cancelCalls = 0
  let streamCalls = 0
  const states = []
  const cancelled = createTurnEvent({
    id: 'cancel-retry-done', sessionId: 's1', turnId: 'cancel-retry', sequence: 0,
    type: 'turn.cancelled', payload: { reason: 'user stopped' }, createdAt: 1,
  })
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'cancel-retry', status: 'running' } }, 202)
    if (url === '/api/turns/cancel-retry/cancel') {
      cancelCalls += 1
      if (cancelCalls === 1) throw new TypeError('network unavailable')
      return response({ turn: { turnId: 'cancel-retry', status: 'cancelling' } })
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/cancel-retry?')) return response({ turn: { turnId: 'cancel-retry', status: 'running' } })
    streamCalls += 1
    return sseResponse([cancelled])
  }
  const result = await runServerTurn({
    sessionId: 's1', content: 'hello', signal: controller.signal, fetchImpl,
    cancelRetryDelayMs: 0,
    onStarted: () => controller.abort(),
    onConnectionState: (state) => states.push(state),
  })
  assert.equal(result.terminal.type, 'turn.cancelled')
  assert.equal(cancelCalls, 2)
  assert.equal(streamCalls, 1, 'terminal cancellation is observed after the ACK')
  assert.equal(states.some((state) => state.status === 'cancelling' && state.confirmed === false), true)
  assert.equal(states.some((state) => state.status === 'cancelling' && state.confirmed === true), true)
})

test('dispatchTurnEvent maps tool and approval events to existing chat actions', async () => {
  const actions = []
  const approvals = []
  const artifacts = []
  const dispatch = (action) => actions.push(action)
  await dispatchTurnEvent(createTurnEvent({
    id: 'call', sessionId: 's', turnId: 't', sequence: 0, type: 'tool.call',
    payload: { toolCallId: 'c1', name: 'create_docx', args: { title: 'Doc' } }, createdAt: 1,
  }), { dispatch, taskId: 'task', messageTarget: { sessionId: 's', messageId: 'assistant-1' } })
  await dispatchTurnEvent(createTurnEvent({
    id: 'done', sessionId: 's', turnId: 't', sequence: 1, type: 'tool.completed',
    payload: { toolCallId: 'c1', name: 'create_docx', args: { title: 'Edited Doc' }, artifactId: 'a1', result: { ok: true, artifactId: 'a1', filename: 'a.docx', url: '/api/artifacts/a.docx', approvalAuthorization: { source: 'standing_rule', grantId: 'g1' } } }, createdAt: 2,
  }), { dispatch, taskId: 'task', onArtifact: (artifact) => artifacts.push(artifact) })
  await dispatchTurnEvent(createTurnEvent({
    id: 'approval', sessionId: 's', turnId: 't', sequence: 2, type: 'approval.required',
    payload: { approvalId: 'p1', toolName: 'write_file', args: { path: 'a' }, risk: 'medium' }, createdAt: 3,
  }), { dispatch, taskId: 'task', onApproval: (approval) => approvals.push(approval) })
  assert.equal(actions.some((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE'), true)
  assert.equal(actions.find((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE').messageId, 'assistant-1')
  assert.deepEqual(
    actions.filter((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE').at(-1).payload.approvalAuthorization,
    { source: 'standing_rule', grantId: 'g1' },
  )
  assert.equal(
    actions.filter((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE').at(-1).payload.arguments,
    '{"title":"Edited Doc"}',
  )
  assert.equal(artifacts[0].filename, 'a.docx')
  assert.equal(approvals[0].id, 'p1')
})

test('dispatchTurnEvent forwards every local artifact from one completed shell call', async () => {
  const artifacts = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'shell-multi-output-completed',
    sessionId: 's',
    turnId: 't',
    sequence: 1,
    type: 'tool.completed',
    payload: {
      toolCallId: 'shell-multi-output',
      name: 'bash_exec',
      result: { ok: true },
      artifacts: [
        { id: 'pdf-1', filename: '填写后 答题卡.pdf', type: 'pdf', url: '/api/artifacts/pdf-1' },
        { id: 'png-1', filename: '第 1 页.png', type: 'png', url: '/api/artifacts/png-1' },
      ],
    },
    createdAt: 1,
  }), {
    dispatch: () => {},
    taskId: 'task',
    onArtifact: (artifact) => artifacts.push(artifact),
  })

  assert.deepEqual(artifacts.map(({ id, filename, name }) => ({ id, filename, name })), [
    { id: 'pdf-1', filename: '填写后 答题卡.pdf', name: 'bash_exec' },
    { id: 'png-1', filename: '第 1 页.png', name: 'bash_exec' },
  ])
})

test('dispatchTurnActivity shows early tool readiness without creating a tool card or cursor', () => {
  const actions = []
  dispatchTurnActivity(createTurnActivity({
    sessionId: 's', turnId: 't', kind: 'tool_call_ready',
    modelName: 'test-model', toolName: 'write_file',
    createdAt: 1,
  }), {
    dispatch: (action) => actions.push(action),
    taskId: 'task',
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })

  assert.deepEqual(actions, [
    {
      type: 'UPDATE_TASK',
      payload: { id: 'task', updates: { stepLabel: 'Tool call ready: write_file' } },
    },
    {
      type: 'UPDATE_LAST_MESSAGE_META',
      payload: { modelActivity: { kind: 'tool_call_ready', toolName: 'write_file' } },
      sessionId: 's',
      messageId: 'assistant-1',
    },
  ])
  assert.equal(actions.some((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE'), false)
  assert.equal(actions.some((action) => 'serverSequence' in action), false)
})

test('dispatchTurnEvent stores progress with the durable stream cursor', async () => {
  const actions = []
  const result = await dispatchTurnEvent(createTurnEvent({
    id: 'progress', sessionId: 's', turnId: 't', sequence: 9, type: 'turn.progress',
    payload: { completed: 2, total: 5, filesChanged: 3, additions: 12, deletions: 4 },
    createdAt: 10,
  }), {
    dispatch: (action) => actions.push(action),
    taskId: 'task',
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })

  assert.equal(result.cursorCommitted, true)
  assert.deepEqual(actions, [{
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: { progress: { completed: 2, total: 5, filesChanged: 3, additions: 12, deletions: 4 } },
    sessionId: 's',
    messageId: 'assistant-1',
    serverTurnId: 't',
    serverSequence: 9,
  }])
})

test('dispatchTurnEvent exposes a paused directory request to the inline authorization card', async () => {
  const actions = []
  const clarification = {
    request_type: 'directory',
    access_mode: 'read_write',
    suggested_path: 'D:\\destok',
    question: 'Authorize a directory.',
  }
  const result = await dispatchTurnEvent(createTurnEvent({
    id: 'paused', sessionId: 's', turnId: 't', sequence: 10, type: 'turn.paused',
    payload: { text: '', clarification }, createdAt: 11,
  }), {
    dispatch: (action) => actions.push(action),
    taskId: 'task',
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })

  assert.equal(result.cursorCommitted, true)
  assert.deepEqual(actions[0], {
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: {
      streaming: false,
      paused: true,
      serverConnectionState: 'paused',
      serverClarification: clarification,
      directoryAuthorizationPending: false,
      serverResumeResolution: null,
    },
    sessionId: 's',
    messageId: 'assistant-1',
    serverTurnId: 't',
    serverSequence: 10,
  })
  assert.equal(actions[1].payload.updates.stepLabel, 'Authorize a directory.')
})

test('dispatchTurnEvent preserves structured tool failure details for the UI', async () => {
  const actions = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'failed-tool', sessionId: 's', turnId: 't', sequence: 4, type: 'tool.completed',
    payload: {
      toolCallId: 'c-failed', name: 'read_file', artifactId: null,
      result: { ok: false, code: 'UPSTREAM_503', error: 'busy', status: 503, retryable: true, hint: 'try later', attempts: 2 },
      error: { code: 'UPSTREAM_503', message: 'busy', status: 503, retryable: true, hint: 'try later', attempts: 2 },
    },
    createdAt: 5,
  }), { dispatch: (action) => actions.push(action), taskId: 'task' })
  const payload = actions.find((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE').payload
  assert.deepEqual({
    error: payload.error, code: payload.errorCode, status: payload.errorStatus,
    retryable: payload.retryable, hint: payload.errorHint, attempts: payload.attempts,
  }, {
    error: 'busy', code: 'UPSTREAM_503', status: 503,
    retryable: true, hint: 'try later', attempts: 2,
  })
})

test('turn failure payloads retain recovery evidence and dispatch it without appending text', async () => {
  const payload = {
    code: 'MODEL_TIMEOUT',
    message: 'provider timed out',
    error: {
      code: 'MODEL_TIMEOUT', message: 'provider timed out', status: 504,
      retryable: true, hint: 'check the endpoint', attempts: 2,
    },
    partialText: 'durable partial output',
    artifactIds: ['a1', 'a1', 'a2'],
    iterations: 3,
  }
  assert.deepEqual(normalizeTurnFailurePayload(payload), {
    error: {
      code: 'MODEL_TIMEOUT', message: 'provider timed out', status: 504,
      retryable: true, hint: 'check the endpoint', attempts: 2,
    },
    partialText: 'durable partial output',
    artifactIds: ['a1', 'a2'],
    iterations: 3,
  })
  const error = createTurnFailureError(payload)
  assert.equal(error.status, 504)
  assert.equal(error.retryable, true)
  assert.deepEqual(error.artifactIds, ['a1', 'a2'])

  const actions = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'failed-turn', sessionId: 's', turnId: 't', sequence: 5,
    type: 'turn.failed', payload, createdAt: 6,
  }), {
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })
  assert.equal(actions.some((action) => action.type === 'APPEND_TO_LAST_MESSAGE'), false)
  const meta = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META')?.payload
  assert.deepEqual(meta.serverFailure, payload.error)
  assert.equal(meta.serverPartialText, 'durable partial output')
  assert.deepEqual(meta.serverArtifactIds, ['a1', 'a2'])
  assert.equal(meta.failed, true)
})

test('interrupted turns retain resumable evidence and a recovery attempt clears stale failure state', async () => {
  const actions = []
  const dispatch = (action) => actions.push(action)
  await dispatchTurnEvent(createTurnEvent({
    id: 'interrupted-turn', sessionId: 's', turnId: 't', sequence: 6,
    type: 'turn.interrupted',
    payload: {
      code: 'MODEL_503', message: 'temporarily unavailable', retryable: true,
      text: 'preserved work', artifactIds: ['artifact-1'], iterations: 2,
    },
    createdAt: 7,
  }), { dispatch, messageTarget: { sessionId: 's', messageId: 'assistant-1' } })
  const interrupted = actions.at(-1).payload
  assert.equal(interrupted.serverFailure.retryable, true)
  assert.equal(interrupted.serverPartialText, 'preserved work')
  assert.equal(interrupted.serverConnectionState, 'interrupted')

  await dispatchTurnEvent(createTurnEvent({
    id: 'attempt-turn', sessionId: 's', turnId: 't', sequence: 7,
    type: 'turn.attempt',
    payload: {
      attempt: 2, reason: 'turn_resume', resetStreaming: true,
      checkpointSequence: null, previousStreamSequence: 6,
      assistantText: 'preserved work', reasoningText: '',
    },
    createdAt: 8,
  }), { dispatch, messageTarget: { sessionId: 's', messageId: 'assistant-1' } })
  const cleared = actions.findLast((action) => action.type === 'UPDATE_LAST_MESSAGE_META').payload
  assert.equal(cleared.interrupted, false)
  assert.equal(cleared.serverFailure, null)
})

test('dispatchTurnEvent atomically maps a recovery attempt to stream reset and cursor metadata', async () => {
  const actions = []
  const result = await dispatchTurnEvent(createTurnEvent({
    id: 'attempt-2',
    sessionId: 's',
    turnId: 't',
    sequence: 9,
    type: 'turn.attempt',
    payload: {
      attempt: 2,
      reason: 'checkpoint_resume',
      resetStreaming: true,
      checkpointSequence: 5,
      previousStreamSequence: 8,
      assistantText: 'confirmed',
      reasoningText: 'checked',
    },
    createdAt: 10,
  }), {
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })

  assert.equal(result.cursorCommitted, true)
  assert.deepEqual(actions, [{
    type: 'RESET_LAST_MESSAGE_STREAM',
    payload: { attempt: 2, content: 'confirmed', reasoning: 'checked' },
    serverTurnId: 't',
    serverSequence: 9,
    sessionId: 's',
    messageId: 'assistant-1',
  }, {
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: {
      interrupted: false,
      serverFailure: null,
      serverPartialText: '',
      serverArtifactIds: [],
      modelActivity: null,
    },
    sessionId: 's',
    messageId: 'assistant-1',
  }])
})

test('fetchServerSessionSnapshot aggregates every page before normalizing messages', async () => {
  const urls = []
  const pages = [
    {
      session: { id: 'session/with spaces' },
      messages: [
        { id: 'm1', role: 'user', content: 'first', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'second', createdAt: 2, modelContext: {} },
      ],
      revision: 7,
      totalMessages: 3,
      offset: 0,
      nextOffset: 2,
      complete: false,
    },
    {
      session: { id: 'session/with spaces' },
      messages: [{ id: 'm3', role: 'user', content: 'third', createdAt: 3 }],
      revision: 7,
      totalMessages: 3,
      offset: 2,
      nextOffset: null,
      complete: true,
    },
  ]
  const snapshot = await fetchServerSessionSnapshot({
    sessionId: 'session/with spaces',
    pageSize: 2,
    fetchImpl: async (url) => {
      urls.push(String(url))
      return response({ snapshot: pages.shift() })
    },
  })

  assert.deepEqual(urls, [
    '/api/sessions/session%2Fwith%20spaces/snapshot?limit=2&offset=0',
    '/api/sessions/session%2Fwith%20spaces/snapshot?limit=2&offset=2',
  ])
  assert.equal(snapshot.complete, true)
  assert.equal(snapshot.revision, 7)
  assert.deepEqual(snapshot.messages.map((message) => message.id), ['m1', 'm2', 'm3'])
  assert.equal(snapshot.messages[1].meta.serverAuthoritative, true)
})

test('server snapshot restores steering identity for authoritative message reconciliation', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'steering-message-1',
      role: 'user',
      content: 'Keep the current work and add tests.',
      createdAt: 42,
      modelContext: {
        turnId: 'turn-1',
        steeringClientRequestId: 'steer-request-1',
      },
    }, {
      role: 'user',
      content: 'Then run the focused test suite.',
      createdAt: 43,
      modelContext: {
        turnId: 'turn-1',
        clientRequestId: 'steer-request-2',
      },
    }],
  })

  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    'steering-message-1',
    'steer:steer-request-2',
  ])
  assert.deepEqual(snapshot.messages.map((message) => message.meta), [{
    steering: true,
    steeringClientRequestId: 'steer-request-1',
    serverTurnId: 'turn-1',
    serverAuthoritative: true,
  }, {
    steering: true,
    steeringClientRequestId: 'steer-request-2',
    serverTurnId: 'turn-1',
    serverAuthoritative: true,
  }])
})

test('server snapshot synthesizes a recovery stub when refresh loses the local active turn', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-active:user',
      role: 'user',
      content: 'Keep working in the background.',
      createdAt: 10,
      updatedAt: 11,
      modelContext: { version: 1, turnId: 'turn-active', modelContent: 'Keep working in the background.' },
    }],
    revision: 4,
  })

  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    'turn-active:user',
    'turn-active:assistant',
  ])
  assert.deepEqual(snapshot.messages[1], {
    id: 'turn-active:assistant',
    role: 'assistant',
    content: '',
    timestamp: 11,
    meta: {
      serverTurnId: 'turn-active',
      serverLastSequence: -1,
      serverRecoveryStub: true,
      streaming: true,
    },
  })

  const completed = normalizeServerSessionSnapshot({
    complete: true,
    messages: [
      ...snapshot.messages.slice(0, 1).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.timestamp,
        modelContext: { turnId: 'turn-active' },
      })),
      {
        id: 'turn-active:assistant',
        role: 'assistant',
        content: 'Finished.',
        createdAt: 20,
        modelContext: { turnId: 'turn-active' },
      },
    ],
    revision: 4,
  })
  assert.equal(completed.messages.length, 2)
  assert.equal(completed.messages[1].meta.streaming, false)
  assert.equal(completed.messages[1].meta.serverRecoveryStub, undefined)
})

test('snapshot recovery stub follows steering and ignores unmatched turns from older history', () => {
  const active = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-active:user',
      role: 'user',
      content: 'Start.',
      createdAt: 10,
      modelContext: { turnId: 'turn-active' },
    }, {
      id: 'steering-1',
      role: 'user',
      content: 'Also run the tests.',
      createdAt: 15,
      updatedAt: 16,
      modelContext: {
        turnId: 'turn-active',
        liveSteering: true,
        steeringClientRequestId: 'steering-request-1',
      },
    }],
  })
  assert.deepEqual(active.messages.map((message) => message.id), [
    'turn-active:user',
    'steering-1',
    'turn-active:assistant',
  ])
  assert.equal(active.messages.at(-1).timestamp, 16)

  const completedLatestTurn = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-old:user',
      role: 'user',
      content: 'Cancelled before an assistant row was stored.',
      createdAt: 1,
      modelContext: { turnId: 'turn-old' },
    }, {
      id: 'turn-new:user',
      role: 'user',
      content: 'Try again.',
      createdAt: 2,
      modelContext: { turnId: 'turn-new' },
    }, {
      id: 'turn-new:assistant',
      role: 'assistant',
      content: 'Done.',
      createdAt: 3,
      modelContext: { turnId: 'turn-new' },
    }],
  })
  assert.deepEqual(completedLatestTurn.messages.map((message) => message.id), [
    'turn-old:user',
    'turn-new:user',
    'turn-new:assistant',
  ])
})

test('server snapshot pairs imported tool calls and supplies explicit unavailable results', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'imported-assistant',
      role: 'assistant',
      content: 'I used two tools.',
      createdAt: 1,
      modelContext: {
        toolCalls: [
          { id: 'call-found', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
          { id: 'call-missing', type: 'function', function: { name: 'grep', arguments: '{"query":"TODO"}' } },
        ],
      },
    }, {
      id: 'imported-tool-result',
      role: 'tool',
      content: '{"ok":true,"content":"README"}',
      createdAt: 2,
      modelContext: { toolCallId: 'call-found', name: 'read_file' },
    }],
  })

  assert.equal(snapshot.messages.length, 1)
  const trace = snapshot.messages[0].meta.toolTrace
  assert.deepEqual(trace[0].tool_calls.map((call) => call.id), ['call-found', 'call-missing'])
  assert.equal(trace[1].tool_call_id, 'call-found')
  assert.match(trace[1].content, /README/)
  assert.equal(trace[2].tool_call_id, 'call-missing')
  assert.match(trace[2].content, /tool_result_unavailable/)
  assert.deepEqual(
    snapshot.messages[0].meta.toolCalls.map(({ id, status }) => ({ id, status })),
    [
      { id: 'call-found', status: 'success' },
      { id: 'call-missing', status: 'error' },
    ],
  )
})

test('startServerTurn sends managed attachment references separately from content', async () => {
  let requestBody = null
  const attachments = [{
    id: 'attachment-1', name: 'report.pdf', mimeType: 'application/pdf', size: 8,
    sha256: 'hash', downloadUrl: '/api/attachments/attachment-1/content',
  }]
  await startServerTurn({
    sessionId: 's-attachment',
    content: 'summarize it',
    attachments,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return response({ turn: { sessionId: 's-attachment', turnId: 't-attachment', status: 'running' } }, 202)
    },
  })
  assert.equal(requestBody.content, 'summarize it')
  assert.deepEqual(requestBody.attachments, attachments)
  assert.doesNotMatch(requestBody.content, /report\.pdf|attachment-1/)
})

test('server snapshot restores persisted turn artifacts into assistant rendering metadata', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: 'The webpage is ready.',
      createdAt: 1,
      modelContext: { turnId: 'turn-1', artifactIds: ['html-1'] },
      artifacts: [{
        id: 'html-1',
        type: 'html',
        title: 'Landing page',
        filename: 'landing.html',
        url: '/api/artifacts/landing.html',
      }],
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta.serverArtifacts, [{
    id: 'html-1',
    type: 'html',
    title: 'Landing page',
    filename: 'landing.html',
    url: '/api/artifacts/landing.html',
  }])
})

test('server snapshot restores a paused directory request for inline authorization after reload', () => {
  const clarification = {
    question: 'Please choose and authorize a directory so this task can continue.',
    why: '需要在该目录下写入结果文件',
    request_type: 'directory',
    access_mode: 'read_write',
    suggested_path: 'D:\\destok',
    timestamp: 1786287304178,
  }
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-paused:assistant',
      role: 'assistant',
      content: '',
      createdAt: 1,
      modelContext: {
        version: 1,
        turnId: 'turn-paused',
        paused: true,
        pausedSequence: 7,
        clarification,
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta, {
    serverTurnId: 'turn-paused',
    streaming: false,
    serverAuthoritative: true,
    toolCalls: [],
    paused: true,
    serverConnectionState: 'paused',
    serverClarification: clarification,
    directoryAuthorizationPending: false,
    serverResumeResolution: null,
    serverLastSequence: 7,
  })
  assert.notEqual(snapshot.messages[0].meta.serverClarification, clarification)
})

test('server snapshot restores failed and interrupted turn evidence after reload', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-failed:assistant',
      role: 'assistant',
      content: 'I created the draft before the provider failed.',
      createdAt: 1,
      modelContext: {
        turnId: 'turn-failed',
        turnEvidence: true,
        evidenceState: 'failed',
        artifactIds: ['draft-1', 'draft-1'],
        iterations: 3,
        error: {
          code: 'MODEL_TIMEOUT',
          message: 'The model stopped responding.',
          retryable: true,
          hint: 'Resume the turn.',
        },
      },
    }, {
      id: 'turn-interrupted:assistant',
      role: 'assistant',
      content: 'Partial analysis',
      createdAt: 2,
      modelContext: {
        turnId: 'turn-interrupted',
        turnEvidence: true,
        evidenceState: 'interrupted',
        artifactIds: ['report-1'],
        error: { code: 'MODEL_CALL_INTERRUPTED', message: 'Connection lost', retryable: true },
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta, {
    serverTurnId: 'turn-failed',
    streaming: false,
    serverAuthoritative: true,
    toolCalls: [],
    failed: true,
    serverFailure: {
      code: 'MODEL_TIMEOUT',
      message: 'The model stopped responding.',
      retryable: true,
      hint: 'Resume the turn.',
    },
    serverPartialText: 'I created the draft before the provider failed.',
    serverArtifactIds: ['draft-1'],
    serverIterations: 3,
  })
  assert.equal(snapshot.messages[1].meta.interrupted, true)
  assert.equal(snapshot.messages[1].meta.failed, undefined)
  assert.deepEqual(snapshot.messages[1].meta.serverArtifactIds, ['report-1'])
  assert.equal(snapshot.messages[1].meta.serverFailure.code, 'MODEL_CALL_INTERRUPTED')
})

test('server snapshot restores structured tool failure details', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'tool-failure:assistant',
      role: 'assistant',
      content: 'The write could not be completed.',
      createdAt: 1,
      modelContext: {
        toolTrace: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'write-1',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"report.md"}' },
          }],
        }, {
          role: 'tool',
          tool_call_id: 'write-1',
          name: 'write_file',
          content: JSON.stringify({
            ok: false,
            code: 'EACCES',
            status: 403,
            error: 'Permission denied',
            retryable: false,
            hint: 'Choose a writable folder.',
            attempts: 2,
          }),
        }],
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta.toolCalls[0], {
    id: 'write-1',
    name: 'write_file',
    arguments: '{"path":"report.md"}',
    status: 'error',
    result: JSON.stringify({
      ok: false,
      code: 'EACCES',
      status: 403,
      error: 'Permission denied',
      retryable: false,
      hint: 'Choose a writable folder.',
      attempts: 2,
    }),
    error: 'Permission denied',
    errorCode: 'EACCES',
    errorStatus: 403,
    retryable: false,
    errorHint: 'Choose a writable folder.',
    attempts: 2,
    approvalAuthorization: null,
  })
})

test('fetchServerSessionSnapshot retries from offset zero when page revisions differ', async () => {
  const pages = [
    { messages: [{ id: 'stale-1', role: 'user', content: 'old', createdAt: 1 }], revision: 10, totalMessages: 2, nextOffset: 1, complete: false },
    { messages: [{ id: 'new-2', role: 'assistant', content: 'new', createdAt: 2 }], revision: 11, totalMessages: 2, nextOffset: null, complete: true },
    { messages: [{ id: 'new-1', role: 'user', content: 'new', createdAt: 1 }], revision: 11, totalMessages: 2, nextOffset: 1, complete: false },
    { messages: [{ id: 'new-2', role: 'assistant', content: 'new', createdAt: 2 }], revision: 11, totalMessages: 2, nextOffset: null, complete: true },
  ]
  const offsets = []
  const snapshot = await fetchServerSessionSnapshot({
    sessionId: 's-revision',
    pageSize: 1,
    fetchImpl: async (url) => {
      offsets.push(new URL(String(url), 'http://localhost').searchParams.get('offset'))
      return response({ snapshot: pages.shift() })
    },
  })

  assert.deepEqual(offsets, ['0', '1', '0', '1'])
  assert.equal(snapshot.revision, 11)
  assert.deepEqual(snapshot.messages.map((message) => message.id), ['new-1', 'new-2'])
})
