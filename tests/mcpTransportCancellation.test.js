import assert from 'node:assert/strict'
import test from 'node:test'
import { StdioTransport } from '../server/mcp/mcpTransportStdio.js'

test('stdio MCP request rejects on cancellation and sends an advisory cancel notification', async () => {
  const sent = []
  const transport = new StdioTransport({ command: 'unused' })
  transport.child = {
    stdin: { write: (line, _encoding, callback) => { sent.push(JSON.parse(line)); callback() } },
  }
  const controller = new AbortController()
  const reason = Object.assign(new Error('user stopped'), { name: 'AbortError', code: 'TURN_CANCEL_REQUESTED' })
  const pending = transport.request({ jsonrpc: '2.0', id: 7, method: 'tools/call' }, { signal: controller.signal })
  controller.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(transport.pending.size, 0)
  assert.equal(sent.some((message) => message.method === 'notifications/cancelled' && message.params.requestId === 7), true)
})
