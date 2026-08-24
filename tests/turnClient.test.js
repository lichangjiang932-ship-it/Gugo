import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTurnActivity,
  createTurnEvent,
  createTurnEventTransportEnvelope,
} from '../shared/turnEvents.js'
import {
  INLINE_SKILL_DEFINITION_LIMITS,
  unicodeCharacterLength,
  utf8ByteLength,
} from '../shared/inlineSkillDefinitions.js'
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
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'
import { mergeServerSessionMessages } from '../src/store/sessionServerSync.js'

function response(body, status = 200, headers) {
  return { ok: status >= 200 && status < 300, status, headers, json: async () => body }
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

test('SSE turn transport negotiates v1 envelopes while retaining legacy payload decoding', async () => {
  const completed = createTurnEvent({
    id: 'sse-envelope-done',
    sessionId: 's-sse-envelope',
    turnId: 't-sse-envelope',
    sequence: 0,
    type: 'turn.completed',
    createdAt: 1,
  })
  let requestedUrl = null
  const response = sseResponse([createTurnEventTransportEnvelope(completed)])
  const terminal = await streamServerTurnEvents({
    sessionId: completed.sessionId,
    turnId: completed.turnId,
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return response
    },
  })

  assert.equal(terminal.id, completed.id)
  const requested = new URL(requestedUrl, 'http://localhost')
  assert.equal(requested.searchParams.get('turnEventVersion'), '1')
})

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
    let event = value
    if (type === 'message' && typeof value?.data === 'string') {
      try {
        const frame = JSON.parse(value.data)
        event = { ...value, data: JSON.stringify(frame?.v == null ? { v: 1, ...frame } : frame) }
      } catch {
        // Keep malformed JSON unchanged so the transport parser is exercised.
      }
    }
    for (const listener of this.listeners.get(type) || []) listener(event)
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
      v: 1,
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

test('WebSocket protocol errors preserve code, message, and recovery action', async () => {
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
    socket.emit('message', { data: JSON.stringify({
      type: 'error',
      code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
      message: 'turn runtime is not configured',
      action: 'restart_runtime',
    }) })
    await assert.rejects(
      stream,
      (error) => error.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
        && error.message === 'turn runtime is not configured'
        && error.action === 'restart_runtime',
    )
    assert.equal(socket.closed, true)
  })
})

test('WebSocket retry protocol errors preserve code, message, and recovery action', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-retry-protocol-error',
      turnId: 't-retry-protocol-error',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 60_000,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({
      type: 'error',
      code: 'TURN_ENGINE_SHUTTING_DOWN',
      message: 'turn runtime is restarting; retry shortly',
      action: 'retry',
    }) })
    await assert.rejects(
      stream,
      (error) => error.code === 'TURN_ENGINE_SHUTTING_DOWN'
        && error.message === 'turn runtime is restarting; retry shortly'
        && error.action === 'retry',
    )
    assert.equal(socket.closed, true)
  })
})

test('WebSocket version mismatch fails with a refreshable protocol error', async () => {
  await withWebSocketAuth(async () => {
    const socket = new FakeWebSocket()
    const stream = streamServerTurnEventsWebSocket({
      sessionId: 's-version-error',
      turnId: 't-version-error',
      connectTimeoutMs: 100,
      subscribeTimeoutMs: 60_000,
      webSocketFactory: () => socket,
    })
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ v: 2, type: 'ready' }) })
    await assert.rejects(
      stream,
      (error) => error.code === 'TURN_WEBSOCKET_VERSION_MISMATCH'
        && error.expectedVersion === 1
        && error.receivedVersion === 2,
    )
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
    modelMode: 'chat_only',
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
  assert.equal(requestBody.modelMode, 'chat_only')
})

test('startServerTurn sends only selected local skill definitions', async () => {
  let requestBody = null
  await startServerTurn({
    sessionId: 's-local-skill',
    content: 'use my local skill',
    skillIds: ['local-writer'],
    skillDefinitions: [
      {
        id: 'local-writer',
        name: 'Local writer',
        desc: 'User-authored workflow',
        perms: ['read', 'read'],
        systemPrompt: 'Inspect the source, edit the real file, and verify the result.',
        localCustom: true,
      },
      { id: 'not-selected', name: 'Ignored', systemPrompt: 'Do not send this.' },
    ],
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/turns/run')
      requestBody = JSON.parse(options.body)
      return response({ turn: { sessionId: 's-local-skill', turnId: 't-local-skill', status: 'running' } }, 202)
    },
  })

  assert.deepEqual(requestBody.skillDefinitions, [{
    id: 'local-writer',
    name: 'Local writer',
    description: 'User-authored workflow',
    permissions: ['read'],
    systemPrompt: 'Inspect the source, edit the real file, and verify the result.',
  }])
})

test('startServerTurn bounds multibyte inline skill fields by the durable event limits', async () => {
  const limits = INLINE_SKILL_DEFINITION_LIMITS
  let requestBody = null
  await startServerTurn({
    sessionId: 's-local-skill-bounds',
    content: 'use my bounded local skill',
    skillIds: ['local-writer'],
    skillDefinitions: [{
      id: 'local-writer',
      name: '名字🙂'.repeat(limits.name.maxCharacters),
      description: '说明🙂'.repeat(limits.description.maxCharacters),
      perms: ['权限🙂'.repeat(limits.permission.maxCharacters)],
      systemPrompt: '执行并验证🙂'.repeat(limits.systemPrompt.maxUtf8Bytes),
    }],
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return response({ turn: { sessionId: 's-local-skill-bounds', turnId: 't-local-skill-bounds', status: 'running' } }, 202)
    },
  })

  const definition = requestBody.skillDefinitions[0]
  assert.ok(unicodeCharacterLength(definition.name) <= limits.name.maxCharacters)
  assert.ok(utf8ByteLength(definition.name) <= limits.name.maxUtf8Bytes)
  assert.ok(unicodeCharacterLength(definition.description) <= limits.description.maxCharacters)
  assert.ok(utf8ByteLength(definition.description) <= limits.description.maxUtf8Bytes)
  assert.ok(unicodeCharacterLength(definition.permissions[0]) <= limits.permission.maxCharacters)
  assert.ok(utf8ByteLength(definition.permissions[0]) <= limits.permission.maxUtf8Bytes)
  assert.ok(utf8ByteLength(definition.systemPrompt) <= limits.systemPrompt.maxUtf8Bytes)
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

test('startServerTurn sends the selected workspace path only on the initial Turn request', async () => {
  let requestBody = null
  await startServerTurn({
    sessionId: 's-workspace',
    content: 'inspect project',
    workspacePath: '  C:\\Work\\Project  ',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return response({ turn: { sessionId: 's-workspace', turnId: 't-workspace' } }, 202)
    },
  })

  assert.equal(requestBody.workspacePath, 'C:\\Work\\Project')
})

test('runServerTurn preserves restart_runtime WebSocket failures without SSE fallback', async () => {
  await withWebSocketAuth(async () => {
    const urls = []
    const fetchImpl = async (url) => {
      urls.push(String(url))
      if (url === '/api/turns/run') {
        return response({
          turn: { sessionId: 's-ws-restart-runtime', turnId: 't-ws-restart-runtime', status: 'running' },
        }, 202)
      }
      throw new Error(`Unexpected fallback request: ${url}`)
    }

    await assert.rejects(
      runServerTurn({
        sessionId: 's-ws-restart-runtime',
        content: 'preserve the recovery action',
        fetchImpl,
        webSocketConnectTimeoutMs: 100,
        webSocketSubscribeTimeoutMs: 100,
        webSocketFactory: () => {
          const socket = new FakeWebSocket()
          queueMicrotask(() => {
            socket.emit('open')
            socket.emit('message', { data: JSON.stringify({
              type: 'error',
              code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
              message: 'turn runtime is not configured',
              action: 'restart_runtime',
            }) })
          })
          return socket
        },
      }),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
        && error?.message === 'turn runtime is not configured'
        && error?.action === 'restart_runtime',
    )
    assert.deepEqual(urls, ['/api/turns/run'])
  })
})

