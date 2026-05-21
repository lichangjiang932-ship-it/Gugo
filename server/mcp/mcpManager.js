/**
 * Feature 1: MCP 连接池 + tool 注入
 *
 * 设计:
 *   - 单 user 内每个 serverId 一条连接
 *   - 第一次需要某 server 时 lazy 拉起
 *   - shutdown 时全部关掉
 *
 * Tool 命名:
 *   `mcp__<serverName>__<toolName>` — 注册到 toolRegistry，模型可见
 *
 * 安全:
 *   - stdio 命令白名单（MCP_STDIO_ALLOWED_COMMANDS）
 *   - MCP_STDIO_ENABLED=0 完全禁用 stdio
 *   - SSE 强制 https（生产）
 *   - 每次调用走 tool_audit
 */

import { StdioTransport } from './mcpTransportStdio.js'
import { SseTransport } from './mcpTransportSse.js'
import {
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolsListRequest,
  buildToolsCallRequest,
  buildResourcesListRequest,
  buildPromptsListRequest,
  buildResourceReadRequest,
  buildPromptGetRequest,
} from './mcpJsonRpc.js'
import { listEnabledServers, getServer } from './mcpStore.js'
import {
  registerDynamicTool,
  unregisterByOrigin,
} from '../toolRegistry.js'
import { getDb } from '../db.js'

const DEFAULT_ALLOWED_COMMANDS = ['npx', 'node', 'uvx', 'python', 'python3']

function getAllowedCommands() {
  const raw = (process.env.MCP_STDIO_ALLOWED_COMMANDS || '').trim()
  if (!raw) return DEFAULT_ALLOWED_COMMANDS
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function stdioEnabled() {
  return process.env.MCP_STDIO_ENABLED !== '0'
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)
}

/**
 * 每个用户 → Map<serverId, Connection>
 *   Connection: { server, transport, tools, resources?, prompts?, status, lastError, startedAt }
 */
const userConnections = new Map() // userId → Map<serverId, Connection>

function getUserMap(userId) {
  if (!userConnections.has(userId)) userConnections.set(userId, new Map())
  return userConnections.get(userId)
}

async function startConnection(server) {
  let transport
  if (server.transport === 'stdio') {
    if (!stdioEnabled()) throw new Error('MCP stdio 已被环境禁用 (MCP_STDIO_ENABLED=0)')
    const allowed = getAllowedCommands()
    const base = String(server.command || '').replace(/\.cmd$/i, '').replace(/\.exe$/i, '')
    if (!allowed.includes(base)) {
      throw new Error(`命令 "${server.command}" 不在白名单。允许: ${allowed.join(', ')}`)
    }
    transport = new StdioTransport({
      command: server.command,
      args: server.args || [],
      cwd: server.cwd || process.cwd(),
      env: server.env || {},
      label: server.name,
    })
    transport.start()
  } else if (server.transport === 'sse') {
    transport = new SseTransport({
      url: server.url,
      headers: server.headers || {},
      label: server.name,
    })
    transport.start()
  } else {
    throw new Error(`未知 transport: ${server.transport}`)
  }

  try {
    // initialize 握手
    await transport.request(buildInitializeRequest(), { timeoutMs: 20000 })
    await transport.send(buildInitializedNotification())
  } catch (err) {
    transport.stop()
    throw new Error(`MCP initialize failed: ${err.message}`, { cause: err })
  }

  // tools/list
  let tools = []
  try {
    const result = await transport.request(buildToolsListRequest(), { timeoutMs: 15000 })
    tools = Array.isArray(result?.tools) ? result.tools : []
  } catch (err) {
    // 没有 tools 能力的 server 不报致命错
    if (!/method not found/i.test(err.message)) {
      if (process.env.NODE_ENV !== 'production') console.warn(`[mcp] ${server.name} tools/list 错误:`, err.message)
    }
  }
  // resources/list（可选）
  let resources = []
  try {
    const result = await transport.request(buildResourcesListRequest(), { timeoutMs: 8000 })
    resources = Array.isArray(result?.resources) ? result.resources : []
  } catch { /* not supported */ }
  // prompts/list（可选）
  let prompts = []
  try {
    const result = await transport.request(buildPromptsListRequest(), { timeoutMs: 8000 })
    prompts = Array.isArray(result?.prompts) ? result.prompts : []
  } catch { /* not supported */ }

  return { transport, tools, resources, prompts, startedAt: Date.now() }
}

