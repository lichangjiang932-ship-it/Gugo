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
} from '../services/toolRegistry.js'
import { writeToolAudit } from '../utils/audit.js'
import { getMcpOAuthHeaders } from './mcpOAuth.js'

const DEFAULT_ALLOWED_COMMANDS = ['npx', 'node', 'uvx', 'python', 'python3']
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const MIN_IDLE_SWEEP_MS = 30 * 1000
const MAX_IDLE_SWEEP_MS = 5 * 60 * 1000

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

// 正在建立的连接：`${userId}:${serverId}` → Promise<Connection>。
// 用于 ensureServerConnected 的 in-flight 去重，防止并发 miss 重复 spawn。
const inFlightConnections = new Map()

let idleSweepTimer = null

function idleTimeoutMs(env = process.env) {
  const parsed = Number(env.MCP_IDLE_TIMEOUT_MS)
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MS
  return Math.max(0, Math.trunc(parsed))
}

function touchConnection(conn, now = Date.now()) {
  if (conn) conn.lastUsedAt = now
  return conn
}

function ensureIdleSweeper() {
  if (idleSweepTimer) return
  const timeoutMs = idleTimeoutMs()
  if (timeoutMs <= 0) return
  const intervalMs = Math.min(MAX_IDLE_SWEEP_MS, Math.max(MIN_IDLE_SWEEP_MS, Math.floor(timeoutMs / 2)))
  idleSweepTimer = setInterval(() => sweepIdleConnections(), intervalMs)
  idleSweepTimer.unref?.()
}

function getUserMap(userId) {
  if (!userConnections.has(userId)) userConnections.set(userId, new Map())
  return userConnections.get(userId)
}

