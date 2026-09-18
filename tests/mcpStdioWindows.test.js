import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { StdioTransport } from '../server/mcp/mcpTransportStdio.js'
import { startMcpConnection } from '../server/mcp/mcpConnectionBootstrap.js'

function childStub() {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  return child
}

function notification(transport, method) {
  return new Promise((resolve) => {
    const dispose = transport.onNotification((message) => {
      if (message.method !== method) return
      dispose()
      resolve(message)
    })
  })
}

test('bare node starts a real local stdio MCP without interpreting metacharacters', { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gugo MCP 中文 &%-'))
  const fixture = path.join(directory, 'server 中文 &%.cjs')
  copyFileSync(fileURLToPath(new URL('./fixtures/mcpStdioFixture.cjs', import.meta.url)), fixture)
  const literals = ['a&b', 'x|y', '%PATH%', '^caret', 'quote"here', '中文 空格']
  const transport = new StdioTransport({ command: 'node', args: [fixture, ...literals], cwd: directory, label: 'literal-fixture' })
  t.after(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }) })
  transport.start()
  const initialized = await transport.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(initialized.serverInfo.name, 'isolated-stdio')
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const listed = await transport.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['echo', 'wait'])
  const echo = await transport.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: '& | % ^ 中文' } } })
  assert.deepEqual(JSON.parse(echo.content[0].text), { argv: literals, cwd: directory, arguments: { value: '& | % ^ 中文' } })
  const waiting = notification(transport, 'fixture/waiting')
  const cancelled = notification(transport, 'fixture/cancelled')
  const controller = new AbortController()
  const pending = transport.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wait' } }, { signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await waiting
  controller.abort()
  await rejected
  assert.equal((await cancelled).params.removed, true)
  assert.equal(transport.pending.size, 0)
  const exited = new Promise((resolve) => transport.onExit(resolve))
  await transport.request({ jsonrpc: '2.0', id: 5, method: 'fixture/exit' })
  assert.equal((await exited).code, 0)
  assert.deepEqual(readdirSync(directory), [path.basename(fixture)])
})

test('injected platform controls command mapping and preserves shell:false', () => {
  const child = childStub()
  let spawned
  const transport = new StdioTransport({ command: 'node', args: ['a&b'] }, {
    platform: 'linux',
    spawnFn: (...args) => { spawned = args; return child },
  })
  transport.start()
  assert.equal(spawned[0], 'node')
  assert.deepEqual(spawned[1], ['a&b'])
  assert.equal(spawned[2].shell, false)
  assert.equal(spawned[2].windowsHide, true)
})

test('synchronous and asynchronous spawn failures become closed diagnostic transports', async () => {
  const sync = new StdioTransport({ command: 'node' }, {
    platform: 'linux', spawnFn: () => { throw Object.assign(new Error('hidden arguments'), { code: 'EINVAL' }) },
  })
  const errors = []
  sync.onError((error) => errors.push(error))
  assert.throws(() => sync.start(), { code: 'MCP_STDIO_START_FAILED', systemCode: 'EINVAL' })
  assert.equal(sync.closed, true)
  assert.equal(errors.length, 1)
  assert.doesNotMatch(errors[0].message, /hidden arguments/u)
  await assert.rejects(sync.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }), { code: 'MCP_STDIO_START_FAILED' })
  assert.equal(sync.pending.size, 0)

  const child = childStub()
  const asyncTransport = new StdioTransport({ command: 'missing' }, { platform: 'linux', spawnFn: () => child })
  const closes = []
  asyncTransport.onClose((event) => closes.push(event))
  asyncTransport.start()
  const pending = asyncTransport.request({ jsonrpc: '2.0', id: 2, method: 'initialize' })
  const rejected = assert.rejects(pending, { code: 'MCP_STDIO_START_FAILED', systemCode: 'ENOENT' })
  child.emit('error', Object.assign(new Error('secret-cmd'), { code: 'ENOENT' }))
  child.emit('close', -4058, null)
  await rejected
  assert.equal(asyncTransport.isAlive(), false)
  assert.equal(closes.length, 1)
  assert.equal(closes[0].reason.code, 'MCP_STDIO_START_FAILED')
})

test('bootstrap preserves the allowlist and propagates asynchronous startup diagnostics', { timeout: 10000 }, async (t) => {
  const keys = ['MCP_STDIO_ALLOWED_COMMANDS', 'MCP_STDIO_ENABLED', 'GUGO_PURE_LOCAL_MODE']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.MCP_STDIO_ALLOWED_COMMANDS = 'node'
  process.env.MCP_STDIO_ENABLED = '1'
  delete process.env.GUGO_PURE_LOCAL_MODE
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  })
  await assert.rejects(startMcpConnection('local-test', { id: 'denied', name: 'denied', transport: 'stdio', command: process.execPath }), /白名单/u)
  await assert.rejects(startMcpConnection('local-test', { id: 'shell', name: 'shell', transport: 'stdio', command: 'cmd.exe' }), /白名单/u)
  const directory = mkdtempSync(path.join(tmpdir(), 'gugo-mcp-invalid-cwd-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let disposed = false
  await assert.rejects(startMcpConnection('local-test', {
    id: 'invalid-cwd', name: 'invalid cwd', transport: 'stdio', command: 'node',
    cwd: path.join(directory, 'does-not-exist'), args: ['--version'],
  }, { attachCatalogRefresh: () => () => { disposed = true } }), {
    code: 'MCP_STDIO_START_FAILED', systemCode: 'ENOENT', retryable: false,
  })
  assert.equal(disposed, true)
})

test('stdio pipe failures reject pending requests rather than becoming uncaught stream errors', async () => {
  const child = childStub()
  const transport = new StdioTransport({ command: 'node' }, { platform: 'linux', spawnFn: () => child })
  const errors = []
  transport.onError((error) => errors.push(error))
  transport.start()
  child.emit('spawn')
  const pending = transport.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' })
  const rejected = assert.rejects(pending, { code: 'MCP_STDIO_IO_FAILED', systemCode: 'EPIPE' })
  child.stdin.emit('error', Object.assign(new Error('sensitive pipe details'), { code: 'EPIPE' }))
  await rejected
  assert.equal(transport.pending.size, 0)
  assert.equal(errors.length, 1)
  assert.doesNotMatch(errors[0].message, /sensitive pipe details/u)
  child.emit('close', 1, null)
})