function registerToolsForConnection(userId, server, conn) {
  const sn = safeName(server.name)
  for (const t of conn.tools) {
    const toolName = `mcp__${sn}__${safeName(t.name)}`
    registerDynamicTool({
      name: toolName,
      origin: 'mcp',
      source: `${userId}:${server.id}`,
      spec: {
        type: 'function',
        function: {
          name: toolName,
          description: t.description || `${server.name} - ${t.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      },
    })
  }
}

function unregisterToolsForServer(userId, serverId) {
  unregisterByOrigin('mcp', `${userId}:${serverId}`)
}

export async function ensureServerConnected(userId, server) {
  if (!server?.enabled) return null
  const map = getUserMap(userId)
  if (map.has(server.id) && map.get(server.id).transport?.isAlive?.()) {
    return map.get(server.id)
  }
  // 重新连
  if (map.has(server.id)) {
    try { map.get(server.id).transport?.stop?.() } catch { /* ignore */ }
    unregisterToolsForServer(userId, server.id)
  }
  const conn = await startConnection(server)
  map.set(server.id, conn)
  registerToolsForConnection(userId, server, conn)
  return conn
}

export async function ensureUserServers(userId) {
  if (!userId) return { connected: 0, errors: [] }
  const servers = listEnabledServers(userId)
  let connected = 0
  const errors = []
  for (const s of servers) {
    try {
      await ensureServerConnected(userId, s)
      connected += 1
    } catch (err) {
      errors.push({ serverId: s.id, name: s.name, error: err.message })
    }
  }
  return { connected, errors }
}

/**
 * 解析工具名 mcp__<server>__<tool>，找到对应连接，发 tools/call。
 */
export async function callTool({ userId, fullToolName, args }) {
  const m = fullToolName.match(/^mcp__([a-zA-Z0-9_]+)__(.+)$/)
  if (!m) throw new Error(`非 MCP 工具名: ${fullToolName}`)
  const wantedServerSafeName = m[1]
  const innerTool = m[2]

  const map = getUserMap(userId)
  // 找 server (按 safeName 匹配)
  const servers = listEnabledServers(userId)
  const server = servers.find((s) => safeName(s.name) === wantedServerSafeName)
  if (!server) throw new Error(`未配置的 MCP server: ${wantedServerSafeName}`)
  // 找连接,没活的就重连
  let conn = map.get(server.id)
  if (!conn || !conn.transport?.isAlive?.()) {
    conn = await ensureServerConnected(userId, server)
  }
  if (!conn) throw new Error(`MCP server "${server.name}" 未启用`)

  // 找原始 tool 名（恢复 safeName 前的名字）
  const realTool = conn.tools.find((t) => safeName(t.name) === innerTool || t.name === innerTool)
  const toolName = realTool?.name || innerTool

  const started = Date.now()
  let status = 'ok'
  let result
  try {
    result = await conn.transport.request(buildToolsCallRequest(toolName, args), { timeoutMs: 60000 })
  } catch (err) {
    status = 'error'
    throw err
  } finally {
    try {
      getDb().prepare(
        'INSERT INTO tool_audit (user_id, origin, tool_name, server_id, args_hash, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(userId, 'mcp', fullToolName, server.id, null, status, Date.now() - started, Date.now())
    } catch { /* audit best-effort */ }
  }
  // tools/call 结果通常是 { content: [...], isError? }
  return result
}

/**
 * 测试连接：临时拉起、握手、列工具，立即关掉，返回能力描述。
 */
export async function testServer(server) {
  const conn = await startConnection(server)
  try {
    return {
      tools: conn.tools.map((t) => ({ name: t.name, description: t.description })),
      resources: conn.resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })),
      prompts: conn.prompts.map((p) => ({ name: p.name, description: p.description })),
    }
  } finally {
    try { conn.transport.stop() } catch { /* ignore */ }
  }
}

export function getUserCatalog(userId) {
  const map = getUserMap(userId)
  const servers = listEnabledServers(userId)
  const out = []
  for (const s of servers) {
    const conn = map.get(s.id)
    out.push({
      serverId: s.id,
      name: s.name,
      transport: s.transport,
      connected: !!conn?.transport?.isAlive?.(),
      tools: conn?.tools || [],
      resources: conn?.resources || [],
      prompts: conn?.prompts || [],
    })
  }
  return out
}

export async function readResource({ userId, serverId, uri }) {
  const server = getServer(userId, serverId)
  if (!server) throw new Error('server 不存在')
  const conn = await ensureServerConnected(userId, server)
  return await conn.transport.request(buildResourceReadRequest(uri), { timeoutMs: 30000 })
}

export async function getPrompt({ userId, serverId, name, args }) {
  const server = getServer(userId, serverId)
  if (!server) throw new Error('server 不存在')
  const conn = await ensureServerConnected(userId, server)
  return await conn.transport.request(buildPromptGetRequest(name, args), { timeoutMs: 15000 })
}

export function disconnectServer(userId, serverId) {
  const map = userConnections.get(userId)
  if (!map) return false
  const conn = map.get(serverId)
  if (!conn) return false
  try { conn.transport.stop() } catch { /* ignore */ }
  map.delete(serverId)
  unregisterToolsForServer(userId, serverId)
  return true
}

export function shutdownAll() {
  for (const [userId, map] of userConnections) {
    for (const [serverId, conn] of map) {
      try { conn.transport.stop() } catch { /* ignore */ }
      unregisterToolsForServer(userId, serverId)
    }
    map.clear()
  }
  userConnections.clear()
}
