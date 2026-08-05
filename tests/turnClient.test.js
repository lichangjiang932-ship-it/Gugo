import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnEvent } from '../shared/turnEvents.js'
import {
  dispatchTurnEvent,
  fetchServerSessionSnapshot,
  reconnectDelayForAttempt,
  replayServerTurn,
  runServerTurn,
  startServerTurn,
} from '../src/lib/turnClient.js'

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

test('startServerTurn sends a canonical explicit tools configuration', async () => {
  let requestBody = null
  await startServerTurn({
    sessionId: 's-tools',
    content: 'use configured tools',
    agentId: ' agent-primary ',
    skillIds: [' skill-review ', 'skill-review', '', 42],
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

test('runServerTurn requests server cancellation when aborted', async () => {
  const urls = []
  const controller = new AbortController()
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 't-stop', status: 'running' } }, 202)
    if (url === '/api/turns/t-stop/cancel') return response({ turn: { turnId: 't-stop', status: 'cancelled' } })
    return response({ events: [] })
  }
  await assert.rejects(
    runServerTurn({
      sessionId: 's1', turnId: 't-stop', content: 'stop', signal: controller.signal, fetchImpl,
      onStarted: () => controller.abort(),
    }),
    (error) => error.name === 'AbortError',
  )
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

test('runServerTurn stops reconnecting at the configured maximum', async () => {
  const states = []
  let streamCalls = 0
  const fetchImpl = async (url) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'exhaust', status: 'running' } }, 202)
    if (String(url).startsWith('/api/turns/events?')) return response({ events: [] })
    streamCalls += 1
    return sseResponse([])
  }
  await assert.rejects(
    runServerTurn({
      sessionId: 's1', content: 'hello', fetchImpl, reconnectDelayMs: 0, reconnectMaxAttempts: 3,
      onConnectionState: (state) => states.push(state.status),
    }),
    (error) => error.code === 'TURN_RECONNECT_EXHAUSTED',
  )
  assert.equal(streamCalls, 3)
  assert.deepEqual(states, ['reconnecting', 'reconnecting', 'failed'])
})

test('aborting during reconnect wait stops immediately and the replay call sees the signal', async () => {
  const controller = new AbortController()
  let replaySignal = null
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/turns/run') return response({ turn: { sessionId: 's1', turnId: 'abort-wait', status: 'running' } }, 202)
    if (url === '/api/turns/abort-wait/cancel') return response({ turn: { turnId: 'abort-wait', status: 'cancelled' } })
    if (String(url).startsWith('/api/turns/events?')) {
      replaySignal = options.signal
      return response({ events: [] })
    }
    return sseResponse([])
  }
  await assert.rejects(
    runServerTurn({
      sessionId: 's1', content: 'hello', signal: controller.signal, fetchImpl, reconnectDelayMs: 60_000,
      onConnectionState: (state) => {
        if (state.status === 'reconnecting') controller.abort()
      },
    }),
    (error) => error.name === 'AbortError',
  )
  assert.equal(replaySignal, controller.signal)
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
    payload: { toolCallId: 'c1', name: 'create_docx', artifactId: 'a1', result: { ok: true, artifactId: 'a1', filename: 'a.docx', url: '/api/artifacts/a.docx', approvalAuthorization: { source: 'standing_rule', grantId: 'g1' } } }, createdAt: 2,
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
  assert.equal(artifacts[0].filename, 'a.docx')
  assert.equal(approvals[0].id, 'p1')
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
