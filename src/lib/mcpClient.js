/**
 * Feature 1: MCP 前端 REST 客户端
 */
import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonOk(resp) {
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${resp.status}`)
  }
  return data
}

export async function listMcpServersApi() {
  const resp = await fetch('/api/mcp/servers', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function upsertMcpServerApi(payload) {
  const resp = await fetch('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function deleteMcpServerApi(id) {
  const resp = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function testMcpServerApi(id) {
  const resp = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/test`, {
    method: 'POST', headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function connectMcpServerApi(id) {
  const resp = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, {
    method: 'POST', headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function disconnectMcpServerApi(id) {
  const resp = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}/disconnect`, {
    method: 'POST', headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function getMcpCatalogApi() {
  const resp = await fetch('/api/mcp/catalog', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function callMcpToolApi(fullToolName, args) {
  const resp = await fetch('/api/tools/mcp/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ fullToolName, arguments: args || {} }),
  })
  return jsonOk(resp)
}
