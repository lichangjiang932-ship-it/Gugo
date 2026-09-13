import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  createGugoClient,
  GUGO_SDK_CONTRACT_VERSION,
  GugoSdkError,
} from '../sdk/index.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('public SDK starts a Turn through the versioned HTTP contract without forwarding unknown fields', async () => {
  const requests = []
  const client = createGugoClient({
    baseUrl: 'https://gugo.example/',
    token: 'sdk-token',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return json({ turn: { turnId: 'turn-1', sessionId: 'session-1' } }, 202)
    },
  })
  const turn = await client.startTurn({
    sessionId: 'session-1',
    content: 'Inspect the repository.',
    modelMode: 'agent',
    intentMode: 'answer',
    unknownAuthority: 'must-not-cross',
  })
  assert.equal(client.contractVersion, GUGO_SDK_CONTRACT_VERSION)
  assert.equal(Object.isFrozen(client), true)
  assert.equal(turn.turnId, 'turn-1')
  assert.equal(requests[0].url, 'https://gugo.example/api/turns/run')
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer sdk-token')
  assert.equal(requests[0].init.headers['X-Gugo-SDK-Contract'], '1')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    sessionId: 'session-1',
    content: 'Inspect the repository.',
    modelMode: 'agent',
    intentMode: 'answer',
  })
})

test('public SDK polls contiguous events and returns the first terminal event', async () => {
  const requestedAfter = []
  const observed = []
  let page = 0
  const client = createGugoClient({
    baseUrl: 'http://127.0.0.1:5173',
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      requestedAfter.push(parsed.searchParams.get('after'))
      page += 1
      return page === 1
        ? json({ events: [
            { sequence: 0, type: 'turn.started', payload: {} },
            { sequence: 1, type: 'tool.completed', payload: { name: 'read_file' } },
          ] })
        : json({ events: [
            { sequence: 2, type: 'turn.completed', payload: { text: 'done' } },
          ] })
    },
  })
  const terminal = await client.waitForTerminal({
    sessionId: 'session-1',
    turnId: 'turn-1',
    pollIntervalMs: 10,
    timeoutMs: 1_000,
    onEvent: (event) => observed.push(event.type),
  })
  assert.equal(terminal.type, 'turn.completed')
  assert.deepEqual(requestedAfter, ['-1', '1'])
  assert.deepEqual(observed, ['turn.started', 'tool.completed', 'turn.completed'])
})

