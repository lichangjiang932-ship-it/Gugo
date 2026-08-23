import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { SseTransport } from '../server/mcp/mcpTransportSse.js'

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}/mcp`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('production Streamable HTTP allows loopback but rejects insecure remote URLs', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.doesNotThrow(() => new SseTransport({ url: 'http://127.0.0.1:3000/mcp' }))
    assert.doesNotThrow(() => new SseTransport({ url: 'http://localhost:3000/mcp' }))
    assert.throws(() => new SseTransport({ url: 'http://example.com/mcp' }), /https/)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('Streamable HTTP carries custom/session headers across requests and notifications', async () => {
  const calls = []
  await withServer(async (req, res) => {
    const message = await readBody(req)
    calls.push({ message, headers: req.headers })
    res.setHeader('MCP-Session-Id', 'session-123')
    if (message.id === undefined) {
      res.writeHead(202)
      return res.end()
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }))
  }, async (url) => {
    const transport = new SseTransport({ url, headers: { Authorization: 'Bearer test-key' } })
    assert.deepEqual(await transport.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }), { ok: true })
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  assert.equal(calls[0].headers.authorization, 'Bearer test-key')
  assert.equal(calls[0].headers['mcp-protocol-version'], '2025-03-26')
  assert.equal(calls[1].headers['mcp-session-id'], 'session-123')
})

test('Streamable HTTP parses SSE results and emits server notifications', async () => {
  await withServer(async (req, res) => {
    const message = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end([
      'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      '',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}`,
      '',
      '',
    ].join('\n'))
  }, async (url) => {
    const notifications = []
    const transport = new SseTransport({ url })
    transport.onNotification((message) => notifications.push(message.method))
    const result = await transport.request({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    assert.deepEqual(result, { tools: [] })
    assert.deepEqual(notifications, ['notifications/tools/list_changed'])
  })
})

test('notification HTTP errors reach transport error handlers', async () => {
  await withServer(async (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('bad token')
  }, async (url) => {
    const errors = []
    const transport = new SseTransport({ url })
    transport.onError((error) => errors.push(error.message))
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.match(errors[0], /MCP HTTP 401: bad token/)
  })
})

test('request transport failures emit lifecycle errors but JSON-RPC errors do not', async () => {
  await withServer(async (req, res) => {
    const message = await readBody(req)
    if (message.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'invalid tool arguments' },
      }))
    }
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    return res.end('temporarily unavailable')
  }, async (url) => {
    const errors = []
    const transport = new SseTransport({ url })
    transport.onError((error) => errors.push(error.message))

    await assert.rejects(
      transport.request({ jsonrpc: '2.0', id: 10, method: 'tools/call' }),
      /invalid tool arguments/,
    )
    assert.deepEqual(errors, [], 'tool-level JSON-RPC failures must not trigger reconnect')

    await assert.rejects(
      transport.request({ jsonrpc: '2.0', id: 11, method: 'health/check' }),
      /MCP HTTP 503/,
    )
    assert.deepEqual(errors, ['MCP HTTP 503: temporarily unavailable'])
  })
})

test('Streamable HTTP request observes an explicit cancellation signal', async () => {
  await withServer(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    res.end('{}')
  }, async (url) => {
    const controller = new AbortController()
    const reason = Object.assign(new Error('user stopped'), { name: 'AbortError', code: 'TURN_CANCEL_REQUESTED' })
    const transport = new SseTransport({ url })
    const pending = transport.request({ jsonrpc: '2.0', id: 9, method: 'tools/call' }, { signal: controller.signal })
    controller.abort(reason)
    await assert.rejects(pending, (error) => error === reason)
  })
})

function jsonRpcSuccessFetch(calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init })
    const message = JSON.parse(init.body || '{}')
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { ok: true },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

test('MCP request rejects metadata and link-local DNS answers before fetch', async () => {
  const deniedAddresses = [
    { address: '169.254.169.254', family: 4 },
    { address: '100.100.100.200', family: 4 },
    { address: 'fd00:ec2::254', family: 6 },
  ]

  for (const record of deniedAddresses) {
    let fetchCalls = 0
    const transport = new SseTransport({
      url: 'https://mcp.example.test/rpc',
      lookup: async () => [record],
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('fetch must not run for a forbidden DNS answer')
      },
    })

    await assert.rejects(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
    )
    assert.equal(fetchCalls, 0, `${record.address} must be denied before fetch`)
  }
})

test('MCP request and notification both pass through the outbound guard', async () => {
  let fetchCalls = 0
  const errors = []
  const transport = new SseTransport({
    url: 'https://guarded.example.test/rpc',
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('fetch must not run for a forbidden DNS answer')
    },
  })
  transport.onError((error) => errors.push(error))

  await assert.rejects(
    transport.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  assert.equal(fetchCalls, 0)
  assert.deepEqual(errors.map((error) => error.code), [
    'OUTBOUND_ADDRESS_DENIED',
    'OUTBOUND_ADDRESS_DENIED',
  ])
})

test('MCP permits only literal loopback hosts to opt into local addresses', async () => {
  const calls = []
  const fetchImpl = jsonRpcSuccessFetch(calls)
  const lookup = async (hostname) => [{
    address: hostname === 'localhost' ? '127.0.0.1' : '203.0.113.10',
    family: 4,
  }]

  for (const [index, url] of [
    'http://localhost:3456/mcp',
    'http://127.0.0.1:3456/mcp',
    'http://[::1]:3456/mcp',
  ].entries()) {
    const transport = new SseTransport({ url, lookup, fetchImpl })
    const result = await transport.request({
      jsonrpc: '2.0',
      id: index + 10,
      method: 'tools/list',
    })
    assert.deepEqual(result, { ok: true })
  }
  assert.equal(calls.length, 3)

  let aliasFetchCalls = 0
  const aliasedTransport = new SseTransport({
    url: 'https://loopback-alias.example.test/mcp',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => {
      aliasFetchCalls += 1
      throw new Error('fetch must not run for an aliased loopback address')
    },
  })
  await assert.rejects(
    aliasedTransport.request({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(aliasFetchCalls, 0)

  let privateFetchCalls = 0
  const poisonedLocalhost = new SseTransport({
    url: 'http://localhost:3456/mcp',
    lookup: async () => [{ address: '192.168.1.20', family: 4 }],
    fetchImpl: async () => {
      privateFetchCalls += 1
      throw new Error('fetch must not run when localhost resolves outside loopback')
    },
  })
  await assert.rejects(
    poisonedLocalhost.request({ jsonrpc: '2.0', id: 21, method: 'tools/list' }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(privateFetchCalls, 0)
})

test('custom MCP fetch remains usable in offline tests without DNS access', async () => {
  const calls = []
  const transport = new SseTransport({
    url: 'https://offline.invalid/mcp',
    fetchImpl: jsonRpcSuccessFetch(calls),
  })

  assert.deepEqual(
    await transport.request({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
    { ok: true },
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://offline.invalid/mcp')
})
