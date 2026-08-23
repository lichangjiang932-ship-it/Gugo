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

test('stdio MCP inherits only its explicitly configured credentials and blocks startup injection', async () => {
  const hostSecretKey = 'GUGO_MCP_HOST_TOKEN'
  const previousHostSecret = process.env[hostSecretKey]
  process.env[hostSecretKey] = 'host-secret-must-not-leak'
  const serverSource = String.raw`
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
lines.once('line', (line) => {
  const message = JSON.parse(line)
  const result = {
    hostSecret: process.env.GUGO_MCP_HOST_TOKEN || null,
    configuredSecret: process.env.GITHUB_TOKEN || null,
    safeFlag: process.env.MCP_SAFE_FLAG || null,
    nodeOptions: process.env.NODE_OPTIONS || null,
    loaderHook: process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES || null,
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n', () => process.exit(0))
})
`
  const transport = new StdioTransport({
    command: process.execPath,
    args: ['-e', serverSource],
    env: {
      GITHUB_TOKEN: 'mcp-configured-secret',
      MCP_SAFE_FLAG: 'configured',
      NODE_OPTIONS: '--definitely-invalid-gugo-option',
      LD_PRELOAD: '/tmp/gugo-attacker.so',
      DYLD_INSERT_LIBRARIES: '/tmp/gugo-attacker.dylib',
    },
    label: 'env-boundary-test',
  })
  const exited = new Promise((resolve) => {
    transport.onExit(resolve)
    transport.onClose(resolve)
  })
  let exitTimer = null

  try {
    transport.start()
    const result = await transport.request(
      { jsonrpc: '2.0', id: 41, method: 'env/read' },
      { timeoutMs: 5_000 },
    )
    assert.deepEqual(result, {
      hostSecret: null,
      configuredSecret: 'mcp-configured-secret',
      safeFlag: 'configured',
      nodeOptions: null,
      loaderHook: null,
    })
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('MCP env test child did not exit')), 5_000)
      }),
    ])
  } finally {
    if (exitTimer) clearTimeout(exitTimer)
    if (transport.isAlive()) transport.stop()
    if (previousHostSecret == null) delete process.env[hostSecretKey]
    else process.env[hostSecretKey] = previousHostSecret
  }
})