test('runServerTurn keeps the SSE fallback for retry WebSocket failures', async () => {
  await withWebSocketAuth(async () => {
    const completed = createTurnEvent({
      id: 'sse-after-ws-retry',
      sessionId: 's-ws-retry',
      turnId: 't-ws-retry',
      sequence: 0,
      type: 'turn.completed',
      createdAt: 1,
    })
    let sseCalls = 0
    const result = await runServerTurn({
      sessionId: completed.sessionId,
      content: 'retry through SSE',
      fetchImpl: async (url) => {
        if (url === '/api/turns/run') {
          return response({
            turn: { sessionId: completed.sessionId, turnId: completed.turnId, status: 'running' },
          }, 202)
        }
        if (String(url).startsWith('/api/turns/stream?')) {
          sseCalls += 1
          return sseResponse([completed])
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      webSocketConnectTimeoutMs: 100,
      webSocketSubscribeTimeoutMs: 100,
      webSocketFactory: () => {
        const socket = new FakeWebSocket()
        queueMicrotask(() => {
          socket.emit('open')
          socket.emit('message', { data: JSON.stringify({
            type: 'error',
            code: 'TURN_ENGINE_SHUTTING_DOWN',
            message: 'turn runtime is restarting; retry shortly',
            action: 'retry',
          }) })
        })
        return socket
      },
    })

    assert.equal(result.terminal.id, completed.id)
    assert.equal(sseCalls, 1)
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

test('startServerTurn preserves structured model readiness error fields', async () => {
  await assert.rejects(
    startServerTurn({
      sessionId: 's-readiness-error',
      content: 'must preserve the error',
      fetchImpl: async () => response({
        error: {
          code: 'MODEL_PROVIDER_CONFIG_CHANGED',
          message: 'provider changed',
          action: 'recreate_job',
          providerId: 'provider-uuid',
          modelName: 'bound-model',
          configRevision: 7,
          details: { expectedRevision: 7, currentRevision: 8 },
          retryable: true,
          retryAfter: 5,
        },
      }, 409, {
        get: (name) => String(name).toLowerCase() === 'retry-after' ? '12' : null,
      }),
    }),
    (error) => error?.status === 409
      && error?.code === 'MODEL_PROVIDER_CONFIG_CHANGED'
      && error?.action === 'recreate_job'
      && error?.providerId === 'provider-uuid'
      && error?.modelName === 'bound-model'
      && error?.configRevision === 7
      && error?.details?.currentRevision === 8
      && error?.retryable === true
      && error?.retryAfter === '12',
  )
})

test('runServerTurn does not enter recovery polling after an explicit preflight rejection', async () => {
  for (const code of [
    'MODEL_CONFIG_MISSING',
    'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
    'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
    'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
    'TURN_ENGINE_SHUTTING_DOWN',
    'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_CLEANUP_FAILED',
  ]) {
    const urls = []
    const connectionStates = []
    await assert.rejects(
      runServerTurn({
        sessionId: `session-${code}`,
        content: 'must not be treated as an ambiguous submission',
        fetchImpl: async (url) => {
          urls.push(String(url))
          assert.equal(url, '/api/turns/run')
          return response({
            error: {
              code,
              message: 'request rejected before the turn started',
              action: code === 'MODEL_CONFIG_MISSING' ? 'configure_model' : 'retry',
            },
          }, 503)
        },
        onConnectionState: (state) => connectionStates.push(state),
      }),
      (error) => error?.code === code && error?.status === 503,
    )
    assert.deepEqual(urls, ['/api/turns/run'], code)
    assert.deepEqual(connectionStates, [], code)
  }
})

test('runServerTurn accepts an explicit checkpoint-compaction cursor jump', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') {
      return response({ turn: { sessionId: 's-compacted', turnId: 't-compacted', status: 'running' } }, 202)
    }
    return sseResponse([
      createTurnEvent({
        id: 'compacted-terminal', sessionId: 's-compacted', turnId: 't-compacted', sequence: 2,
        compactedThrough: 3, type: 'turn.completed', payload: { text: 'done' }, createdAt: 3,
      }),
    ])
  }
  const result = await runServerTurn({
    sessionId: 's-compacted', content: 'resume compacted history', afterSequence: 0,
    fetchImpl, onEvent: (event) => seen.push(event.sequence),
  })
  assert.equal(result.lastSequence, 2)
  assert.deepEqual(seen, [2])
})

test('runServerTurn sends recovery override only for an explicit dead-letter retry', async () => {
  const bodies = []
  const completed = createTurnEvent({
    id: 'retry-recovery-completed', sessionId: 's1', turnId: 'retry-recovery',
    sequence: 0, type: 'turn.completed', createdAt: 3,
  })
  const fetchImpl = async (url, init = {}) => {
    if (url === '/api/turns/retry-recovery/resume') {
      bodies.push(JSON.parse(init.body))
      return response({
        turn: {
          sessionId: 's1', turnId: 'retry-recovery', status: 'completed', lastEvent: completed,
        },
      }, 202)
    }
    throw new Error(`unexpected request: ${url}`)
  }
  await runServerTurn({
    sessionId: 's1', turnId: 'retry-recovery', resume: true, retryRecovery: true, fetchImpl,
  })
  assert.deepEqual(bodies, [{ sessionId: 's1', retryRecovery: true }])
})

test('runServerTurn retries an incomplete turn without sending a new prompt payload', async () => {
  const bodies = []
  const completed = createTurnEvent({
    id: 'retry-failed-completed', sessionId: 'session-retry', turnId: 'turn-retry',
    sequence: 0, type: 'turn.completed', createdAt: 3,
  })
  const fetchImpl = async (url, init = {}) => {
    assert.equal(url, '/api/turns/turn-retry/resume')
    bodies.push(JSON.parse(init.body))
    return response({
      turn: {
        sessionId: 'session-retry', turnId: 'turn-retry', status: 'completed', lastEvent: completed,
      },
    }, 202)
  }

  await runServerTurn({
    sessionId: 'session-retry',
    turnId: 'turn-retry',
    resume: true,
    retryFailed: true,
    fetchImpl,
  })

  assert.deepEqual(bodies, [{ sessionId: 'session-retry', retryFailed: true }])
})

test('runServerTurn stops reconnecting when the server reports a recovery dead letter', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === '/api/turns/run') {
      return response({
        turn: {
          sessionId: 's1',
          turnId: 'dead-letter-turn',
          status: 'interrupted',
          recovery: {
            status: 'dead_letter',
            attemptCount: 1,
            retryable: false,
            nextRetryAt: null,
            error: {
              code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
              message: 'The provider outcome is unknown; automatic replay was stopped.',
            },
          },
        },
      }, 202)
    }
    throw new Error(`unexpected reconnect: ${url}`)
  }
  await assert.rejects(
    runServerTurn({
      sessionId: 's1',
      turnId: 'dead-letter-turn',
      content: 'do not replay me',
      fetchImpl,
    }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.retryable === false
      && error?.recovery?.status === 'dead_letter',
  )
  assert.deepEqual(urls, ['/api/turns/run'])
})

test('runServerTurn fails a persistent event sequence gap instead of reconnecting forever', async () => {
  const urls = []
  const skipped = createTurnEvent({
    id: 'gap-sequence-one', sessionId: 's1', turnId: 'gap-turn',
    sequence: 1, type: 'assistant.delta', payload: { text: 'missing prefix' }, createdAt: 2,
  })
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (url === '/api/turns/run') {
      return response({ turn: { sessionId: 's1', turnId: 'gap-turn', status: 'running' } }, 202)
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [skipped] })
    if (String(url).startsWith('/api/turns/gap-turn?')) {
      return response({ turn: { sessionId: 's1', turnId: 'gap-turn', status: 'running' } })
    }
    return sseResponse([skipped])
  }

  await assert.rejects(
    runServerTurn({ sessionId: 's1', content: 'detect the gap', fetchImpl, reconnectDelayMs: 0 }),
    (error) => error?.code === 'TURN_EVENT_SEQUENCE_GAP'
      && error?.expectedSequence === 0
      && error?.actualSequence === 1,
  )
  assert.equal(urls.some((url) => url.endsWith('/resume')), false)
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

test('runServerTurn takes over a known turn when the initial run response body disconnects', async () => {
  const urls = []
  const seen = []
  const started = createTurnEvent({
    id: 'initial-run-started', sessionId: 's-initial-run', turnId: 't-initial-run', sequence: 0,
    type: 'turn.started', payload: { content: 'continue' }, createdAt: 1,
  })
  const completed = createTurnEvent({
    id: 'initial-run-completed', sessionId: 's-initial-run', turnId: 't-initial-run', sequence: 1,
    type: 'turn.completed', payload: { text: 'finished' }, createdAt: 2,
  })
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (url === '/api/turns/run') {
      return {
        ok: true,
        status: 202,
        json: async () => { throw new TypeError('response body disconnected') },
      }
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [started] })
    if (String(url).startsWith('/api/turns/t-initial-run?')) {
      return response({ turn: { sessionId: 's-initial-run', turnId: 't-initial-run', status: 'running' } })
    }
    if (String(url).startsWith('/api/turns/stream?')) return sseResponse([completed])
    assert.fail(`unexpected takeover request: ${url}`)
  }

  const result = await runServerTurn({
    sessionId: 's-initial-run', turnId: 't-initial-run', content: 'continue', fetchImpl,
    onEvent: (event) => seen.push(event.type),
  })

  assert.equal(result.terminal.id, completed.id)
  assert.deepEqual(seen, ['turn.started', 'turn.completed'])
  assert.equal(urls.filter((url) => url === '/api/turns/run').length, 1)
  assert.equal(urls.some((url) => url.startsWith('/api/turns/events?')), true)
  assert.equal(urls.some((url) => url.startsWith('/api/turns/t-initial-run?')), true)
})