test('public SDK streams versioned SSE events, activities, and compacted sequence advances', async () => {
  const encoder = new TextEncoder()
  const chunks = [
    'event: ready\ndata: {"phase":"connecting"}\n\n'
      + 'event: turn_event\ndata: {"v":1,"type":"turn.event","event":{"sequence":0,"type":"turn.started","payload":{}}}\n\n',
    'event: turn_activity\ndata: {"kind":"model_working"}\n\n'
      + 'event: turn_event\ndata: {"v":1,"type":"turn.event","event":{"sequence":2,"compactedThrough":2,"type":"turn.completed","payload":{"text":"done"}}}\n\n',
  ]
  const requests = []
  const client = createGugoClient({
    baseUrl: 'https://gugo.example',
    token: 'stream-token',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  const events = []
  const activities = []
  const terminal = await client.streamTurnEvents({
    sessionId: 'session-1', turnId: 'turn-1',
    onEvent: (event) => events.push(event.type),
    onActivity: (activity) => activities.push(activity.kind),
  })
  assert.equal(terminal.type, 'turn.completed')
  assert.deepEqual(events, ['turn.started', 'turn.completed'])
  assert.deepEqual(activities, ['model_working'])
  const url = new URL(requests[0].url)
  assert.equal(url.pathname, '/api/turns/stream')
  assert.equal(url.searchParams.get('turnEventVersion'), '1')
  assert.equal(requests[0].init.headers.Accept, 'text/event-stream')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer stream-token')
})

test('public SDK fails closed on event gaps, invalid inputs, and stable HTTP errors', async () => {
  const gapClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    fetchImpl: async () => json({ events: [{ sequence: 1, type: 'turn.completed', payload: {} }] }),
  })
  await assert.rejects(
    gapClient.waitForTerminal({
      sessionId: 'session-1', turnId: 'turn-1', pollIntervalMs: 10, timeoutMs: 1_000,
    }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_EVENT_SEQUENCE_INVALID',
  )
  assert.throws(() => createGugoClient({ baseUrl: 'file:///tmp/gugo' }), {
    code: 'GUGO_SDK_INPUT_INVALID',
  })
  assert.throws(() => createGugoClient({ baseUrl: 'https://user:secret@gugo.example' }), {
    code: 'GUGO_SDK_INPUT_INVALID',
  })
  await assert.rejects(
    gapClient.startTurn({ sessionId: '', content: 'invalid' }),
    { code: 'GUGO_SDK_INPUT_INVALID' },
  )

  const denied = createGugoClient({
    baseUrl: 'https://gugo.example',
    fetchImpl: async () => json({
      error: { code: 'SESSION_NOT_FOUND', message: 'session not found' },
    }, 404),
  })
  await assert.rejects(
    denied.getTurn({ sessionId: 'hidden', turnId: 'turn-hidden' }),
    (error) => error instanceof GugoSdkError
      && error.code === 'SESSION_NOT_FOUND'
      && error.status === 404
      && error.message === 'session not found',
  )
})

test('public SDK bounds request duration and JSON response bytes', async () => {
  const timeoutClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    requestTimeoutMs: 100,
    fetchImpl: async () => new Promise(() => {}),
  })
  await assert.rejects(
    timeoutClient.startTurn({ sessionId: 'session-1', content: 'timeout' }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_REQUEST_TIMEOUT',
  )

  const waitClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    requestTimeoutMs: 5_000,
    fetchImpl: async () => new Promise(() => {}),
  })
  const waitStartedAt = Date.now()
  await assert.rejects(
    waitClient.waitForTerminal({
      sessionId: 'session-1', turnId: 'turn-1', pollIntervalMs: 60_000, timeoutMs: 1_000,
    }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_TIMEOUT',
  )
  assert.ok(Date.now() - waitStartedAt < 2_500)

  const oversizedClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    fetchImpl: async () => new Response('{}', {
      headers: { 'Content-Length': String((8 * 1024 * 1024) + 1) },
    }),
  })
  await assert.rejects(
    oversizedClient.startTurn({ sessionId: 'session-1', content: 'oversized' }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_RESPONSE_INVALID',
  )
})

test('public SDK rejects malformed SSE activity and Turn envelopes', async () => {
  const streamResponse = (frame) => new Response(frame, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
  const activityClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    fetchImpl: async () => streamResponse('event: turn_activity\ndata: "not-an-object"\n\n'),
  })
  await assert.rejects(
    activityClient.streamTurnEvents({ sessionId: 'session-1', turnId: 'turn-1' }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_RESPONSE_INVALID',
  )

  const envelopeClient = createGugoClient({
    baseUrl: 'https://gugo.example',
    fetchImpl: async () => streamResponse('event: turn_event\ndata: {"v":1,"type":"turn.event","event":null}\n\n'),
  })
  await assert.rejects(
    envelopeClient.streamTurnEvents({ sessionId: 'session-1', turnId: 'turn-1' }),
    (error) => error instanceof GugoSdkError && error.code === 'GUGO_SDK_RESPONSE_INVALID',
  )
})

test('public SDK package surface has no application-server or internal-service dependency', () => {
  const source = fs.readFileSync(new URL('../sdk/index.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.doesNotMatch(source, /server\/|src\/|\.\.\//u)
  assert.equal(pkg.exports['./sdk'], './sdk/index.js')
})
