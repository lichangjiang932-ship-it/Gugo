import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { checkRateLimit } from '../db.js'
import { verifyAccessKey } from '../services/mobileAccessKeyStore.js'
import { buildUserModelEnv } from '../services/modelProviderStore.js'
import { isIntegrationEnabled } from '../services/integrationsStore.js'
import {
  assertBrowserAppUrlAccess,
  assertBrowserSessionAppAccess,
  listConnectedBrowserApps,
  openConnectedBrowserApp,
  fetchNotionPage,
  getGithubFile,
  searchGithubRepositories,
  searchNotion,
} from '../services/connectorService.js'
import {
  callBackgroundModel,
  getModelStatus,
  getRuntimeEnv,
} from '../adapters/modelProxy.js'
import {
  browserClick,
  browserConsole,
  browserOpenUrl,
  browserScreenshot,
  browserSnapshot,
  browserType,
  browserWait,
} from '../adapters/browserAutomation.js'

const PROTOCOL_VERSION = '2025-03-26'
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'MCP-Protocol-Version': PROTOCOL_VERSION,
}

const TOOLS = [
  {
    name: 'yma_chat',
      description: 'Send a prompt or OpenAI-style messages to the user-selected model in Gugo.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        messages: { type: 'array', items: { type: 'object' } },
        model: { type: 'string' },
      },
    },
  },
  {
    name: 'yma_models',
    description: 'List the models currently available to this user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connected_app_list',
    description: 'List Browser apps the user connected and enabled for task assistance.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connected_app_open',
    description: 'Use a persistently connected Browser app. Its visible managed session is restored automatically when needed.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' } }, required: ['provider'] },
  },
  {
    name: 'browser_open_url',
    description: 'Open an http/https URL in an isolated local Edge/Chrome session.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_snapshot',
    description: 'Read current page text and interactive element refs.',
    inputSchema: { type: 'object', properties: { maxText: { type: 'integer', minimum: 1000, maximum: 50000 } } },
  },
  {
    name: 'browser_state',
    description: 'Read the current browser URL, title and connection state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_console',
    description: 'Read page console messages and uncaught exceptions.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean' } } },
  },
  {
    name: 'browser_click',
    description: 'Click an element using a snapshot ref such as e3 or a CSS selector.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  },
  {
    name: 'browser_type',
    description: 'Fill an input using a snapshot ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['target', 'text'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for milliseconds or for an element to appear.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 10000 }, target: { type: 'string' } } },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture the current page as a PNG image.',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
  },
  {
    name: 'notion_search',
    description: 'Search pages and databases shared with the connected Notion integration.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'notion_fetch_page',
    description: 'Read a Notion page and its first 100 child blocks.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
  },
  {
    name: 'github_search_repositories',
    description: 'Search repositories visible to the connected GitHub account.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'github_get_file',
    description: 'Read a file or list a directory in a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } },
      required: ['owner', 'repo', 'path'],
    },
  },
]

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }
}

function bearer(req) {
  const value = String(req.headers?.authorization || '')
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

function authenticateMcp(req) {
  const sessionUserId = authenticateRequest(req)
  if (sessionUserId) return sessionUserId
  const verified = verifyAccessKey(bearer(req))
  if (verified?.userId) {
    req.userId = verified.userId
    req.accessKeyId = verified.keyId
    return verified.userId
  }
  return null
}

function envInt(name, fallback, min, max) {
  const value = Number(process.env[name])
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function applyMcpRateLimit(req, res) {
  const maxRequests = envInt('MCP_RATE_LIMIT_PER_MINUTE', 300, 1, 10000)
  const clientId = req.socket?.remoteAddress || 'unknown'
  const result = checkRateLimit({ key: `mcp_http:${clientId}`, windowMs: 60_000, maxRequests })
  res.setHeader('X-RateLimit-Limit', String(maxRequests))
  res.setHeader('X-RateLimit-Remaining', String(result.remaining))
  if (result.resetAt) res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
  if (result.allowed) return true
  sendJson(res, 429, rpcError(null, -32002, 'Too many MCP requests'))
  return false
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }], structuredContent: typeof value === 'object' ? value : undefined }
}