test('runServerTurn takes over a known turn when the initial resume response body disconnects', async () => {
  const urls = []
  const completed = createTurnEvent({
    id: 'initial-resume-completed', sessionId: 's-initial-resume', turnId: 't-initial-resume', sequence: 4,
    type: 'turn.completed', payload: { text: 'resumed and finished' }, createdAt: 2,
  })
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (url === '/api/turns/t-initial-resume/resume') {
      return {
        ok: true,
        status: 202,
        json: async () => { throw new TypeError('resume response body disconnected') },
      }
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/t-initial-resume?')) {
      return response({ turn: { sessionId: 's-initial-resume', turnId: 't-initial-resume', status: 'running' } })
    }
    if (String(url).startsWith('/api/turns/stream?')) return sseResponse([completed])
    assert.fail(`unexpected resume takeover request: ${url}`)
  }

  const result = await runServerTurn({
    sessionId: 's-initial-resume', turnId: 't-initial-resume', resume: true,
    afterSequence: 3, fetchImpl,
  })

  assert.equal(result.terminal.id, completed.id)
  assert.equal(urls.filter((url) => url === '/api/turns/t-initial-resume/resume').length, 1)
  assert.equal(urls.some((url) => url.startsWith('/api/turns/events?')), true)
  assert.equal(urls.some((url) => url.startsWith('/api/turns/t-initial-resume?')), true)
})

test('runServerTurn does not acknowledge an ambiguous start until the server proves the turn exists', async () => {
  let runCalls = 0
  let startedCalls = 0
  const completed = createTurnEvent({
    id: 'ambiguous-proof-completed', sessionId: 's-ambiguous-proof', turnId: 't-ambiguous-proof',
    sequence: 0, type: 'turn.completed', payload: { text: 'confirmed' }, createdAt: 2,
  })
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') {
      runCalls += 1
      if (runCalls === 1) throw new TypeError('initial response was lost')
      assert.equal(startedCalls, 0, 'an unproven recovery must not emit a client ACK')
      return response({
        turn: { sessionId: 's-ambiguous-proof', turnId: 't-ambiguous-proof', status: 'running' },
      }, 202)
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/t-ambiguous-proof?')) {
      return response({ error: { code: 'TURN_NOT_FOUND', message: 'turn not found' } }, 404)
    }
    if (String(url).startsWith('/api/turns/stream?')) return sseResponse([completed])
    assert.fail(`unexpected ambiguous recovery request: ${url}`)
  }

  const result = await runServerTurn({
    sessionId: 's-ambiguous-proof', turnId: 't-ambiguous-proof', content: 'prove it',
    fetchImpl, reconnectMaxAttempts: 1, reconnectDelayMs: 0, recoveryPollIntervalMs: 0,
    onStarted: () => { startedCalls += 1 },
  })

  assert.equal(result.terminal.id, completed.id)
  assert.equal(runCalls, 2)
  assert.equal(startedCalls, 1)
})

test('runServerTurn stops an unconfirmed initial recovery after a finite retry budget', async () => {
  let runCalls = 0
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') {
      runCalls += 1
      throw new TypeError('connection closed before acknowledgement')
    }
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    if (String(url).startsWith('/api/turns/t-unconfirmed?')) {
      return response({ error: { code: 'TURN_NOT_FOUND', message: 'turn not found' } }, 404)
    }
    assert.fail(`unexpected unconfirmed recovery request: ${url}`)
  }

  await assert.rejects(
    runServerTurn({
      sessionId: 's-unconfirmed', turnId: 't-unconfirmed', content: 'send once',
      fetchImpl, recoveryPollIntervalMs: 0, unconfirmedRecoveryMaxAttempts: 3,
    }),
    (error) => {
      assert.equal(error.code, 'TURN_REQUEST_UNCONFIRMED')
      assert.equal(error.retryable, true)
      assert.equal(error.attempts, 3)
      return true
    },
  )
  assert.equal(runCalls, 3)
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

