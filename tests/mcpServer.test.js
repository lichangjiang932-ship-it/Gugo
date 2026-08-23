import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mcp-server-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')
process.env.MODEL_PROVIDERS = ''
process.env.MODEL_BASE_URL = ''
process.env.MODEL_NAME = ''
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const { closeDb, createUser } = await import('../server/db.js')
const { createMobileKey } = await import('../server/services/mobileAccessKeyStore.js')
const { upsertIntegration } = await import('../server/services/integrationsStore.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
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
  upsertIntegration({ userId: 'u-mcp-server', provider: 'web_google_docs', enabled: false })
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'connected_app_list', arguments: {} } }),
  })
  const body = await response.json()
  assert.equal(body.result.isError, undefined)
  assert.deepEqual(body.result.structuredContent.map((app) => app.provider), ['web_gmail'])
})

test('MCP yma_chat keeps missing model diagnostics out of its public error result', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'yma_chat', arguments: { prompt: 'needs a configured model' } },
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.result.isError, true)
  assert.equal(body.result.structuredContent.code, 'MODEL_CONFIG_MISSING')
  assert.equal(body.result.structuredContent.action, 'configure_model')
  assert.equal(body.result.structuredContent.statusCode, 503)
  assert.match(body.result.content[0].text, /设置.*模型/)
  assert.equal(Object.hasOwn(body.result.structuredContent, 'details'), false)
  assert.doesNotMatch(JSON.stringify(body), /"missing"|MODEL_BASE_URL|MODEL_NAME/)
})

test('MCP yma_chat rejects an ambiguous model name unless the Provider UUID is supplied', async () => {
  const upstreams = await Promise.all(['first Provider response', 'second Provider response'].map(async (label) => {
    const upstream = http.createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: label } }],
      }))
    })
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    return upstream
  }))
  const providers = []
  for (const [index, [key, isDefault]] of [['ambiguousa', true], ['ambiguousb', false]].entries()) {
    const provider = upsertModelProvider({
      userId: 'u-mcp-server',
      provider: {
        key,
        label: key,
        baseUrl: `http://127.0.0.1:${upstreams[index].address().port}/v1`,
        apiKey: '',
        models: ['shared-mcp-model'],
        defaultModel: 'shared-mcp-model',
        enabled: true,
        isDefault,
        kind: 'openai-compatible',
      },
    })
    providers.push(provider)
    recordModelProviderReadiness({
      userId: 'u-mcp-server',
      id: provider.id,
      readiness: { chat: true, tools: false, agent: false, mode: 'chat_only' },
    })
  }
  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'yma_chat',
          arguments: { prompt: 'do not choose silently', modelName: 'shared-mcp-model' },
        },
      }),
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.result.isError, true)
    assert.equal(body.result.structuredContent.code, 'MODEL_PROVIDER_AMBIGUOUS')
    assert.equal(body.result.structuredContent.action, 'choose_agent_provider')
    assert.equal(body.result.structuredContent.statusCode, 409)
    assert.equal(body.result.structuredContent.modelName, 'shared-mcp-model')
    assert.match(body.result.content[0].text, /多个 Provider 提供同名模型/)
    assert.match(body.result.content[0].text, /modelProviderId/)

    const explicitResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'yma_chat',
          arguments: {
            prompt: 'use the selected provider',
            modelName: 'shared-mcp-model',
            modelProviderId: providers[1].id,
          },
        },
      }),
    })
    assert.equal(explicitResponse.status, 200)
    const explicitBody = await explicitResponse.json()
    assert.equal(explicitBody.result.isError, undefined)
    assert.match(explicitBody.result.content[0].text, /second Provider response/)
    assert.doesNotMatch(explicitBody.result.content[0].text, /first Provider response/)
  } finally {
    await Promise.all(upstreams.map((upstream) => new Promise((resolve) => upstream.close(resolve))))
  }
})

test('MCP browser open cannot bypass an unconnected managed app', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_open_url', arguments: { url: 'https://web.whatsapp.com/' } } }),
  })
  const body = await response.json()
  assert.equal(body.result.isError, true)
  assert.match(body.result.content[0].text, /not connected/i)
})
