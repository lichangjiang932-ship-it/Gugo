/**
 * Feature 1: MCP REST 路由
 *
 *   GET    /api/mcp/servers             — 当前用户配置
 *   POST   /api/mcp/servers             — 新增/更新
 *   DELETE /api/mcp/servers/:id
 *   POST   /api/mcp/servers/:id/test    — 临时拉起 + list capabilities + 关掉
 *   POST   /api/mcp/servers/:id/connect — 拉起 + 注入到 toolRegistry
 *   POST   /api/mcp/servers/:id/disconnect
 *   GET    /api/mcp/catalog             — 已连接 server 的 tools/resources/prompts
 *   POST   /api/mcp/resources/read      body: { serverId, uri }
 *   POST   /api/mcp/prompts/get         body: { serverId, name, arguments }
 *   POST   /api/tools/mcp/call          body: { fullToolName, arguments }
 */

import { readJson } from './utils.js'
import { authenticateRequest } from './middleware.js'
import {
  listServers,
  getServer,
  upsertServer,
  deleteServer,
} from './mcp/mcpStore.js'
import {
  testServer,
  ensureServerConnected,
  disconnectServer,
  getUserCatalog,
  callTool,
  readResource,
  getPrompt,
} from './mcp/mcpManager.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function handleMcpRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/mcp/servers') {
      return sendJson(res, 200, { ok: true, servers: listServers(userId) })
    }

    if (req.method === 'POST' && pathname === '/api/mcp/servers') {
      const body = await readJson(req)
      const server = upsertServer({ userId, ...body })
      return sendJson(res, 200, { ok: true, server })
    }

    if (req.method === 'GET' && pathname === '/api/mcp/catalog') {
      return sendJson(res, 200, { ok: true, catalog: getUserCatalog(userId) })
    }

    if (req.method === 'POST' && pathname === '/api/mcp/resources/read') {
      const body = await readJson(req)
      const result = await readResource({ userId, serverId: body.serverId, uri: body.uri })
      return sendJson(res, 200, { ok: true, result })
    }

    if (req.method === 'POST' && pathname === '/api/mcp/prompts/get') {
      const body = await readJson(req)
      const result = await getPrompt({ userId, serverId: body.serverId, name: body.name, args: body.arguments })
      return sendJson(res, 200, { ok: true, result })
    }

    if (req.method === 'POST' && pathname === '/api/tools/mcp/call') {
      const body = await readJson(req)
      const result = await callTool({ userId, fullToolName: body.fullToolName, args: body.arguments })
      return sendJson(res, 200, { ok: true, result })
    }

    const m = pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(test|connect|disconnect))?$/)
    if (m) {
      const id = m[1]
      const action = m[2]
      const server = getServer(userId, id)
      if (action === 'test' && req.method === 'POST') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server 不存在' })
        const caps = await testServer(server)
        return sendJson(res, 200, { ok: true, capabilities: caps })
      }
      if (action === 'connect' && req.method === 'POST') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server 不存在' })
        const conn = await ensureServerConnected(userId, server)
        return sendJson(res, 200, { ok: true, connected: !!conn, toolCount: conn?.tools?.length || 0 })
      }
      if (action === 'disconnect' && req.method === 'POST') {
        const ok = disconnectServer(userId, id)
        return sendJson(res, 200, { ok: true, disconnected: ok })
      }
      if (req.method === 'DELETE') {
        try { disconnectServer(userId, id) } catch { /* ignore */ }
        return sendJson(res, 200, { ok: true, ...deleteServer(userId, id) })
      }
      if (req.method === 'GET') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server 不存在' })
        return sendJson(res, 200, { ok: true, server })
      }
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
