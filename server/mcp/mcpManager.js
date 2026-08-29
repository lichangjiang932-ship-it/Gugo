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
  createMcpConnectionFailedError,
  createMcpConnectionSupervisor,
  createMcpRecoveringError,
} from './mcpConnectionSupervisor.js'
import {
  buildCurrentRegisteredToolSpec,
  buildRegisteredToolSpec,
  onMcpEvent,
  onMcpToolsChange,
  resolveCurrentMcpToolOwner,
  resolveOwnedMcpToolName,
  synchronizeToolsForConnection,
  unregisterAllMcpToolsForUser,
  unregisterToolsForServer,
} from './mcpToolRegistry.js'
import { writeToolAudit } from '../utils/audit.js'
import { getMcpOAuthHeaders } from './mcpOAuth.js'

export { onMcpEvent, onMcpToolsChange }

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

/**
 * 每个用户 → Map<serverId, Connection>
 *   Connection: { server, transport, tools, resources?, prompts?, status, lastError, startedAt }
 */
const userConnections = new Map() // userId → Map<serverId, Connection>

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
    await transport.stop()
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

function installConnection({ userId, server, connection, previousConnection }) {
  const map = getUserMap(userId)
  const previous = map.get(server.id) || previousConnection || null
  connection.status = 'connected'
  connection.lastError = null
  map.set(server.id, connection)
  synchronizeToolsForConnection(userId, server, previous, connection)
  ensureIdleSweeper()
  if (previous && previous !== connection) {
    try { previous.transport?.stop?.() } catch { /* best effort */ }
  }
}

const connectionSupervisor = createMcpConnectionSupervisor({
  connect: ({ userId, server }) => startConnection(userId, server),
  onConnected: installConnection,
  onConnectionLost: ({ connection, error }) => {
    if (!connection) return
    connection.status = 'reconnecting'
    connection.lastError = error?.message || String(error || '')
  },
  onStateChange: (state) => {
    const connection = userConnections.get(state.userId)?.get(state.serverId)
    if (!connection) return
    connection.status = state.status
    connection.reconnectAttempt = state.attempt
    connection.lastError = state.lastError
  },
})

export async function ensureServerConnected(userId, server, { manual = true } = {}) {
  if (!server?.enabled) return null
  const connection = await connectionSupervisor.ensure(userId, server, { manual })
  return touchConnection(connection)
}

export async function reconnectServer(userId, server) {
  return ensureServerConnected(userId, server, { manual: true })
}

export function getMcpConnectionState(userId, serverId) {
  return connectionSupervisor.getState(userId, serverId)
}

