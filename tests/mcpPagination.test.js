import assert from 'node:assert/strict'
import test from 'node:test'
import { startMcpConnection } from '../server/mcp/mcpConnectionBootstrap.js'
import { StdioTransport } from '../server/mcp/mcpTransportStdio.js'
import { SseTransport } from '../server/mcp/mcpTransportSse.js'
import { buildInitializeRequest, buildInitializedNotification, buildToolsListRequest, readMcpList } from '../server/mcp/mcpJsonRpc.js'

async function bootstrap(t, respond) {
  const calls = []
  let stopped = false
  let disposed = false
  t.mock.method(StdioTransport.prototype, 'start', () => {})
  t.mock.method(StdioTransport.prototype, 'stop', async () => { stopped = true })
  t.mock.method(StdioTransport.prototype, 'send', async () => {})
  t.mock.method(StdioTransport.prototype, 'request', async (message, options) => {
    calls.push({ message, options })
    if (message.method === 'initialize') return { protocolVersion: '2024-11-05' }
    return respond(message)
  })
  const pending = startMcpConnection('pagination-user', {
    name: 'Pagination', transport: 'stdio', command: 'node',
  }, { attachCatalogRefresh: () => () => { disposed = true } })
  return { pending, calls, stopped: () => stopped, disposed: () => disposed }
}

const catalog = (kind, suffix) => kind === 'resources'
  ? { name: suffix, uri: `test:///${suffix}` }
  : { name: suffix, ...(kind === 'tools' ? { inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } } : {}) }

for (const kind of ['tools', 'resources', 'prompts']) {
  test(`bootstrap completes ${kind} cursor pagination including empty intermediate pages`, async (t) => {
    const opaque = ' cursor/+?= '
    const fixture = await bootstrap(t, (message) => {
      const key = message.method.split('/')[0]
      if (key !== kind) return { [key]: [] }
      if (message.params.cursor === undefined) return { [key]: [catalog(key, 'first')], nextCursor: opaque }
      if (message.params.cursor === opaque) return { [key]: [], nextCursor: '' }
      assert.equal(message.params.cursor, '')
      return { [key]: [catalog(key, 'last')] }
    })
    const connection = await fixture.pending
    assert.deepEqual(connection[kind], [catalog(kind, 'first'), catalog(kind, 'last')])
    const calls = fixture.calls.filter(({ message }) => message.method === `${kind}/list`)
    assert.deepEqual(calls.map(({ message }) => message.params), [{}, { cursor: opaque }, { cursor: '' }])
    assert.equal(new Set(calls.map(({ message }) => message.id)).size, 3)
  })

  for (const failure of ['cycle', 'limit', 'invalid cursor', 'invalid page', 'late RPC error']) {
    test(`bootstrap rejects ${kind} ${failure} without installing partial catalogs`, async (t) => {
      let pages = 0
      const fixture = await bootstrap(t, (message) => {
        const key = message.method.split('/')[0]
        if (key !== kind) return { [key]: [] }
        pages += 1
        if (pages === 1) return { [key]: [catalog(key, 'partial')], nextCursor: 'next' }
        if (failure === 'late RPC error') throw new Error('Method not found')
        if (failure === 'invalid page') return { nextCursor: 'more' }
        return { [key]: [], nextCursor: failure === 'cycle' ? 'next' : failure === 'invalid cursor' ? 7 : `page-${pages}` }
      })
      await assert.rejects(fixture.pending, /MCP .*list.*(cycle|limit|invalid|failed)/i)
      assert.equal(fixture.stopped(), true)
      assert.equal(fixture.disposed(), true)
      assert.ok(pages <= 100)
    })
  }
}

test('pagination enforces the item limit without returning a partial result', async () => {
  let requests = 0
  const transport = { request: async () => {
    requests += 1
    return { tools: Array(5001).fill(catalog('tools', 'item')), nextCursor: 'next' }
  } }
  await assert.rejects(readMcpList(transport, buildToolsListRequest, 'tools'), /item limit/)
  assert.equal(requests, 2)
})

test('pagination preserves cancellation and never requests another page after abort', async () => {
  const controller = new AbortController()
  const reason = new Error('cancelled')
  let requests = 0
  const transport = { request: async (_message, options) => {
    requests += 1
    assert.equal(options.signal, controller.signal)
    controller.abort(reason)
    return { tools: [], nextCursor: 'next' }
  } }
  await assert.rejects(readMcpList(transport, buildToolsListRequest, 'tools', { signal: controller.signal }), (error) => error === reason)
  assert.equal(requests, 1)
})

test('pagination shares a total deadline across pages', async (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const timeouts = []
  const transport = { request: async (_message, options) => {
    timeouts.push(options.timeoutMs)
    now += 6
    return { tools: [], nextCursor: `page-${now}` }
  } }
  await assert.rejects(readMcpList(transport, buildToolsListRequest, 'tools', { timeoutMs: 10 }), /time limit/)
  assert.deepEqual(timeouts, [10, 4])
})

test('bootstrap rejects arbitrary initial list failures', async (t) => {
  const fixture = await bootstrap(t, () => { throw new Error('temporarily unavailable') })
  await assert.rejects(fixture.pending, /list pagination request failed/)
  assert.equal(fixture.stopped(), true)
})

test('bootstrap tolerates initial unsupported list methods', async (t) => {
  const fixture = await bootstrap(t, () => { throw Object.assign(new Error('Method not found'), { code: -32601 }) })
  const connection = await fixture.pending
  assert.deepEqual([connection.tools, connection.resources, connection.prompts], [[], [], []])
})

for (const responseType of ['application/json', 'text/event-stream']) {
  test(`HTTP ${responseType} uses negotiated protocol on subsequent requests and notifications`, async () => {
    const calls = []
    const transport = new SseTransport({
      url: 'https://mcp.example.test/rpc',
      headers: { Authorization: 'Bearer fixture' },
      fetchImpl: async (_url, init) => {
        const message = JSON.parse(init.body)
        calls.push({ message, headers: new Headers(init.headers) })
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } })
        return new Response(responseType === 'text/event-stream' ? `data: ${body}\n\n` : body, {
          headers: { 'Content-Type': responseType, 'MCP-Session-Id': 'fixture-session' },
        })
      },
    })
    const initialize = buildInitializeRequest()
    await transport.request(initialize)
    await transport.send(buildInitializedNotification())
    await transport.request({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} })
    assert.equal(calls[0].headers.get('mcp-protocol-version'), initialize.params.protocolVersion)
    for (const call of calls.slice(1)) {
      assert.equal(call.headers.get('mcp-protocol-version'), '2025-03-26')
      assert.equal(call.headers.get('mcp-session-id'), 'fixture-session')
      assert.equal(call.headers.get('authorization'), 'Bearer fixture')
    }
    transport.stop()
  })
}
