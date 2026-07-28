import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mcp-limit-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')
process.env.MCP_RATE_LIMIT_PER_MINUTE = '1'

const { closeDb, createUser } = await import('../server/db.js')
const { handleMcpServerRequest } = await import('../server/mcp/mcpServer.js')
const { createMobileKey } = await import('../server/services/mobileAccessKeyStore.js')

createUser({ id: 'u-mcp-limits', email: 'mcp-limits@example.com' })
const { rawKey } = createMobileKey({ userId: 'u-mcp-limits', label: 'limits test' })

const server = http.createServer((req, res) => handleMcpServerRequest(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/mcp`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('external MCP endpoint rate-limits repeated requests by source IP', async () => {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  }
  const first = await fetch(baseUrl, init)
  assert.equal(first.status, 401)
  assert.equal(first.headers.get('x-ratelimit-remaining'), '0')

  const second = await fetch(baseUrl, init)
  assert.equal(second.status, 429)
  assert.equal((await second.json()).error.code, -32002)
})

test('external MCP endpoint rejects authenticated oversized JSON bodies', async () => {
  process.env.MCP_RATE_LIMIT_PER_MINUTE = '100'
  process.env.MCP_MAX_BODY_BYTES = '1024'
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { padding: 'x'.repeat(2000) } }),
  })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, -32700)
})