export async function ensureUserServers(userId) {
  if (!userId) return { connected: 0, errors: [] }
  const servers = listEnabledServers(userId)
  let connected = 0
  const errors = []
  for (const s of servers) {
    const state = connectionSupervisor.getState(userId, s.id)
    if (state?.status === 'connected') {
      connected += 1
      continue
    }
    if (state?.status === 'reconnecting') {
      const error = createMcpRecoveringError(state)
      errors.push({ serverId: s.id, name: s.name, error: error.message, code: error.code, retryable: true })
      continue
    }
    try {
      await ensureServerConnected(userId, s, { manual: false })
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
  const collisions = new Set()
  const discoveryErrors = [...(connectionResult.errors || [])]
  for (const server of listEnabledServers(userId)) {
    const conn = map.get(server.id)
    const state = connectionSupervisor.getState(userId, server.id)
    if (!conn || (!conn.transport?.isAlive?.() && state?.status !== 'reconnecting')) continue
    for (const tool of conn.tools || []) {
      const candidate = buildRegisteredToolSpec(server, tool)
      const name = candidate.function.name
      const spec = buildCurrentRegisteredToolSpec({ userId, server, tool, connection: conn })
      if (!spec) {
        discoveryErrors.push({
          serverId: server.id,
          name: server.name,
          toolName: name,
          code: 'MCP_TOOL_REGISTRATION_MISMATCH',
          error: `MCP tool ${name} is not bound to the current connection registration`,
          retryable: true,
        })
        continue
      }
      if (collisions.has(name)) continue
      if (specsByName.has(name)) {
        specsByName.delete(name)
        collisions.add(name)
        discoveryErrors.push({
          serverId: server.id,
          name: server.name,
          toolName: name,
          code: 'MCP_TOOL_NAME_COLLISION',
          error: `Multiple MCP tools normalize to ${name}; the ambiguous capability was hidden`,
          retryable: false,
        })
        continue
      }
      specsByName.set(name, spec)
    }
  }
  const specs = [...specsByName.values()].sort((a, b) => (
    a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0
  ))
  return { specs, errors: discoveryErrors }
}

function stateErrorForConnection(userId, serverId) {
  const state = connectionSupervisor.getState(userId, serverId)
  if (state?.status === 'reconnecting') return createMcpRecoveringError(state)
  if (state?.status === 'failed') return createMcpConnectionFailedError(state)
  return null
}

async function connectionForOperation(userId, server) {
  const stateError = stateErrorForConnection(userId, server.id)
  if (stateError) throw stateError
  const map = getUserMap(userId)
  let connection = map.get(server.id)
  if (connection && !connection.transport?.isAlive?.()) {
    connectionSupervisor.reportTransportFailure(
      userId,
      server.id,
      new Error(`MCP server "${server.name}" transport is not alive`),
    )
    throw createMcpRecoveringError(connectionSupervisor.getState(userId, server.id) || {})
  }
  if (!connection) connection = await ensureServerConnected(userId, server, { manual: false })
  return touchConnection(connection)
}

function mcpRoutingError(code, message, { retryable = false } = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}

function assertUnambiguousConnectedTool(userId, fullToolName, expectedServerId) {
  const map = getUserMap(userId)
  const matches = []
  for (const server of listEnabledServers(userId)) {
    const connection = map.get(server.id)
    for (const tool of connection?.tools || []) {
      if (buildRegisteredToolSpec(server, tool).function.name === fullToolName) {
        matches.push({ serverId: server.id, originalName: tool.name })
      }
    }
  }
  if (matches.length !== 1 || matches[0].serverId !== expectedServerId) {
    throw mcpRoutingError(
      'MCP_TOOL_NAME_COLLISION',
      `MCP tool name ${fullToolName} is ambiguous across the current connection catalog`,
    )
  }
}

/** Resolve through the current tenant-scoped registration, never safe-name lookup. */
export async function callTool({
  userId,
  fullToolName,
  args,
  idempotencyKey,
  toolCallId,
  dynamicToolRegistrationId = null,
  signal,
}) {
  if (!/^mcp__[a-zA-Z0-9_]+__.+$/.test(String(fullToolName || ''))) {
    throw mcpRoutingError('MCP_TOOL_NAME_INVALID', `非 MCP 工具名: ${fullToolName}`)
  }
  const owner = resolveCurrentMcpToolOwner(userId, fullToolName)
  if (!owner) {
    throw mcpRoutingError(
      'MCP_TOOL_REGISTRATION_UNAVAILABLE',
      `MCP tool ${fullToolName} has no current tenant-scoped registration`,
      { retryable: true },
    )
  }
  const expectedRegistrationId = String(dynamicToolRegistrationId || '').trim() || null
  if (expectedRegistrationId && owner.registrationId !== expectedRegistrationId) {
    throw mcpRoutingError(
      'dynamic_tool_registration_changed',
      `The MCP registration for ${fullToolName} changed before execution`,
    )
  }
  assertUnambiguousConnectedTool(userId, fullToolName, owner.serverId)
  const server = getServer(userId, owner.serverId)
  if (!server?.enabled) {
    throw mcpRoutingError('MCP_SERVER_UNAVAILABLE', `MCP server ${owner.serverId} is not enabled`)
  }
  const conn = await connectionForOperation(userId, server)
  if (!conn) throw new Error(`MCP server "${server.name}" 未启用`)
  const currentOwner = resolveCurrentMcpToolOwner(userId, fullToolName)
  if (!currentOwner
    || currentOwner.serverId !== owner.serverId
    || currentOwner.registrationId !== owner.registrationId) {
    throw mcpRoutingError(
      'dynamic_tool_registration_changed',
      `The MCP registration for ${fullToolName} changed while preparing execution`,
    )
  }
  assertUnambiguousConnectedTool(userId, fullToolName, owner.serverId)
  const toolName = resolveOwnedMcpToolName(conn, fullToolName, owner.registrationId)
  if (!toolName) {
    throw mcpRoutingError(
      'MCP_TOOL_REGISTRATION_MISMATCH',
      `MCP tool ${fullToolName} is not owned by the current server connection`,
      { retryable: true },
    )
  }

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
    const recoveryState = connectionSupervisor.getState(userId, server.id)
    if (recoveryState?.status === 'reconnecting') {
      const recovering = createMcpRecoveringError(recoveryState)
      recovering.cause = err
      throw recovering
    }
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
    const state = connectionSupervisor.getState(userId, s.id)
    out.push({
      serverId: s.id,
      name: s.name,
      transport: s.transport,
      connected: state?.status === 'connected' && !!conn?.transport?.isAlive?.(),
      status: state?.status || 'disconnected',
      reconnectAttempt: state?.attempt || 0,
      lastError: state?.lastError || null,
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
  const conn = await connectionForOperation(userId, server)
  return await conn.transport.request(buildResourceReadRequest(uri), { timeoutMs: 30000 })
}

export async function getPrompt({ userId, serverId, name, args }) {
  const server = getServer(userId, serverId)
  if (!server) throw new Error('server 不存在')
  const conn = await connectionForOperation(userId, server)
  return await conn.transport.request(buildPromptGetRequest(name, args), { timeoutMs: 15000 })
}

export function disconnectServer(userId, serverId) {
  const map = userConnections.get(userId)
  const conn = map?.get(serverId) || null
  const supervised = connectionSupervisor.disconnect(userId, serverId)
  if (!conn && !supervised) return false
  map?.delete(serverId)
  unregisterToolsForServer(userId, serverId, conn)
  if (map?.size === 0) userConnections.delete(userId)
  return true
}

export function disconnectUser(userId) {
  const map = userConnections.get(userId)
  const supervised = connectionSupervisor.disconnectUser(userId)
  if (!map) {
    unregisterAllMcpToolsForUser(userId)
    return supervised
  }
  let disconnected = 0
  for (const [serverId, conn] of map) {
    unregisterToolsForServer(userId, serverId, conn)
    disconnected += 1
  }
  map.clear()
  userConnections.delete(userId)
  unregisterAllMcpToolsForUser(userId)
  return Math.max(disconnected, supervised)
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

export async function shutdownAll() {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer)
    idleSweepTimer = null
  }
  const transports = []
  for (const map of userConnections.values()) {
    for (const conn of map.values()) {
      if (conn?.transport) transports.push(conn.transport)
    }
  }
  connectionSupervisor.shutdown()
  for (const [userId, map] of userConnections) {
    for (const [serverId, conn] of map) {
      unregisterToolsForServer(userId, serverId, conn)
    }
    map.clear()
  }
  userConnections.clear()
  await Promise.allSettled(transports.map((transport) => Promise.resolve(transport.stop())))
}

export const _mcpManagerInternals = Object.freeze({
  connectionSupervisor,
  synchronizeToolsForConnection,
})
