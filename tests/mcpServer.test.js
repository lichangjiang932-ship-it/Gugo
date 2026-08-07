import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mcp-server-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const { closeDb, createUser } = await import('../server/db.js')
const { createMobileKey } = await import('../server/services/mobileAccessKeyStore.js')
const { upsertIntegration } = await import('../server/services/integrationsStore.js')
const { handleMcpServerRequest, MCP_SERVER_TOOLS } = await import('../server/mcp/mcpServer.js')

createUser({ id: 'u-mcp-server', email: 'mcp-server@example.com' })
const { rawKey } = createMobileKey({ userId: 'u-mcp-server', label: 'MCP test' })
const server = http.createServer((req, res) => handleMcpServerRequest(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('streamable HTTP MCP server requires a bearer token', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(response.status, 401)
  assert.match(response.headers.get('www-authenticate'), /Bearer/)
})

test('streamable HTTP MCP server initializes and lists tools with an access key', async () => {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` }
  const initialized = await fetch(baseUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  })
  assert.equal(initialized.status, 200)
  const initBody = await initialized.json()
  assert.equal(initBody.result.serverInfo.name, 'Gugo')
  assert.equal(initBody.result.serverInfo.version, packageVersion)
  assert.equal(initBody.result.protocolVersion, '2025-03-26')

  const listed = await fetch(baseUrl, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const listBody = await listed.json()
  assert.equal(listBody.result.tools.length, MCP_SERVER_TOOLS.length)
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'yma_chat'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'browser_snapshot'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'browser_console'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'connected_app_list'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'connected_app_open'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'notion_search'))
  assert.ok(listBody.result.tools.some((tool) => tool.name === 'github_get_file'))
})

test('streamable HTTP MCP server returns the enabled connected app list', async () => {
  upsertIntegration({ userId: 'u-mcp-server', provider: 'web_gmail', enabled: true })
  upsertIntegration({ userId: 'u-mcp-server', provider: 'web_jira', enabled: false })
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connected_app_list', arguments: {} } }),
  })
  const body = await response.json()
  assert.equal(body.result.isError, undefined)
  assert.deepEqual(body.result.structuredContent.map((app) => app.provider), ['web_gmail'])
})

test('MCP browser open cannot bypass an unconnected managed app', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_open_url', arguments: { url: 'https://linear.app/' } } }),
  })
  const body = await response.json()
  assert.equal(body.result.isError, true)
  assert.match(body.result.content[0].text, /not connected/i)
})
