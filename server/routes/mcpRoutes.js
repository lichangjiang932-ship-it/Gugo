import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import { deleteServer, getServer, listServers, upsertServer } from '../mcp/mcpStore.js'
import {
  callTool,
  disconnectServer,
  ensureServerConnected,
  getPrompt,
  getUserCatalog,
  readResource,
  testServer,
} from '../mcp/mcpManager.js'
import {
  beginMcpOAuth,
  completeMcpOAuth,
  disconnectMcpOAuth,
  getMcpOAuthStatus,
} from '../mcp/mcpOAuth.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function routeError(message, code, statusCode = 500) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function isTrue(value) {
  return ['1', 'true'].includes(String(value || '').trim().toLowerCase())
}

function publicOrigin(raw, label = 'public URL') {
  let url
  try { url = new URL(String(raw || '')) } catch {
    throw routeError(`${label} is invalid`, 'MCP_OAUTH_PUBLIC_URL_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw routeError(`${label} must be an HTTP(S) origin`, 'MCP_OAUTH_PUBLIC_URL_INVALID')
  }
  return url.origin
}

function directServerOrigin(req, env) {
  let host = String(env.SERVER_HOST || '127.0.0.1').trim()
  if (host === '0.0.0.0') host = '127.0.0.1'
  if (host === '::' || host === '[::]') host = '::1'
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  const configuredPort = Number(env.SERVER_PORT)
  const socketPort = Number(req.socket?.localPort)
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : Number.isInteger(socketPort) && socketPort > 0 && socketPort <= 65535
      ? socketPort
      : 5175
  const proto = req.socket?.encrypted ? 'https' : 'http'
  return publicOrigin(`${proto}://${host}:${port}`, 'configured server origin')
}

function requestOrigin(req, env = process.env) {
  const configured = String(env.APP_PUBLIC_URL || '').trim()
  if (configured) return publicOrigin(configured, 'APP_PUBLIC_URL')
  if (isTrue(env.TRUST_PROXY)) {
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    const proto = forwardedProto || (req.socket?.encrypted ? 'https' : 'http')
    const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim()
    if (host) return publicOrigin(`${proto}://${host}`, 'trusted proxy origin')
  }
  // Host and X-Forwarded-* are attacker-controlled unless the deployment explicitly
  // opts into proxy trust. Direct deployments use the configured listener instead.
  return directServerOrigin(req, env)
}

function sendOAuthCallback(res, { ok, serverId = '', message = '', targetOrigin = '' }) {
  const nonce = res.locals?.cspNonce || ''
  const payload = JSON.stringify({ type: 'mcp-oauth-complete', ok, serverId, message })
    .replace(/</g, '\\u003c')
  const target = JSON.stringify(targetOrigin || '').replace(/</g, '\\u003c')
  const title = ok ? 'MCP OAuth connected' : 'MCP OAuth failed'
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p id="status">${title}</p><script nonce="${nonce}">const payload=${payload};const target=${target}||window.location.origin;document.getElementById('status').textContent=payload.message||${JSON.stringify(title)};if(window.opener)window.opener.postMessage(payload,target);setTimeout(()=>window.close(),500);</script></body></html>`)
}

function publicServer(userId, server) {
  return { ...server, oauth: getMcpOAuthStatus(userId, server.id) }
}

async function handleOAuthCallback(url, res) {
  try {
    const result = await completeMcpOAuth({
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      error: url.searchParams.get('error'),
      errorDescription: url.searchParams.get('error_description'),
    })
    disconnectServer(result.userId, result.serverId)
    return sendOAuthCallback(res, {
      ok: true,
      serverId: result.serverId,
      message: 'MCP OAuth connected. You can close this window.',
      targetOrigin: result.callbackOrigin,
    })
  } catch (error) {
    return sendOAuthCallback(res, { ok: false, message: error?.message || 'OAuth failed' })
  }
}

async function handleOAuthRequest(req, res, url, userId) {
  const match = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/oauth(?:\/(start|status))?$/)
  if (!match) return false
  const serverId = match[1]
  const action = match[2] || ''
  if (!getServer(userId, serverId)) {
    sendJson(res, 404, { ok: false, error: 'server does not exist' })
    return true
  }
  if (action === 'start' && req.method === 'POST') {
    const body = await readJson(req)
    const result = await beginMcpOAuth({
      userId,
      serverId,
      redirectUri: `${requestOrigin(req)}/api/mcp/oauth/callback`,
      config: body || {},
    })
    sendJson(res, 200, { ok: true, ...result })
    return true
  }
  if (action === 'status' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, oauth: getMcpOAuthStatus(userId, serverId) })
    return true
  }
  if (!action && req.method === 'DELETE') {
    disconnectServer(userId, serverId)
    sendJson(res, 200, { ok: true, disconnected: disconnectMcpOAuth(userId, serverId) })
    return true
  }
  sendJson(res, 405, { ok: false, error: 'method not allowed' })
  return true
}

export async function handleMcpRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  if (req.method === 'GET' && pathname === '/api/mcp/oauth/callback') {
    return handleOAuthCallback(url, res)
  }

  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: 'Please sign in first' })

  try {
    if (await handleOAuthRequest(req, res, url, userId)) return

    if (req.method === 'GET' && pathname === '/api/mcp/servers') {
      return sendJson(res, 200, { ok: true, servers: listServers(userId).map((server) => publicServer(userId, server)) })
    }
    if (req.method === 'POST' && pathname === '/api/mcp/servers') {
      const body = await readJson(req)
      const previous = body.id ? getServer(userId, body.id) : null
      const server = upsertServer({ userId, ...body })
      if (previous?.url && previous.url !== server.url) {
        disconnectServer(userId, server.id)
        disconnectMcpOAuth(userId, server.id)
      }
      return sendJson(res, 200, { ok: true, server: publicServer(userId, server) })
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

    const match = pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(test|connect|disconnect))?$/)
    if (match) {
      const id = match[1]
      const action = match[2]
      const server = getServer(userId, id)
      if (action === 'test' && req.method === 'POST') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server does not exist' })
        return sendJson(res, 200, { ok: true, capabilities: await testServer(userId, server) })
      }
      if (action === 'connect' && req.method === 'POST') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server does not exist' })
        const connection = await ensureServerConnected(userId, server)
        return sendJson(res, 200, { ok: true, connected: !!connection, toolCount: connection?.tools?.length || 0 })
      }
      if (action === 'disconnect' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, disconnected: disconnectServer(userId, id) })
      }
      if (req.method === 'DELETE') {
        disconnectServer(userId, id)
        return sendJson(res, 200, { ok: true, ...deleteServer(userId, id) })
      }
      if (req.method === 'GET') {
        if (!server) return sendJson(res, 404, { ok: false, error: 'server does not exist' })
        return sendJson(res, 200, { ok: true, server: publicServer(userId, server) })
      }
    }
    return sendJson(res, 404, { ok: false, error: 'route not found' })
  } catch (error) {
    return sendJson(res, error?.statusCode || 400, {
      ok: false,
      error: error?.message || String(error),
      ...(error?.code ? { code: error.code } : {}),
    })
  }
}

export const _mcpRoutesInternals = {
  directServerOrigin,
  requestOrigin,
}
