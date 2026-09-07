import { StdioTransport } from './mcpTransportStdio.js'
import { SseTransport } from './mcpTransportSse.js'
import {
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolsListRequest,
  buildResourcesListRequest,
  buildPromptsListRequest,
} from './mcpJsonRpc.js'
import { isPureLocalModeEnabled } from '../utils/outboundNetworkGuard.js'

const DEFAULT_ALLOWED_COMMANDS = ['npx', 'node', 'uvx', 'python', 'python3']

export function assertMcpTransportAllowed(server, env = process.env) {
  if (server?.transport !== 'stdio' || !isPureLocalModeEnabled(env)) return
  throw Object.assign(new Error('MCP stdio is disabled by pure-local mode'), {
    code: 'OUTBOUND_PURE_LOCAL_DENIED', retryable: false,
  })
}

function createTransport(userId, server, getOAuthHeaders) {
  if (server.transport === 'stdio') {
    assertMcpTransportAllowed(server)
    if (process.env.MCP_STDIO_ENABLED === '0') {
      throw new Error('MCP stdio 已被环境禁用 (MCP_STDIO_ENABLED=0)')
    }
    const configured = String(process.env.MCP_STDIO_ALLOWED_COMMANDS || '').trim()
    const allowed = configured ? configured.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_ALLOWED_COMMANDS
    const base = String(server.command || '').replace(/\.cmd$/i, '').replace(/\.exe$/i, '')
    if (!allowed.includes(base)) {
      throw new Error(`命令 "${server.command}" 不在白名单。允许: ${allowed.join(', ')}`)
    }
    return new StdioTransport({
      command: server.command, args: server.args || [],
      cwd: server.cwd || process.cwd(), env: server.env || {}, label: server.name,
    })
  }
  if (server.transport === 'sse' || server.transport === 'http') {
    return new SseTransport({
      url: server.url, headers: server.headers || {},
      getHeaders: () => getOAuthHeaders(userId, server.id), label: server.name,
    })
  }
  throw new Error(`未知 transport: ${server.transport}`)
}

export async function startMcpConnection(userId, server, { getOAuthHeaders, attachCatalogRefresh } = {}) {
  const transport = createTransport(userId, server, getOAuthHeaders)
  const connection = { transport, tools: [], resources: [], prompts: [] }
  let disposeCatalog
  try {
    // Subscribe before initialization/listing so startup notifications are
    // retained; refresh work starts only after the host installs this instance.
    disposeCatalog = attachCatalogRefresh(connection)
    transport.start()
    try {
      await transport.request(buildInitializeRequest(), { timeoutMs: 20000 })
      await transport.send(buildInitializedNotification())
    } catch (error) {
      throw new Error(`MCP initialize failed: ${error.message}`, { cause: error })
    }
    try {
      const result = await transport.request(buildToolsListRequest(), { timeoutMs: 15000 })
      connection.tools = Array.isArray(result?.tools) ? result.tools : []
    } catch (error) {
      if (!/method not found/i.test(error.message) && process.env.NODE_ENV !== 'production') {
        console.warn(`[mcp] ${server.name} tools/list 错误:`, error.message)
      }
    }
    try {
      const result = await transport.request(buildResourcesListRequest(), { timeoutMs: 8000 })
      connection.resources = Array.isArray(result?.resources) ? result.resources : []
    } catch { /* optional capability */ }
    try {
      const result = await transport.request(buildPromptsListRequest(), { timeoutMs: 8000 })
      connection.prompts = Array.isArray(result?.prompts) ? result.prompts : []
    } catch { /* optional capability */ }
    assertMcpTransportAllowed(server)
    const startedAt = Date.now()
    return Object.assign(connection, { startedAt, lastUsedAt: startedAt })
  } catch (error) {
    disposeCatalog?.()
    await transport.stop()
    throw error
  }
}