async function startConnection(userId, server) {
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
  } else if (server.transport === 'sse' || server.transport === 'http') {
    transport = new SseTransport({
      url: server.url,
      headers: server.headers || {},
      getHeaders: () => getMcpOAuthHeaders(userId, server.id),
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

  const startedAt = Date.now()
  return { transport, tools, resources, prompts, startedAt, lastUsedAt: startedAt }
}

function buildRegisteredToolSpec(server, tool) {
  const sn = safeName(server.name)
  const toolName = `mcp__${sn}__${safeName(tool.name)}`
  return {
    type: 'function',
    function: {
      name: toolName,
      description: tool.description || `${server.name} - ${tool.name}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  }
}

function buildMcpRiskMetadata(server, tool, toolName) {
  const configuredTools = server.tools && typeof server.tools === 'object' && !Array.isArray(server.tools)
    ? server.tools
    : {}
  const declaration = configuredTools[tool.name] || configuredTools[toolName]
  if (declaration && typeof declaration === 'object' && !Array.isArray(declaration)) {
    const riskLevel = ['low', 'medium', 'high'].includes(declaration.riskLevel)
      ? declaration.riskLevel
      : 'high'
    const approvalDeclaration = declaration.requiredApproval ?? declaration.requiresApproval
    const requiredApproval = typeof approvalDeclaration === 'boolean' ? approvalDeclaration : true
    const category = ['read', 'write_local', 'exec', 'external'].includes(declaration.category)
      ? declaration.category
      : (riskLevel === 'low' && requiredApproval === false ? 'read' : 'external')
    const isReadOnly = category === 'read'
    return {
      riskLevel,
      category,
      requiredApproval,
      requiresApproval: requiredApproval,
      isReadOnly,
      isConcurrencySafe: declaration.isConcurrencySafe == null
        ? isReadOnly
        : declaration.isConcurrencySafe === true,
      isIdempotent: declaration.isIdempotent == null
        ? isReadOnly || tool.annotations?.idempotentHint === true
        : declaration.isIdempotent === true,
      interruptBehavior: isReadOnly ? 'cancel' : 'block',
      isDestructive: declaration.isDestructive == null
        ? !isReadOnly
        : declaration.isDestructive === true,
      source: 'declared',
      reason: isReadOnly ? null : `MCP: ${server.name}`,
    }
  }

  // autoApprove is retained as a legacy compatibility fallback. MCP
  // annotations are advisory only and never bypass approval on their own.
  const autoApprove = Array.isArray(server.autoApprove)
    && (server.autoApprove.includes(tool.name) || server.autoApprove.includes(toolName))
  return {
    riskLevel: 'high',
    category: 'external',
    requiredApproval: !autoApprove,
    requiresApproval: !autoApprove,
    isReadOnly: false,
    isConcurrencySafe: false,
    isIdempotent: tool.annotations?.idempotentHint === true,
    interruptBehavior: 'block',
    isDestructive: tool.annotations?.destructiveHint !== false,
    source: 'fallback',
    reason: `MCP: ${server.name}`,
  }
}

function registerToolsForConnection(userId, server, conn) {
  for (const tool of conn.tools) {
    const spec = buildRegisteredToolSpec(server, tool)
    const toolName = spec.function.name
    registerDynamicTool({
      name: toolName,
      origin: 'mcp',
      source: `${userId}:${server.id}`,
      userId,
      spec,
      metadata: buildMcpRiskMetadata(server, tool, toolName),
    })
  }
}

function unregisterToolsForServer(userId, serverId) {
  unregisterByOrigin('mcp', `${userId}:${serverId}`, { userId })
}

export async function ensureServerConnected(userId, server) {
  if (!server?.enabled) return null
  const map = getUserMap(userId)
  if (map.has(server.id) && map.get(server.id).transport?.isAlive?.()) {
    return touchConnection(map.get(server.id))
  }
  // in-flight 去重：并发 miss（如两个工具调用同时触发）共享同一次连接建立，
  // 避免重复 spawn stdio 子进程 / 重复建立 SSE，导致前一个连接泄漏。
  const pendingKey = `${userId}:${server.id}`
  const inFlight = inFlightConnections.get(pendingKey)
  if (inFlight) {
    try {
      return await inFlight
    } catch {
      // 等待方等到的连接失败了，允许它自己重试一次
    }
  }
  const connecting = (async () => {
    try {
      // 重新连
      if (map.has(server.id)) {
        try { map.get(server.id).transport?.stop?.() } catch { /* ignore */ }
        unregisterToolsForServer(userId, server.id)
      }
      const conn = await startConnection(userId, server)
      map.set(server.id, conn)
      registerToolsForConnection(userId, server, conn)
      ensureIdleSweeper()
      return conn
    } finally {
      inFlightConnections.delete(pendingKey)
    }
  })()
  inFlightConnections.set(pendingKey, connecting)
  return connecting
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
 * Return only the MCP tool specs owned by this user. The global dynamic
 * registry exists for the chat catalog, but background jobs must not read it:
 * another user's connection may have registered a tool with the same name.
 */
export async function listUserToolSpecs(userId, { connect = true } = {}) {
  if (!userId) return { specs: [], errors: [] }
  const connectionResult = connect
    ? await ensureUserServers(userId)
    : { connected: 0, errors: [] }
  const map = getUserMap(userId)
  const specsByName = new Map()
  for (const server of listEnabledServers(userId)) {
    const conn = map.get(server.id)
    if (!conn?.transport?.isAlive?.()) continue
    for (const tool of conn.tools || []) {
      const spec = buildRegisteredToolSpec(server, tool)
      specsByName.set(spec.function.name, spec)
    }
  }
  const specs = [...specsByName.values()].sort((a, b) => (
    a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0
  ))
  return { specs, errors: connectionResult.errors || [] }
}

/**
 * 解析工具名 mcp__<server>__<tool>，找到对应连接，发 tools/call。
 */
export async function callTool({ userId, fullToolName, args, idempotencyKey, toolCallId, signal }) {
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
  touchConnection(conn)
  if (!conn) throw new Error(`MCP server "${server.name}" 未启用`)

  // 找原始 tool 名（恢复 safeName 前的名字）
  const realTool = conn.tools.find((t) => safeName(t.name) === innerTool || t.name === innerTool)
  const toolName = realTool?.name || innerTool

  const started = Date.now()
  let status = 'ok'
  let result
  try {
    result = await conn.transport.request(
      buildToolsCallRequest(toolName, args, { idempotencyKey, toolCallId }),
      { timeoutMs: 60000, signal },
    )
  } catch (err) {
    status = 'error'
    throw err
  } finally {
    // ★ P0:走统一 audit 写入器
    writeToolAudit({
      userId,
      origin: 'mcp',
      toolName: fullToolName,
      serverId: server.id,
      args,
      status,
      durationMs: Date.now() - started,
    })
  }
  // tools/call 结果通常是 { content: [...], isError? }
  return result
}

/**
 * 测试连接：临时拉起、握手、列工具，立即关掉，返回能力描述。
 */
export async function testServer(userId, server) {
  const conn = await startConnection(userId, server)
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
  touchConnection(conn)
  return await conn.transport.request(buildResourceReadRequest(uri), { timeoutMs: 30000 })
}

export async function getPrompt({ userId, serverId, name, args }) {
  const server = getServer(userId, serverId)
  if (!server) throw new Error('server 不存在')
  const conn = await ensureServerConnected(userId, server)
  touchConnection(conn)
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
  if (map.size === 0) userConnections.delete(userId)
  return true
}

export function disconnectUser(userId) {
  const map = userConnections.get(userId)
  if (!map) {
    unregisterByOrigin('mcp', null, { userId })
    return 0
  }
  let disconnected = 0
  for (const [serverId, conn] of map) {
    try { conn.transport.stop() } catch { /* ignore */ }
    unregisterToolsForServer(userId, serverId)
    disconnected += 1
  }
  map.clear()
  userConnections.delete(userId)
  unregisterByOrigin('mcp', null, { userId })
  return disconnected
}

export function sweepIdleConnections({ now = Date.now(), timeoutMs = idleTimeoutMs() } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0
  const expired = []
  for (const [userId, map] of userConnections) {
    for (const [serverId, conn] of map) {
      const lastUsedAt = Number(conn.lastUsedAt || conn.startedAt || 0)
      if (now - lastUsedAt >= timeoutMs) expired.push([userId, serverId])
    }
  }
  for (const [userId, serverId] of expired) disconnectServer(userId, serverId)
  return expired.length
}

export function shutdownAll() {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer)
    idleSweepTimer = null
  }
  for (const [userId, map] of userConnections) {
    for (const [serverId, conn] of map) {
      try { conn.transport.stop() } catch { /* ignore */ }
      unregisterToolsForServer(userId, serverId)
    }
    map.clear()
  }
  userConnections.clear()
}
