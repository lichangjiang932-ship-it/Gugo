import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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

test('stdio MCP limits only the current NDJSON line instead of lifetime stdout', async () => {
  const notificationCount = 14_000
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { message: '中文🙂', progress: 1 },
  }) + '\n\n'
  assert.ok(Buffer.byteLength(notification) * notificationCount > 1024 * 1024)

  const serverSource = String.raw`
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
lines.once('line', (line) => {
  const message = JSON.parse(line)
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { message: '中文🙂', progress: 1 },
  }) + '\n\n'
  const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) + '\n'
  process.stdout.write(notification.repeat(14000) + response, () => process.exit(0))
})
`
  const transport = new StdioTransport({
    command: process.execPath,
    args: ['-e', serverSource],
    label: 'long-lived-stdout-test',
  })
  let receivedNotifications = 0
  const errors = []
  transport.onNotification(() => { receivedNotifications += 1 })
  transport.onError((error) => { errors.push(error) })

  try {
    transport.start()
    const result = await transport.request(
      { jsonrpc: '2.0', id: 73, method: 'long-lived/read' },
      { timeoutMs: 15_000 },
    )
    assert.deepEqual(result, { ok: true })
    assert.equal(receivedNotifications, notificationCount)
    assert.equal(errors.some((error) => /stdout.*1048576/u.test(error.message)), false)
    assert.ok(transport.bufferBytes < 1024 * 1024)
  } finally {
    if (transport.isAlive()) transport.stop()
  }
})

test('stdio MCP enforces the stdout limit in UTF-8 bytes on an unfinished line', () => {
  const transport = new StdioTransport({ command: 'unused', label: 'stdout-boundary-test' })
  let killCount = 0
  transport.child = {
    stdin: { end() {} },
    kill() { killCount += 1 },
  }
  const errors = []
  transport.onError((error) => { errors.push(error) })
  const exactBoundary = '中'.repeat(Math.floor((1024 * 1024) / 3)) + 'x'
  assert.equal(Buffer.byteLength(exactBoundary), 1024 * 1024)

  transport._handleStdout(exactBoundary)
  assert.equal(transport.closed, false)
  assert.equal(transport.bufferBytes, 1024 * 1024)

  transport._handleStdout('🙂')
  assert.equal(transport.closed, true)
  assert.equal(killCount, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /stdout.*1048576/u)
})

test('stdio MCP remeasures a UTF-8 tail after consuming multiple messages from one chunk', () => {
  const transport = new StdioTransport({ command: 'unused', label: 'multi-message-chunk-test' })
  const messages = []
  transport.onNotification((message) => messages.push(message))
  const first = JSON.stringify({ jsonrpc: '2.0', method: 'one', params: { text: '中文' } })
  const second = JSON.stringify({ jsonrpc: '2.0', method: 'two', params: { text: '🙂' } })
  const tail = '未完成🙂'

  transport._handleStdout(`${first}\n${second}\n${tail}`)

  assert.deepEqual(messages.map((message) => message.method), ['one', 'two'])
  assert.equal(transport.buffer, tail)
  assert.equal(transport.bufferBytes, Buffer.byteLength(tail, 'utf8'))
  assert.equal(transport.closed, false)
})

test('stdio MCP stop is idempotent, waits for exit, and cancels a stale Windows tree kill', async () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.stdin = { end() {} }
  let gracefulKillCalls = 0
  let treeKillCalls = 0
  child.kill = () => {
    gracefulKillCalls += 1
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    })
    return true
  }
  const transport = new StdioTransport(
    { command: 'unused', label: 'stop-cancel-test' },
    {
      platform: 'win32',
      forceKillDelayMs: 10,
      stopWaitMs: 100,
      terminateProcessTreeFn: async () => { treeKillCalls += 1; return true },
    },
  )
  transport.child = child

  const firstStop = transport.stop()
  const secondStop = transport.stop()
  assert.equal(firstStop, secondStop)
  assert.equal(await firstStop, true)
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(gracefulKillCalls, 1)
  assert.equal(treeKillCalls, 0)
  assert.equal(transport.forceKillTimer, null)
})

test('stdio MCP stop waits for the bounded Windows process-tree fallback', async () => {
  const child = new EventEmitter()
  child.pid = 4343
  child.exitCode = null
  child.signalCode = null
  child.stdin = { end() {} }
  child.kill = () => true
  let treeKillCalls = 0
  const transport = new StdioTransport(
    { command: 'unused', label: 'stop-tree-test' },
    {
      platform: 'win32',
      forceKillDelayMs: 5,
      stopWaitMs: 100,
      terminateProcessTreeFn: async ({ pid, child: target }) => {
        treeKillCalls += 1
        assert.equal(pid, child.pid)
        assert.equal(target, child)
        child.signalCode = 'SIGKILL'
        child.emit('exit', null, 'SIGKILL')
        return true
      },
    },
  )
  transport.child = child

  const keepEventLoopAlive = setTimeout(() => {}, 150)
  try {
    assert.equal(await transport.stop(), true)
    assert.equal(treeKillCalls, 1)
    assert.equal(transport.forceKillTimer, null)
  } finally {
    clearTimeout(keepEventLoopAlive)
  }
})