test('runServerTurn cancels and retries while the initial start response is still pending', async () => {
  const urls = []
  const controller = new AbortController()
  let cancelCalls = 0
  const cancelled = createTurnEvent({
    id: 'cancelled-during-start', sessionId: 's-start-stop', turnId: 't-start-stop', sequence: 0,
    type: 'turn.cancelled', payload: { reason: 'user stopped' }, createdAt: 1,
  })
  const fetchImpl = async (url, options = {}) => {
    urls.push(String(url))
    if (url === '/api/turns/run') {
      queueMicrotask(() => controller.abort())
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('initial request aborted after cancellation acknowledgement')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
    if (url === '/api/turns/t-start-stop/cancel') {
      cancelCalls += 1
      if (cancelCalls === 1) {
        return response({ error: { code: 'TURN_NOT_FOUND', message: 'turn not found yet' } }, 404)
      }
      return response({
        turn: {
          sessionId: 's-start-stop', turnId: 't-start-stop', status: 'cancelled', lastEvent: cancelled,
        },
      })
    }
    assert.fail(`unexpected request after startup cancellation: ${url}`)
  }

  const result = await runServerTurn({
    sessionId: 's-start-stop', turnId: 't-start-stop', content: 'stop immediately',
    signal: controller.signal, fetchImpl, cancelRetryDelayMs: 0,
  })

  assert.equal(result.terminal.type, 'turn.cancelled')
  assert.equal(cancelCalls, 2)
  assert.deepEqual(urls, [
    '/api/turns/run',
    '/api/turns/t-start-stop/cancel',
    '/api/turns/t-start-stop/cancel',
  ])
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

test('runServerTurn consumes a persisted terminal after stream truncation without reconnecting or waking it', async () => {
  const completed = createTurnEvent({
    id: 'persisted-terminal', sessionId: 's1', turnId: 'persisted-terminal-turn', sequence: 1,
    type: 'turn.completed', payload: { text: 'final answer', artifactIds: ['final-file'] }, createdAt: 2,
  })
  const urls = []
  const states = []
  const seen = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (url === '/api/turns/run') {
      return response({ turn: { sessionId: 's1', turnId: 'persisted-terminal-turn', status: 'running' } }, 202)
    }
    if (String(url).startsWith('/api/turns/stream?')) return sseResponse([])
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [completed] })
    assert.fail(`terminal replay must finish before requesting ${url}`)
  }

  const result = await runServerTurn({
    sessionId: 's1', content: 'finish the file', fetchImpl, reconnectDelayMs: 0, afterSequence: 0,
    onConnectionState: (state) => states.push(state.status),
    onEvent: (event) => seen.push(event.type),
  })

  assert.equal(result.terminal.id, completed.id)
  assert.deepEqual(seen, ['turn.completed'])
  assert.deepEqual(states, [])
  assert.equal(urls.some((url) => url.endsWith('/resume')), false)
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

test('recovery polling retries realtime transports and restores live activity after the network returns', async () => {
  await withWebSocketAuth(async () => {
    let webSocketAttempts = 0
    let sseCalls = 0
    const activities = []
    const completed = createTurnEvent({
      id: 'realtime-recovered', sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery', sequence: 0,
      type: 'turn.completed', payload: { text: 'live again' }, createdAt: 2,
    })
    const activity = createTurnActivity({
      sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery',
      kind: 'tool_output_delta', toolName: 'run_command', toolCallId: 'tool-live',
      stream: 'stdout', chunk: 'network restored', createdAt: 1,
    })
    const fetchImpl = async (url) => {
      if (url === '/api/turns/run') {
        return response({ turn: { sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery', status: 'running' } }, 202)
      }
      if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
      if (String(url).startsWith('/api/turns/t-realtime-recovery?')) {
        return response({ turn: { sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery', status: 'running' } })
      }
      if (url === '/api/turns/t-realtime-recovery/resume') {
        return response({ turn: { sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery', status: 'running' } }, 202)
      }
      if (String(url).startsWith('/api/turns/stream?')) {
        sseCalls += 1
        return sseResponse([])
      }
      assert.fail(`unexpected realtime recovery request: ${url}`)
    }

    const result = await runServerTurn({
      sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery', content: 'keep going',
      fetchImpl, reconnectMaxAttempts: 1, reconnectDelayMs: 0, recoveryPollIntervalMs: 0,
      webSocketConnectTimeoutMs: 100, webSocketSubscribeTimeoutMs: 100,
      webSocketFactory: () => {
        webSocketAttempts += 1
        const attempt = webSocketAttempts
        const socket = new FakeWebSocket()
        queueMicrotask(() => {
          if (attempt === 1) {
            socket.emit('error')
            return
          }
          socket.emit('open')
          socket.emit('message', { data: JSON.stringify({
            type: 'subscribed.turn', sessionId: 's-realtime-recovery', turnId: 't-realtime-recovery',
          }) })
          socket.emit('message', { data: JSON.stringify({ type: 'turn.activity', activity }) })
          socket.emit('message', { data: JSON.stringify({ type: 'turn.event', event: completed }) })
        })
        return socket
      },
      onActivity: (value) => activities.push(value),
    })

    assert.equal(result.terminal.id, completed.id)
    assert.equal(webSocketAttempts, 2)
    assert.equal(sseCalls, 1)
    assert.deepEqual(activities, [activity])
  })
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
    payload: { approvalId: 'p1', toolName: 'write_file', args: { path: 'a' }, risk: 'medium', metadataSource: 'declared' }, createdAt: 3,
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
  assert.equal(artifacts[0].toolCallId, 'c1')
  assert.equal(approvals[0].id, 'p1')
  assert.equal(approvals[0].metadataSource, 'declared')
})

test('dispatchTurnEvent treats a legacy approval event without metadata source as fallback', async () => {
  const approvals = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'legacy-approval', sessionId: 's', turnId: 't', sequence: 0, type: 'approval.required',
    payload: { approvalId: 'legacy-p1', toolName: 'legacy_tool', risk: 'high' }, createdAt: 1,
  }), { taskId: 'task', onApproval: (approval) => approvals.push(approval) })
  assert.equal(approvals[0].metadataSource, 'fallback')
})

test('dispatchTurnEvent maps model failover/retry to a fallback notice', async () => {
  const actions = []
  const dispatch = (action) => actions.push(action)
  const options = { dispatch, taskId: 'task', messageTarget: { sessionId: 's', messageId: 'assistant-1' } }
  await dispatchTurnEvent(createTurnEvent({
    id: 'failover', sessionId: 's', turnId: 't', sequence: 0, type: 'model.failover',
    payload: { kind: 'failover', from: 'primary', to: 'backup', modelName: 'm1' }, createdAt: 1,
  }), options)
  await dispatchTurnEvent(createTurnEvent({
    id: 'retry', sessionId: 's', turnId: 't', sequence: 1, type: 'model.failover',
    payload: { kind: 'retry', attempt: 2, delayMs: 0, modelName: 'm1' }, createdAt: 2,
  }), options)

  const metaActions = actions.filter((action) => action.type === 'UPDATE_LAST_MESSAGE_META')
  assert.ok(metaActions.length >= 2)
  assert.deepEqual(metaActions[0].payload.modelFallback, {
    kind: 'failover', from: 'primary', to: 'backup', modelName: 'm1', attempt: null,
  })
  assert.deepEqual(metaActions[1].payload.modelFallback, {
    kind: 'retry', from: null, to: null, modelName: 'm1', attempt: 2,
  })
})

test('tool.started keeps arguments previously recorded by tool.call', async () => {
  let state = {
    activeSessionId: 's',
    sessions: [{
      id: 's',
      messages: [{ id: 'assistant-1', role: 'assistant', content: '', meta: { toolCalls: [] } }],
    }],
  }
  const actions = []
  const dispatch = (action) => {
    actions.push(action)
    const next = reduceMessageState(state, action)
    if (next) state = next
  }
  const options = {
    dispatch,
    taskId: 'task',
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  }

  await dispatchTurnEvent(createTurnEvent({
    id: 'call-with-args', sessionId: 's', turnId: 't', sequence: 0, type: 'tool.call',
    payload: { toolCallId: 'shell-1', name: 'bash_exec', args: { command: 'python verify.py' } },
    createdAt: 1,
  }), options)
  await dispatchTurnEvent(createTurnEvent({
    id: 'started-without-args', sessionId: 's', turnId: 't', sequence: 1, type: 'tool.started',
    payload: { toolCallId: 'shell-1', name: 'bash_exec', outputReplay: 'live_only' },
    createdAt: 2,
  }), options)

  const toolCall = state.sessions[0].messages[0].meta.toolCalls[0]
  assert.equal(toolCall.arguments, '{"command":"python verify.py"}')
  assert.equal(toolCall.outputReplay, 'live_only')
  const startedAction = actions.filter((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE').at(-1)
  assert.equal(Object.hasOwn(startedAction.payload, 'arguments'), false)
  assert.equal(startedAction.payload.outputReplay, 'live_only')
})

test('tool events commit the durable cursor and reject older interleaved progress', async () => {
  let state = {
    activeSessionId: 's',
    sessions: [{
      id: 's',
      messages: [{ id: 'assistant-1', role: 'assistant', content: '', meta: { toolCalls: [] } }],
    }],
  }
  const dispatch = (action) => {
    const next = reduceMessageState(state, action)
    if (next) state = next
  }
  const options = {
    dispatch,
    taskId: 'task',
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  }

  const started = await dispatchTurnEvent(createTurnEvent({
    id: 'cursor-tool-started', sessionId: 's', turnId: 't', sequence: 3,
    type: 'tool.started',
    payload: { toolCallId: 'cursor-tool', name: 'read_file', args: { path: 'a.txt' } },
    createdAt: 4,
  }), options)
  const completed = await dispatchTurnEvent(createTurnEvent({
    id: 'cursor-tool-completed', sessionId: 's', turnId: 't', sequence: 5,
    type: 'tool.completed',
    payload: { toolCallId: 'cursor-tool', name: 'read_file', result: { ok: true, content: 'new' } },
    createdAt: 6,
  }), options)
  await dispatchTurnEvent(createTurnEvent({
    id: 'stale-progress', sessionId: 's', turnId: 't', sequence: 4,
    type: 'turn.progress', payload: { completed: 0, total: 1 }, createdAt: 5,
  }), options)

  const meta = state.sessions[0].messages[0].meta
  assert.equal(started.cursorCommitted, true)
  assert.equal(completed.cursorCommitted, true)
  assert.equal(meta.serverTurnId, 't')
  assert.equal(meta.serverLastSequence, 5)
  assert.equal(meta.progress, undefined)
  assert.equal(meta.toolCalls[0].status, 'success')
  assert.match(meta.toolCalls[0].result, /"content":"new"/)
})

test('assistant delta appends text and publishes responding activity in one state update', async () => {
  const actions = []
  const result = await dispatchTurnEvent(createTurnEvent({
    id: 'assistant-delta-one-update',
    sessionId: 's',
    turnId: 't',
    sequence: 3,
    type: 'assistant.delta',
    payload: { text: 'hello' },
    createdAt: 4,
  }), {
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 's', messageId: 'assistant-1' },
  })

  assert.deepEqual(actions, [{
    type: 'APPEND_TO_LAST_MESSAGE',
    payload: 'hello',
    meta: { progress: null, modelActivity: { kind: 'responding' } },
    serverTurnId: 't',
    serverSequence: 3,
    sessionId: 's',
    messageId: 'assistant-1',
  }])
  assert.equal(result.cursorCommitted, true)
})

test('model heartbeat phases keep visible activity before and between streamed chunks', async () => {
  const actions = []
  const phases = ['waiting_first_token', 'streaming', 'idle', 'streaming']
  for (const [index, phase] of phases.entries()) {
    await dispatchTurnEvent(createTurnEvent({
      id: `model-heartbeat-${index}`,
      sessionId: 's',
      turnId: 't',
      sequence: index,
      type: 'model.phase',
      payload: { phase, iteration: 0 },
      createdAt: index + 1,
    }), {
      dispatch: (action) => actions.push(action),
      taskId: 'task',
      messageTarget: { sessionId: 's', messageId: 'assistant-1' },
    })
  }

  assert.deepEqual(
    actions.filter((action) => action.type === 'UPDATE_TASK').map((action) => action.payload.updates.stepLabel),
    [
      'Waiting for model output',
      'Receiving model output',
      'Model output paused; task is still running',
      'Receiving model output',
    ],
  )
  assert.deepEqual(
    actions.filter((action) => action.type === 'UPDATE_LAST_MESSAGE_META').map((action) => action.payload.modelActivity.kind),
    ['model', 'responding', 'model', 'responding'],
  )
})

test('terminal events stop streaming while interrupted turns remain visibly resumable', async () => {
  const cases = [
    { type: 'turn.completed', payload: { text: 'done', artifactIds: [] }, expected: 'cancelled', connection: null, streaming: false },
    { type: 'turn.paused', payload: { text: '', clarification: { question: 'Need input' } }, expected: 'cancelled', connection: 'paused', streaming: false },
    { type: 'turn.cancelled', payload: { reason: 'user stopped' }, expected: 'cancelled', connection: 'cancelled', streaming: false },
    { type: 'turn.interrupted', payload: { code: 'MODEL_503', message: 'interrupted', retryable: true }, expected: 'cancelled', connection: 'interrupted', streaming: true },
    {
      type: 'turn.blocked',
      payload: {
        code: 'TURN_PERMISSION_CONTEXT_DRIFT',
        message: 'repair permissions and retry',
        retryable: false,
        manualRetryable: true,
        recoveryStatus: 'dead_letter',
        checkpointSequence: 2,
      },
      expected: 'cancelled',
      connection: 'blocked',
      streaming: false,
      completedAt: null,
    },
    { type: 'turn.failed', payload: { code: 'TURN_FAILED', message: 'failed' }, expected: 'error', connection: null, streaming: false },
  ]

  for (const [index, terminal] of cases.entries()) {
    let state = {
      activeSessionId: 's',
      sessions: [{
        id: 's',
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          meta: {
            streaming: true,
            modelActivity: { kind: 'model' },
            serverConnectionState: 'reconnecting',
            toolCalls: [
              { id: 'running-call', name: 'bash_exec', status: 'running' },
              { id: 'finished-call', name: 'read_file', status: 'success' },
            ],
          },
        }],
      }],
    }
    const dispatch = (action) => {
      const next = reduceMessageState(state, action)
      if (next) state = next
    }

    const result = await dispatchTurnEvent(createTurnEvent({
      id: `terminal-${index}`,
      sessionId: 's',
      turnId: 't',
      sequence: index,
      type: terminal.type,
      payload: terminal.payload,
      createdAt: index + 1,
    }), {
      dispatch,
      taskId: 'task',
      messageTarget: { sessionId: 's', messageId: 'assistant-1' },
    })

    const meta = state.sessions[0].messages[0].meta
    assert.equal(result.cursorCommitted, true, terminal.type)
    assert.equal(meta.streaming, terminal.streaming, terminal.type)
    assert.equal(
      meta.turnCompletedAt,
      terminal.completedAt === null || terminal.streaming ? null : index + 1,
      terminal.type,
    )
    assert.equal(meta.modelActivity, null, terminal.type)
    assert.equal(meta.serverConnectionState, terminal.connection, terminal.type)
    if (terminal.type === 'turn.blocked') {
      assert.equal(meta.serverRecoveryBlocked, true)
      assert.equal(meta.failed, false)
      assert.equal(meta.paused, false)
    }
    if (terminal.type === 'turn.cancelled') {
      assert.ok(Object.hasOwn(meta, 'serverDeliveryArtifactIds'))
      assert.deepEqual(meta.serverDeliveryArtifactIds, [])
    }
    assert.deepEqual(
      meta.toolCalls.map(({ id, status }) => ({ id, status })),
      [
        { id: 'running-call', status: terminal.expected },
        { id: 'finished-call', status: 'success' },
      ],
      terminal.type,
    )
  }
})

test('side-effect blocked events normalize legacy and canonical recovery kinds for chat state', async () => {
  for (const recoveryKind of ['side_effect_unknown', 'side_effect_outcome_unknown']) {
    let state = {
      activeSessionId: 's',
      sessions: [{
        id: 's',
        messages: [{
          id: `assistant-${recoveryKind}`,
          role: 'assistant',
          content: '',
          meta: { streaming: true, toolCalls: [] },
        }],
      }],
    }
    const dispatch = (action) => {
      const next = reduceMessageState(state, action)
      if (next) state = next
    }
    const turnId = `turn-${recoveryKind}`
    await dispatchTurnEvent(createTurnEvent({
      id: `blocked-${recoveryKind}`,
      sessionId: 's',
      turnId,
      sequence: 1,
      type: 'turn.blocked',
      payload: {
        code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
        message: 'verify the local outcome',
        retryable: false,
        manualRetryable: true,
        recoveryStatus: 'dead_letter',
        recoveryKind,
        toolCallId: 'write-1',
        recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
        ...(recoveryKind === 'side_effect_outcome_unknown'
          ? { turnId, requiresUserVerification: true }
          : {}),
      },
      createdAt: 2,
    }), {
      dispatch,
      taskId: `task-${recoveryKind}`,
      messageTarget: { sessionId: 's', messageId: `assistant-${recoveryKind}` },
    })

    const meta = state.sessions[0].messages[0].meta
    assert.equal(meta.serverRecoveryBlocked, true)
    assert.equal(meta.serverRecoveryKind, 'side_effect_outcome_unknown')
    assert.equal(meta.serverRecoveryToolCallId, 'write-1')
    assert.equal(meta.serverRecoveryActionPath, '/settings?tab=recovery')
  }
})

test('later terminal states clear stale side-effect recovery metadata on the same message', async () => {
  const turnId = 'turn-recovery-transition'
  let state = {
    activeSessionId: 's',
    sessions: [{
      id: 's',
      messages: [{
        id: 'assistant-recovery-transition',
        role: 'assistant',
        content: '',
        meta: { streaming: true, serverTurnId: turnId, toolCalls: [] },
      }],
    }],
  }
  const dispatch = (action) => {
    const next = reduceMessageState(state, action)
    if (next) state = next
  }
  const emit = (sequence, type, payload) => dispatchTurnEvent(createTurnEvent({
    id: `recovery-transition-${sequence}`,
    sessionId: 's',
    turnId,
    sequence,
    type,
    payload,
    createdAt: sequence + 1,
  }), {
    dispatch,
    taskId: 'task-recovery-transition',
    messageTarget: { sessionId: 's', messageId: 'assistant-recovery-transition' },
  })

  await emit(1, 'turn.blocked', {
    code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
    message: 'verify the local outcome',
    retryable: false,
    manualRetryable: true,
    recoveryStatus: 'dead_letter',
    recoveryKind: 'side_effect_outcome_unknown',
    toolCallId: 'write-1',
    recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
    turnId,
    requiresUserVerification: true,
  })

  let meta = state.sessions[0].messages[0].meta
  assert.equal(meta.serverRecoveryBlocked, true)
  assert.equal(meta.serverRecoveryKind, 'side_effect_outcome_unknown')

  await emit(2, 'turn.blocked', {
    code: 'TURN_PERMISSION_CONTEXT_DRIFT',
    message: 'repair permissions and retry',
    retryable: false,
    manualRetryable: true,
    recoveryStatus: 'dead_letter',
    checkpointSequence: 1,
  })

  meta = state.sessions[0].messages[0].meta
  assert.equal(meta.serverRecoveryBlocked, true)
  assert.equal(meta.serverRecoveryKind, null)
  assert.equal(meta.serverRecoveryToolCallId, null)
  assert.equal(meta.serverRecoveryActionPath, null)

  await emit(3, 'turn.completed', { text: 'done', artifactIds: [] })

  meta = state.sessions[0].messages[0].meta
  assert.equal(meta.serverRecoveryBlocked, false)
  assert.equal(meta.serverRecoveryKind, null)
  assert.equal(meta.serverRecoveryToolCallId, null)
  assert.equal(meta.serverRecoveryActionPath, null)
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

  assert.deepEqual(artifacts.map(({ id, filename, name, toolCallId }) => ({ id, filename, name, toolCallId })), [
    { id: 'pdf-1', filename: '填写后 答题卡.pdf', name: 'bash_exec', toolCallId: 'shell-multi-output' },
    { id: 'png-1', filename: '第 1 页.png', name: 'bash_exec', toolCallId: 'shell-multi-output' },
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
      transientTurnActivity: true,
      serverTurnId: 't',
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

test('model usage events overwrite the current message with the latest measured prompt tokens', async () => {
  const actions = []
  const dispatch = (action) => actions.push(action)
  const target = { sessionId: 's', messageId: 'assistant-usage' }
  await dispatchTurnEvent(createTurnEvent({
    id: 'usage-phase', sessionId: 's', turnId: 't', sequence: 3, type: 'model.phase',
    payload: {
      phase: 'completed',
      iteration: 2,
      usage: { promptTokens: 420, completionTokens: 30, totalTokens: 450 },
      modelName: 'test-model',
      error: null,
    },
    createdAt: 4,
  }), { dispatch, taskId: 'task', messageTarget: target })
  await dispatchTurnEvent(createTurnEvent({
    id: 'usage-completed', sessionId: 's', turnId: 't', sequence: 4, type: 'turn.completed',
    payload: {
      text: 'done',
      usage: { promptTokens: 460, completionTokens: 35, totalTokens: 495 },
      turnModelUsage: { promptTokens: 880, completionTokens: 65, totalTokens: 945 },
      estimatedPromptTokens: 444,
    },
    createdAt: 5,
  }), { dispatch, taskId: 'task', messageTarget: target })

  const usageUpdates = actions
    .filter((action) => action.type === 'UPDATE_LAST_MESSAGE_META' && action.payload.modelUsage)
  assert.deepEqual(usageUpdates.map((action) => action.payload.actualPromptTokens), [420, 460])
  assert.deepEqual(usageUpdates.at(-1).payload.modelUsage, {
    promptTokens: 460,
    completionTokens: 35,
    totalTokens: 495,
  })
  assert.deepEqual(usageUpdates.at(-1).payload.turnModelUsage, {
    promptTokens: 880,
    completionTokens: 65,
    totalTokens: 945,
  })
  assert.equal(usageUpdates.at(-1).payload.serverEstimatedPromptTokens, 444)
})

test('dispatchTurnEvent preserves explicit empty delivery ids on completion', async () => {
  const actions = []
  const result = await dispatchTurnEvent(createTurnEvent({
    id: 'delivery-completed-event',
    sessionId: 'delivery-session',
    turnId: 'delivery-turn',
    sequence: 4,
    type: 'turn.completed',
    payload: {
      text: 'done',
      artifactIds: ['draft', 'final'],
      deliveryArtifactIds: [],
      iterations: 2,
    },
    createdAt: 5,
  }), { dispatch: (action) => actions.push(action) })

  const meta = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META')?.payload
  assert.deepEqual(meta.serverArtifactIds, ['draft', 'final'])
  assert.ok(Object.hasOwn(meta, 'serverDeliveryArtifactIds'))
  assert.deepEqual(meta.serverDeliveryArtifactIds, [])
  assert.equal(result.cursorCommitted, true)
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
        serverRecoveryBlocked: false,
        serverRecoveryKind: null,
        serverRecoveryToolCallId: null,
        serverRecoveryActionPath: null,
        streaming: false,
        turnCompletedAt: 11,
        modelActivity: null,
        progress: null,
        paused: true,
      serverConnectionState: 'paused',
      serverClarification: clarification,
      directoryAuthorizationPending: false,
      serverResumeResolution: null,
      finalizeRunningToolCalls: { status: 'cancelled' },
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

test('retained local files survive terminal dispatch, snapshot restore, and authoritative session merge', async () => {
  const retainedLocalFiles = [{
    id: 'retained-client-file',
    path: 'D:\\workspace\\partial.html',
    filename: 'partial.html',
    size: 2048,
    retainedAt: 123,
    relatedArtifactIds: ['draft-1', 'draft-1'],
  }]
  const actions = []
  const event = createTurnEvent({
    id: 'retained-failed-event',
    sessionId: 'retained-session',
    turnId: 'retained-turn',
    sequence: 4,
    type: 'turn.failed',
    payload: {
      code: 'DELIVERY_VALIDATION_FAILED',
      message: 'The final artifact did not pass validation.',
      retainedLocalFiles,
    },
    createdAt: 5,
  })
  assert.deepEqual(event.payload.retainedLocalFiles, retainedLocalFiles)
  await dispatchTurnEvent(event, {
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 'retained-session', messageId: 'retained-turn:assistant' },
  })

  const liveMeta = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META')?.payload
  assert.deepEqual(liveMeta.retainedLocalFiles, [{
    ...retainedLocalFiles[0],
    relatedArtifactIds: ['draft-1'],
  }])

  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'retained-turn:assistant',
      role: 'assistant',
      content: 'The modified file was retained.',
      createdAt: 5,
      modelContext: {
        turnId: 'retained-turn',
        turnEvidence: true,
        evidenceState: 'failed',
        retainedLocalFiles,
      },
    }],
  })
  assert.deepEqual(snapshot.messages[0].meta.retainedLocalFiles, [{
    ...retainedLocalFiles[0],
    relatedArtifactIds: ['draft-1'],
  }])

  const [merged] = mergeServerSessionMessages([{
    ...snapshot.messages[0],
    meta: {
      ...snapshot.messages[0].meta,
      retainedLocalFiles: [{
        id: 'stale-retained-file',
        path: 'D:\\workspace\\stale.html',
        filename: 'stale.html',
      }],
    },
  }], snapshot.messages)
  assert.deepEqual(merged.meta.retainedLocalFiles, snapshot.messages[0].meta.retainedLocalFiles)
})

test('verified receipts supersede matching retained receipts in SSE and snapshots', async () => {
  const verifiedLocalFiles = [{
    id: 'verified-upgrade',
    path: 'D:\\workspace\\REPORT.HTML',
    filename: 'REPORT.HTML',
    verifiedAt: 456,
  }, {
    id: 'same-receipt-id',
    path: 'D:\\workspace\\renamed.html',
    filename: 'renamed.html',
    verifiedAt: 457,
  }]
  const unrelated = {
    id: 'retained-unrelated',
    path: 'D:\\workspace\\other.html',
    filename: 'other.html',
    retainedAt: 123,
  }
  const retainedLocalFiles = [{
    id: 'retained-old-path-id',
    path: 'd:/WORKSPACE/report.html',
    filename: 'report.html',
    retainedAt: 121,
  }, {
    id: 'same-receipt-id',
    path: 'D:\\workspace\\old-name.html',
    filename: 'old-name.html',
    retainedAt: 122,
  }, unrelated]
  const actions = []

  await dispatchTurnEvent(createTurnEvent({
    id: 'verified-upgrade-completed',
    sessionId: 'verified-upgrade-session',
    turnId: 'verified-upgrade-turn',
    sequence: 9,
    type: 'turn.completed',
    payload: { verifiedLocalFiles, retainedLocalFiles },
    createdAt: 10,
  }), {
    dispatch: (action) => actions.push(action),
    messageTarget: {
      sessionId: 'verified-upgrade-session',
      messageId: 'verified-upgrade-turn:assistant',
    },
  })

  const liveMeta = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META')?.payload
  assert.deepEqual(liveMeta.verifiedLocalFiles, verifiedLocalFiles)
  assert.deepEqual(liveMeta.retainedLocalFiles, [unrelated])

  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'verified-upgrade-turn:assistant',
      role: 'assistant',
      content: 'done',
      createdAt: 10,
      modelContext: {
        turnId: 'verified-upgrade-turn',
        verifiedLocalFiles,
        retainedLocalFiles,
      },
    }],
  })
  assert.deepEqual(snapshot.messages[0].meta.verifiedLocalFiles, verifiedLocalFiles)
  assert.deepEqual(snapshot.messages[0].meta.retainedLocalFiles, [unrelated])
})

test('terminal verified receipts prune matching retained state when retained is omitted', async () => {
  const verified = {
    id: 'verified-upgrade',
    path: 'd:/WORKSPACE/report.html',
    filename: 'REPORT.HTML',
  }
  const retained = {
    id: 'retained-old-path',
    path: 'D:\\workspace\\report.html',
    filename: 'report.html',
  }
  const unrelated = {
    id: 'retained-unrelated',
    path: 'D:\\workspace\\other.html',
    filename: 'other.html',
  }

  for (const type of [
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
    'turn.paused',
    'turn.cancelled',
  ]) {
    let state = {
      activeSessionId: 'terminal-files-session',
      sessions: [{
        id: 'terminal-files-session',
        messages: [{
          id: 'terminal-files-assistant',
          role: 'assistant',
          content: 'done',
          meta: {
            streaming: true,
            serverTurnId: 'terminal-files-turn',
            serverLastSequence: 4,
            retainedLocalFiles: [retained, unrelated],
          },
        }],
      }],
    }
    const dispatch = (action) => {
      const next = reduceMessageState(state, action)
      if (next) state = next
    }

    await dispatchTurnEvent(createTurnEvent({
      id: `terminal-files-${type}`,
      sessionId: 'terminal-files-session',
      turnId: 'terminal-files-turn',
      sequence: 5,
      type,
      payload: {
        ...(type === 'turn.interrupted'
          ? { code: 'MODEL_INTERRUPTED', message: 'interrupted after saving the file', retryable: true }
          : {}),
        ...(type === 'turn.paused'
          ? { text: '', clarification: 'Authorize the workspace directory.' }
          : {}),
        verifiedLocalFiles: [verified],
      },
      createdAt: 6,
    }), {
      dispatch,
      taskId: 'terminal-files-task',
      messageTarget: {
        sessionId: 'terminal-files-session',
        messageId: 'terminal-files-assistant',
      },
    })

    const meta = state.sessions[0].messages[0].meta
    assert.deepEqual(meta.verifiedLocalFiles, [verified], type)
    assert.deepEqual(meta.retainedLocalFiles, [unrelated], type)
  }
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
  const interrupted = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META').payload
  assert.equal(interrupted.serverFailure.retryable, true)
  assert.equal(interrupted.serverPartialText, 'preserved work')
  assert.equal(interrupted.serverConnectionState, 'interrupted')
  assert.equal(interrupted.streaming, true)
  assert.equal(interrupted.turnCompletedAt, null)
  assert.equal(interrupted.latency, null)

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
  const cleared = actions.findLast((action) => action.type === 'RESET_LAST_MESSAGE_STREAM').meta
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
    meta: {
      serverRecoveryBlocked: false,
      serverRecoveryKind: null,
      serverRecoveryToolCallId: null,
      serverRecoveryActionPath: null,
      interrupted: false,
      failed: false,
      paused: false,
      streaming: true,
      turnCompletedAt: null,
      latency: null,
      serverFailure: null,
      serverPartialText: '',
      serverArtifactIds: [],
      modelActivity: null,
    },
    serverTurnId: 't',
    serverSequence: 9,
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

test('server snapshot restores measured model usage for the context ring', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-usage:assistant',
      role: 'assistant',
      content: 'done',
      createdAt: 1,
      modelContext: {
        turnId: 'turn-usage',
        usage: { promptTokens: 512, completionTokens: 64, totalTokens: 576 },
        turnModelUsage: { promptTokens: 900, completionTokens: 96, totalTokens: 996 },
        estimatedPromptTokens: 500,
      },
    }],
  })

  assert.equal(snapshot.messages[0].meta.actualPromptTokens, 512)
  assert.deepEqual(snapshot.messages[0].meta.modelUsage, {
    promptTokens: 512,
    completionTokens: 64,
    totalTokens: 576,
  })
  assert.deepEqual(snapshot.messages[0].meta.turnModelUsage, {
    promptTokens: 900,
    completionTokens: 96,
    totalTokens: 996,
  })
  assert.equal(snapshot.messages[0].meta.serverEstimatedPromptTokens, 500)
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
  assert.equal(Object.hasOwn(snapshot.messages[0].meta, 'serverDeliveryArtifactIds'), false)
})

test('server snapshot preserves explicit delivery artifact ids including an empty selection', () => {
  const baseMessage = {
    role: 'assistant',
    content: 'Finished.',
    createdAt: 1,
    artifacts: [{
      id: 'report-1',
      type: 'pdf',
      title: 'Report',
      filename: 'report.pdf',
      url: '/api/artifacts/report.pdf',
    }],
  }
  const selected = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      ...baseMessage,
      id: 'turn-selected:assistant',
      modelContext: {
        turnId: 'turn-selected',
        artifactIds: ['report-1'],
        deliveryArtifactIds: ['report-1'],
      },
    }],
  })
  assert.deepEqual(selected.messages[0].meta.serverDeliveryArtifactIds, ['report-1'])

  const empty = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      ...baseMessage,
      id: 'turn-empty:assistant',
      modelContext: {
        turnId: 'turn-empty',
        artifactIds: ['report-1'],
        deliveryArtifactIds: [],
      },
    }],
  })
  assert.ok(Object.hasOwn(empty.messages[0].meta, 'serverDeliveryArtifactIds'))
  assert.deepEqual(empty.messages[0].meta.serverDeliveryArtifactIds, [])
  assert.equal(empty.messages[0].meta.serverArtifacts.length, 1)
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
    turnCompletedAt: 1,
    paused: true,
    serverConnectionState: 'paused',
    serverClarification: clarification,
    directoryAuthorizationPending: false,
    serverResumeResolution: null,
    serverLastSequence: 7,
  })
  assert.notEqual(snapshot.messages[0].meta.serverClarification, clarification)
})

