import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-mcp-catalog-notifications-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.MCP_STDIO_ENABLED = '1'
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath.replace(/\.exe$/i, '')

const fakeServerSource = String.raw`
const readline = require('node:readline')
let revision = 0
let lists = 0
let failNext = false
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const notify = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n')
const tool = (name, description = name) => ({ name, description, inputSchema: { type: 'object', properties: {} } })
const catalog = () => [tool('control'), tool('keep'), tool('changing', 'revision-' + revision), tool(revision ? 'added' : 'removed')]
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id == null) return
  if (request.method === 'initialize') send(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true } } })
  else if (request.method === 'tools/list') {
    lists += 1
    if (failNext) {
      failNext = false
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'catalog temporarily unavailable' } }) + '\n')
    } else {
      send(request.id, { tools: catalog() })
      if (lists === 1 && process.env.STARTUP_CATALOG_CHANGE === '1') { revision = 1; notify() }
    }
  } else if (request.method === 'resources/list') send(request.id, { resources: [] })
  else if (request.method === 'prompts/list') send(request.id, { prompts: [] })
  else if (request.method === 'tools/call') {
    const args = request.params.arguments || {}
    if (args.action === 'change') { revision += 1; failNext = args.fail === true }
    if (args.action === 'change' || args.action === 'retry') for (let i = 0; i < (args.burst || 1); i += 1) notify()
    send(request.id, { content: [{ type: 'text', text: JSON.stringify({ revision, lists }) }] })
  }
})
lines.on('close', () => process.exit(0))
`

const { closeDb, createUser } = await import('../server/db.js')
const { upsertServer } = await import('../server/mcp/mcpStore.js')
const { getDynamicToolSpecRegistrationId } = await import('../server/services/toolRegistry.js')
const { callTool, disconnectServer, ensureServerConnected, getUserCatalog, listUserToolSpecs, shutdownAll } = await import('../server/mcp/mcpManager.js')
const userId = 'mcp-catalog-notifications-user'
createUser({ id: userId, email: 'mcp-catalog-notifications@example.test' })
let sequence = 0

function server(t, env = {}) {
  const id = 'catalog-server-' + (++sequence)
  const value = upsertServer({ id, userId, name: 'Catalog' + sequence, transport: 'stdio', command: process.execPath, args: ['-e', fakeServerSource], env, enabled: true })
  t.after(() => disconnectServer(userId, id))
  return value
}

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('MCP catalog did not update')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const named = (list, suffix) => list.find((spec) => spec.function.name.endsWith('__' + suffix))
const control = (s, args) => callTool({ userId, fullToolName: 'mcp__' + s.name + '__control', args })

test.after(async () => {
  await shutdownAll()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('live MCP notifications refresh add/remove/schema changes and preserve unchanged registration identity', async (t) => {
  const s = server(t)
  const connection = await ensureServerConnected(userId, s)
  assert.equal(connection.transport.notificationHandlers.size, 1)
  const before = (await listUserToolSpecs(userId, { connect: false })).specs
  const keepId = getDynamicToolSpecRegistrationId(named(before, 'keep'))
  const changedId = getDynamicToolSpecRegistrationId(named(before, 'changing'))
  await control(s, { action: 'change', burst: 50 })
  await until(async () => named((await listUserToolSpecs(userId, { connect: false })).specs, 'added'))
  const after = (await listUserToolSpecs(userId, { connect: false })).specs
  assert.equal(named(after, 'removed'), undefined)
  assert.equal(named(after, 'changing').function.description, 'revision-1')
  assert.equal(getDynamicToolSpecRegistrationId(named(after, 'keep')), keepId)
  assert.notEqual(getDynamicToolSpecRegistrationId(named(after, 'changing')), changedId)
  const stats = JSON.parse((await control(s, { action: 'stats' })).content[0].text)
  assert.equal(stats.lists, 2, 'the notification burst must become one refresh RPC')
  disconnectServer(userId, s.id)
  assert.equal(connection.transport.notificationHandlers.size, 0)
})

test('MCP catalog refresh errors remain visible while the last good schema stays usable', async (t) => {
  const s = server(t)
  await ensureServerConnected(userId, s)
  await control(s, { action: 'change', fail: true })
  await until(() => getUserCatalog(userId).find((row) => row.serverId === s.id)?.toolCatalogError)
  const failed = await listUserToolSpecs(userId, { connect: false })
  assert.ok(failed.errors.some((error) => error.serverId === s.id && error.code === 'MCP_TOOL_CATALOG_REFRESH_FAILED'))
  const own = failed.specs.filter((spec) => spec.function.name.startsWith('mcp__' + s.name + '__'))
  assert.ok(named(own, 'removed'))
  await control(s, { action: 'retry' })
  await until(() => getUserCatalog(userId).find((row) => row.serverId === s.id)?.toolCatalogError === null)
  const recovered = await listUserToolSpecs(userId, { connect: false })
  assert.equal(recovered.errors.some((error) => error.serverId === s.id), false)
})

test('catalog changes during the initial handshake survive until the connection is installed', async (t) => {
  const s = server(t, { STARTUP_CATALOG_CHANGE: '1' })
  await ensureServerConnected(userId, s)
  await until(async () => (await listUserToolSpecs(userId, { connect: false })).specs.some((spec) => (
    spec.function.name === 'mcp__' + s.name + '__added'
  )))
})
