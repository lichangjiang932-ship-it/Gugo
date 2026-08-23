import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-mcp-tools-tests', String(process.pid))

const { issueTestSession } = await import('./helpers/testAuth.js')
const { upsertServer } = await import('../server/mcp/mcpStore.js')
const {
  disconnectServer,
  listUserToolSpecs,
  shutdownAll,
} = await import('../server/mcp/mcpManager.js')
const { runToolsLoop } = await import('../server/services/jobTools.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const {
  getDynamicTool,
  getDynamicToolSpecRegistrationId,
} = await import('../server/services/toolRegistry.js')

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function startFakeMcpServer() {
  const messages = []
  const server = http.createServer(async (req, res) => {
    const message = await readJson(req)
    messages.push(message)
    if (message.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    let result = {}
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'fake-devtools', version: '1.0.0' },
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{
          name: 'inspect_page',
          description: 'Inspect a test page.',
          annotations: { readOnlyHint: true, destructiveHint: false },
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
        }],
      }
    } else if (message.method === 'resources/list') {
      result = { resources: [] }
    } else if (message.method === 'prompts/list') {
      result = { prompts: [] }
    } else if (message.method === 'tools/call') {
      result = {
        content: [{ type: 'text', text: `inspected:${message.params.arguments.url}` }],
        isError: false,
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    messages,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  }
}

test('autonomous jobs receive and execute only the current user MCP tools', async () => {
  const owner = issueTestSession().userId
  const otherUser = issueTestSession().userId
  const fake = await startFakeMcpServer()
  const configured = upsertServer({
    userId: owner,
    name: 'devtools',
    transport: 'http',
    url: fake.url,
    enabled: true,
    args: [],
    env: {},
    headers: {},
    autoApprove: [],
    tools: {},
  })
  setApprovalMode({ userId: owner, mode: 'bypass' })

  try {
    let { specs, errors } = await listUserToolSpecs(owner)
    assert.deepEqual(errors, [])
    assert.deepEqual(specs.map((spec) => spec.function.name), ['mcp__devtools__inspect_page'])
    const fallbackRegistration = getDynamicTool('mcp__devtools__inspect_page', { userId: owner })
    assert.equal(
      getDynamicToolSpecRegistrationId(specs[0]),
      fallbackRegistration.registrationId,
      'rebuilt MCP schemas must retain the host-only identity of the live registration',
    )
    const fallbackMetadata = fallbackRegistration.metadata
    assert.equal(fallbackMetadata.riskClass, 'external')
    assert.equal(fallbackMetadata.riskLevel, 'high')
    assert.equal(fallbackMetadata.requiresApproval, true)
    assert.equal(fallbackMetadata.source, 'fallback')
    assert.equal(getDynamicTool('mcp__devtools__inspect_page', { userId: otherUser }), null)
    assert.deepEqual((await listUserToolSpecs(otherUser)).specs, [])

    disconnectServer(owner, configured.id)
    const declaredServer = upsertServer({
      ...configured,
      userId: owner,
      autoApprove: [],
      tools: {
        inspect_page: { riskLevel: 'low', requiresApproval: false },
      },
    })
    assert.deepEqual(declaredServer.tools, {
      inspect_page: { riskLevel: 'low', requiresApproval: false },
    })
    ;({ specs, errors } = await listUserToolSpecs(owner))
    assert.deepEqual(errors, [])
    const declaredMetadata = getDynamicTool('mcp__devtools__inspect_page', { userId: owner }).metadata
    assert.equal(declaredMetadata.riskClass, 'read')
    assert.equal(declaredMetadata.riskLevel, 'low')
    assert.equal(declaredMetadata.requiresApproval, false)
    assert.equal(declaredMetadata.source, 'declared')

    let invocations = 0
    let observedToolResult = ''
    const result = await runToolsLoop({
      job: { id: 'job-mcp', userId: owner, title: 'inspect page' },
      step: { id: 'step-mcp', kind: 'execute' },
      messages: [{ role: 'user', content: 'Inspect https://example.com' }],
      toolSpecs: specs,
      runModel: async ({ messages }) => {
        invocations += 1
        if (invocations === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'mcp-call-1',
              name: 'mcp__devtools__inspect_page',
              arguments: JSON.stringify({ url: 'https://example.com' }),
            }],
          }
        }
        observedToolResult = messages.find((message) => message.role === 'tool')?.content || ''
        return { content: 'Inspection complete.', toolCalls: [] }
      },
    })

    assert.equal(result.text, 'Inspection complete.')
    assert.match(observedToolResult, /inspected:https:\/\/example\.com/)
    const toolRequest = fake.messages.find((message) => message.method === 'tools/call')
    assert.deepEqual(toolRequest.params._meta, {
      'gugo/idempotencyKey': 'job:job-mcp:step:step-mcp:tool:mcp-call-1',
      'gugo/toolCallId': 'mcp-call-1',
    })
  } finally {
    disconnectServer(owner, configured.id)
    shutdownAll()
    await new Promise((resolve) => fake.server.close(resolve))
  }
})