test('server snapshot restores failed, interrupted, and cancelled turn evidence after reload', () => {
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
        serverLastSequence: 9,
        turnCompletedAt: 2,
        latency: 1,
        artifactIds: ['report-1'],
        error: { code: 'MODEL_CALL_INTERRUPTED', message: 'Connection lost', retryable: true },
      },
    }, {
      id: 'turn-cancelled:assistant',
      role: 'assistant',
      content: 'Stopped after saving the draft.',
      createdAt: 3,
      modelContext: {
        turnId: 'turn-cancelled',
        turnEvidence: true,
        evidenceState: 'cancelled',
        serverLastSequence: 11,
        artifactIds: ['cancelled-draft'],
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta, {
    serverTurnId: 'turn-failed',
    streaming: false,
    serverAuthoritative: true,
    toolCalls: [],
    turnCompletedAt: 1,
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
  assert.equal(snapshot.messages[1].meta.serverConnectionState, 'interrupted')
  assert.equal(snapshot.messages[1].meta.streaming, true)
  assert.equal(snapshot.messages[1].meta.turnCompletedAt, null)
  assert.equal(snapshot.messages[1].meta.latency, null)
  assert.equal(snapshot.messages[1].meta.serverLastSequence, 9)
  assert.equal(snapshot.messages[1].meta.failed, undefined)
  assert.deepEqual(snapshot.messages[1].meta.serverArtifactIds, ['report-1'])
  assert.equal(snapshot.messages[1].meta.serverFailure.code, 'MODEL_CALL_INTERRUPTED')
  assert.equal(snapshot.messages[2].meta.cancelled, true)
  assert.equal(snapshot.messages[2].meta.serverConnectionState, 'cancelled')
  assert.equal(snapshot.messages[2].meta.streaming, false)
  assert.equal(snapshot.messages[2].meta.turnCompletedAt, 3)
  assert.equal(snapshot.messages[2].meta.serverLastSequence, 11)
  assert.equal(snapshot.messages[2].meta.failed, undefined)
  assert.equal(snapshot.messages[2].meta.interrupted, undefined)
  assert.deepEqual(snapshot.messages[2].meta.serverArtifactIds, ['cancelled-draft'])
})

test('server snapshot restores only whitelisted side-effect recovery metadata after reload', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'turn-blocked:assistant',
      role: 'assistant',
      content: 'Verify the operation outcome before retrying.',
      createdAt: 4,
      modelContext: {
        turnId: 'turn-blocked',
        turnEvidence: true,
        evidenceState: 'blocked',
        serverLastSequence: 12,
        turnCompletedAt: 4,
        latency: 3,
        error: {
          code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
          message: 'Verify the operation outcome before retrying.',
          retryable: false,
        },
        recovery: {
          recoveryKind: 'side_effect_unknown',
          requiresUserVerification: true,
          toolCallId: 'write-1',
          recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
          args: { secret: 'must-not-project' },
          outcome: { secret: 'must-not-project' },
        },
      },
    }],
  })

  const meta = snapshot.messages[0].meta
  assert.equal(meta.serverTurnId, 'turn-blocked')
  assert.equal(meta.serverLastSequence, 12)
  assert.equal(meta.streaming, false)
  assert.equal(meta.turnCompletedAt, null)
  assert.equal(meta.latency, null)
  assert.equal(meta.failed, false)
  assert.equal(meta.serverConnectionState, 'blocked')
  assert.equal(meta.serverRecoveryBlocked, true)
  assert.equal(meta.serverRecoveryKind, 'side_effect_outcome_unknown')
  assert.equal(meta.serverRecoveryToolCallId, 'write-1')
  assert.equal(meta.serverRecoveryActionPath, '/settings?tab=recovery')
  assert.doesNotMatch(JSON.stringify(meta), /must-not-project/u)
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

