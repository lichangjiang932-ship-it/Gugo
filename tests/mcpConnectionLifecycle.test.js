import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mcp-lifecycle-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.MCP_STDIO_ENABLED = '1'
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath.replace(/\.exe$/i, '')

const fakeServerSource = String.raw`
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id == null) return
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lifecycle-test', version: '1.0.0' },
    })
  } else if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] })
  } else if (message.method === 'resources/list') {
    send(message.id, { resources: [] })
  } else if (message.method === 'prompts/list') {
    send(message.id, { prompts: [] })
  } else if (message.method === 'tools/call') {
    send(message.id, { content: [{ type: 'text', text: 'pong' }] })
  } else {
    send(message.id, {})
  }
})
lines.on('close', () => process.exit(0))
`

const { closeDb, createSession, createUser, getSessionByToken } = await import('../server/db.js')
const { handleAuthAccountRequest } = await import('../server/adapters/authAccount.js')
const {
  callTool,
  ensureServerConnected,
  getMcpConnectionState,
  getUserCatalog,
  shutdownAll,
  sweepIdleConnections,
} = await import('../server/mcp/mcpManager.js')
const { upsertServer } = await import('../server/mcp/mcpStore.js')
const { getDynamicTool } = await import('../server/services/toolRegistry.js')

function addServer(userId, id, name) {
  return upsertServer({
    id,
    userId,
    name,
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', fakeServerSource],
    env: {},
    enabled: true,
  })
}

function request(url, token) {
  return {
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function response() {
  return {
    statusCode: 200,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode },
    end(chunk = '') { this.body += chunk },
  }
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

test.after(() => {
  shutdownAll()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('idle sweep closes expired MCP connections and unregisters their tools', async () => {
  createUser({ id: 'mcp-idle-user', email: 'mcp-idle@example.com' })
  const server = addServer('mcp-idle-user', 'mcp-idle-server', 'Idle Server')
  await ensureServerConnected('mcp-idle-user', server)

  assert.equal(getUserCatalog('mcp-idle-user')[0].connected, true)
  assert.ok(getDynamicTool('mcp__Idle_Server__ping', { userId: 'mcp-idle-user' }))

  assert.equal(sweepIdleConnections({ now: Date.now() + 10_000, timeoutMs: 1 }), 1)
  assert.equal(getUserCatalog('mcp-idle-user')[0].connected, false)
  assert.equal(getDynamicTool('mcp__Idle_Server__ping', { userId: 'mcp-idle-user' }), null)
})

test('logout disconnects only the current user MCP connections', async () => {
  createUser({ id: 'mcp-logout-user', email: 'mcp-logout@example.com' })
  createUser({ id: 'mcp-other-user', email: 'mcp-other@example.com' })
  createSession({ token: 'mcp-logout-token', userId: 'mcp-logout-user' })
  const ownServer = addServer('mcp-logout-user', 'mcp-logout-server', 'Logout Server')
  const otherServer = addServer('mcp-other-user', 'mcp-other-server', 'Other Server')
  await ensureServerConnected('mcp-logout-user', ownServer)
  await ensureServerConnected('mcp-other-user', otherServer)

  const res = response()
  await handleAuthAccountRequest(request('/api/auth/logout', 'mcp-logout-token'), res)

  assert.equal(res.statusCode, 200)
  assert.equal(getSessionByToken('mcp-logout-token'), null)
  assert.equal(getUserCatalog('mcp-logout-user')[0].connected, false)
  assert.equal(getUserCatalog('mcp-other-user')[0].connected, true)
  assert.equal(getDynamicTool('mcp__Logout_Server__ping', { userId: 'mcp-logout-user' }), null)
  assert.ok(getDynamicTool('mcp__Other_Server__ping', { userId: 'mcp-other-user' }))
})

test('M1: concurrent ensureServerConnected calls share a single connection', async () => {
  createUser({ id: 'mcp-inflight-user', email: 'mcp-inflight@example.com' })
  const server = addServer('mcp-inflight-user', 'mcp-inflight-server', 'Inflight Server')

  // 并发 miss：两个调用同时触发，必须共享同一次 startConnection，不能 spawn 两个进程
  const [a, b] = await Promise.all([
    ensureServerConnected('mcp-inflight-user', server),
    ensureServerConnected('mcp-inflight-user', server),
  ])

  assert.equal(a, b, '并发调用应返回同一个 connection 实例')
  assert.equal(getUserCatalog('mcp-inflight-user')[0].connected, true)
  assert.ok(getDynamicTool('mcp__Inflight_Server__ping', { userId: 'mcp-inflight-user' }))
})

test('K1: an explicit ensure manually reconnects a failed server', async () => {
  createUser({ id: 'mcp-manual-user', email: 'mcp-manual@example.com' })
  const server = addServer('mcp-manual-user', 'mcp-manual-server', 'Manual Server')
  server.args = ['-e', 'process.exit(1)']

  await assert.rejects(ensureServerConnected('mcp-manual-user', server), /initialize failed/i)
  assert.equal(getMcpConnectionState('mcp-manual-user', server.id)?.status, 'failed')

  server.args = ['-e', fakeServerSource]
  const connection = await ensureServerConnected('mcp-manual-user', server)
  assert.ok(connection.transport.isAlive())
  assert.equal(getMcpConnectionState('mcp-manual-user', server.id)?.status, 'connected')
})

test('K1: killed stdio transport keeps tools visible, returns retryable, and reconnects automatically', async () => {
  createUser({ id: 'mcp-recovery-user', email: 'mcp-recovery@example.com' })
  const server = addServer('mcp-recovery-user', 'mcp-recovery-server', 'Recovery Server')
  const first = await ensureServerConnected('mcp-recovery-user', server)
  const firstPid = first.transport.child?.pid

  first.transport.child?.kill()
  await waitFor(() => getMcpConnectionState('mcp-recovery-user', server.id)?.status === 'reconnecting')

  assert.ok(
    getDynamicTool('mcp__Recovery_Server__ping', { userId: 'mcp-recovery-user' }),
    'tool registration must remain visible during backoff',
  )
  await assert.rejects(
    callTool({
      userId: 'mcp-recovery-user',
      fullToolName: 'mcp__Recovery_Server__ping',
      args: {},
    }),
    (error) => error.code === 'mcp_connection_recovering'
      && error.reason === 'mcp_connection_recovering'
      && error.retryable === true,
  )

  await waitFor(() => getMcpConnectionState('mcp-recovery-user', server.id)?.status === 'connected')
  const recovered = await ensureServerConnected('mcp-recovery-user', server)
  assert.notEqual(recovered.transport.child?.pid, firstPid)
  assert.deepEqual(
    await callTool({
      userId: 'mcp-recovery-user',
      fullToolName: 'mcp__Recovery_Server__ping',
      args: {},
    }),
    { content: [{ type: 'text', text: 'pong' }] },
  )
})