async function callTool(userId, name, args = {}) {
  if (name === 'yma_chat') {
    const messages = Array.isArray(args.messages) && args.messages.length
      ? args.messages
      : [{ role: 'user', content: String(args.prompt || '').trim() }]
    if (!messages.length || !messages[0]?.content) throw new Error('prompt 或 messages 不能为空')
    return textResult(await callBackgroundModel({ messages, modelName: args.model, userId }))
  }
  if (name === 'yma_models') {
    const env = buildUserModelEnv({ userId, env: getRuntimeEnv() })
    const status = getModelStatus(env)
    return textResult({ configured: status.configured, active: status.modelName, models: status.models || [] })
  }
  if (name === 'connected_app_list') return textResult(listConnectedBrowserApps({ userId }))
  if (name === 'connected_app_open') return textResult(await openConnectedBrowserApp({ userId, provider: args.provider }))
  if (name?.startsWith('browser_') && !isIntegrationEnabled({ userId, provider: 'browser', defaultEnabled: true })) {
    throw new Error('Browser is disabled in Access')
  }
  if (name === 'browser_open_url') {
    const connectedApp = assertBrowserAppUrlAccess({ userId, url: args.url })
    const persistent = !!connectedApp || listConnectedBrowserApps({ userId }).length > 0
    return textResult(await browserOpenUrl({ userId, url: args.url, headed: persistent }))
  }
  if (['browser_snapshot', 'browser_console', 'browser_click', 'browser_type', 'browser_wait', 'browser_screenshot'].includes(name)) {
    await assertBrowserSessionAppAccess({ userId })
  }
  if (name === 'browser_snapshot') return textResult(await browserSnapshot({ userId, maxText: args.maxText }))
  if (name === 'browser_state') return textResult(await assertBrowserSessionAppAccess({ userId }))
  if (name === 'browser_console') return textResult(await browserConsole({ userId, clear: args.clear }))
  if (name === 'browser_click') {
    const result = await browserClick({ userId, target: args.target })
    if (result?.url) assertBrowserAppUrlAccess({ userId, url: result.url })
    return textResult(result)
  }
  if (name === 'browser_type') {
    const result = await browserType({ userId, target: args.target, text: args.text, submit: args.submit })
    await assertBrowserSessionAppAccess({ userId })
    return textResult(result)
  }
  if (name === 'browser_wait') {
    const result = await browserWait({ userId, ms: args.ms, target: args.target })
    await assertBrowserSessionAppAccess({ userId })
    return textResult(result)
  }
  if (name === 'browser_screenshot') {
    const image = await browserScreenshot({ userId, fullPage: args.fullPage })
    return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] }
  }
  if (name === 'notion_search') return textResult(await searchNotion({ userId, query: args.query }))
  if (name === 'notion_fetch_page') return textResult(await fetchNotionPage({ userId, pageId: args.pageId }))
  if (name === 'github_search_repositories') return textResult(await searchGithubRepositories({ userId, query: args.query }))
  if (name === 'github_get_file') return textResult(await getGithubFile({ userId, ...args }))
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 })
}

async function dispatch(userId, message) {
  const id = message?.id
  const method = message?.method
  if (message?.jsonrpc !== '2.0' || !method) return rpcError(id, -32600, 'Invalid Request')
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Gugo', version: '0.10.2' },
      instructions: 'Use yma_chat for the configured model and browser_* tools for isolated browser automation.',
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = message.params?.name
    try {
      return rpcResult(id, await callTool(userId, name, message.params?.arguments || {}))
    } catch (error) {
      return rpcResult(id, { content: [{ type: 'text', text: error?.message || String(error) }], isError: true })
    }
  }
  if (method.startsWith('notifications/')) return null
  return rpcError(id, -32601, 'Method not found')
}

export async function handleMcpServerRequest(req, res) {
  if (process.env.MCP_SERVER_ENABLED === '0') return sendJson(res, 404, rpcError(null, -32004, 'MCP server disabled'))
  if (!applyMcpRateLimit(req, res)) return
  const userId = authenticateMcp(req)
  if (!userId) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="Gugo MCP"')
    return sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'))
  }
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'MCP-Protocol-Version': PROTOCOL_VERSION })
    return res.end()
  }
  if (req.method !== 'POST') return sendJson(res, 405, rpcError(null, -32600, 'Use POST for Streamable HTTP'))
  try {
    const maxBytes = envInt('MCP_MAX_BODY_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024)
    const payload = await readJson(req, { maxBytes })
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((message) => dispatch(userId, message)))).filter(Boolean)
      if (!responses.length) { res.writeHead(202); return res.end() }
      return sendJson(res, 200, responses)
    }
    const response = await dispatch(userId, payload)
    if (!response) { res.writeHead(202); return res.end() }
    return sendJson(res, 200, response)
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, rpcError(null, -32700, error?.message || 'Parse error'))
  }
}

export const MCP_SERVER_TOOLS = TOOLS