test('server snapshot recovers only selected artifacts from successful legacy tool results', () => {
  const toolCall = (id, name = 'write_file') => ({
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  })
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-artifacts:assistant',
      role: 'assistant',
      content: 'The requested file is ready.',
      createdAt: 1,
      modelContext: {
        turnId: 'legacy-artifacts',
        deliveryArtifactIds: ['final-file', 'failed-file', 'external-file', 'stray-file', 'final-file'],
        toolTrace: [{
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('create-draft'), toolCall('create-final'), toolCall('create-failed'), toolCall('create-external')],
        }, {
          role: 'tool',
          tool_call_id: 'create-draft',
          name: 'write_file',
          content: JSON.stringify({
            ok: true,
            artifactId: 'draft-file',
            filename: 'draft.html',
            url: '/api/artifacts/draft-file',
          }),
        }, {
          role: 'tool',
          tool_call_id: 'create-final',
          name: 'write_file',
          content: JSON.stringify({
            ok: true,
            artifacts: [{
              id: 'final-file',
              filename: 'final.html',
              type: 'html',
              url: '/api/artifacts/final-file',
            }, {
              id: 'unselected-helper',
              filename: 'helper.js',
              url: '/api/artifacts/unselected-helper',
            }],
          }),
        }, {
          role: 'tool',
          tool_call_id: 'create-failed',
          name: 'write_file',
          content: JSON.stringify({
            ok: false,
            artifactId: 'failed-file',
            filename: 'failed.html',
            url: '/api/artifacts/failed-file',
          }),
        }, {
          role: 'tool',
          tool_call_id: 'create-external',
          name: 'write_file',
          content: JSON.stringify({
            ok: true,
            artifactId: 'external-file',
            filename: 'external.html',
            url: 'https://example.com/external.html',
          }),
        }, {
          role: 'tool',
          tool_call_id: 'undeclared-call',
          name: 'write_file',
          content: JSON.stringify({
            ok: true,
            artifactId: 'stray-file',
            filename: 'stray.html',
            url: '/api/artifacts/stray-file',
          }),
        }],
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].meta.serverDeliveryArtifactIds, [
    'final-file',
    'failed-file',
    'external-file',
    'stray-file',
  ])
  assert.deepEqual(snapshot.messages[0].meta.serverArtifacts, [{
    id: 'final-file',
    filename: 'final.html',
    url: '/api/artifacts/final-file',
    toolCallId: 'create-final',
    type: 'html',
  }])
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
