// ★ U1: 集成 UI + 视觉副驾 UI
import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function qs(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value)
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

async function jsonOk(res) {
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error || text || `HTTP ${res.status}`)
    err.status = res.status
    if (data?.code) err.code = data.code
    throw err
  }
  return data
}

export async function listProvidersApi() {
  const resp = await fetch('/api/integrations/providers', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function listIntegrationsApi({ kind } = {}) {
  const resp = await fetch(`/api/integrations${qs({ kind })}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function upsertIntegrationApi({ id, provider, name, config, secret, enabled }) {
  const hasId = Boolean(id)
  const resp = await fetch(hasId ? `/api/integrations/${encodeURIComponent(id)}` : '/api/integrations', {
    method: hasId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider, name, config, secret, enabled }),
  })
  return jsonOk(resp)
}

export async function deleteIntegrationApi(id) {
  const resp = await fetch(`/api/integrations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function testIntegrationApi(id) {
  const resp = await fetch(`/api/integrations/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function toggleIntegrationEnabledApi(id, enabled) {
  const resp = await fetch(`/api/integrations/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ enabled }),
  })
  return jsonOk(resp)
}

export async function listIntegrationOAuthProvidersApi() {
  const resp = await fetch('/api/integrations/oauth/providers', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function startIntegrationOAuthApi({ provider, integrationId } = {}) {
  const resp = await fetch('/api/integrations/oauth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider, integrationId }),
  })
  return jsonOk(resp)
}

export async function getIntegrationOAuthStatusApi(sessionId) {
  const resp = await fetch(`/api/integrations/oauth/sessions/${encodeURIComponent(sessionId)}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function connectBrowserAppApi(provider) {
  const resp = await fetch('/api/connectors/apps/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider }),
  })
  return jsonOk(resp)
}

export async function openConnectedBrowserAppApi(provider) {
  const resp = await fetch('/api/connectors/apps/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider }),
  })
  return jsonOk(resp)
}

export async function getWechatQrcodeApi() {
  const resp = await fetch('/api/bridge/wechat/qrcode', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function pollWechatQrcodeApi({ qrcodeId, integrationId, name, defaultAgentId } = {}) {
  const resp = await fetch('/api/bridge/wechat/qrcode/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ qrcodeId, integrationId, name, defaultAgentId }),
  })
  return jsonOk(resp)
}

export async function getBridgeStatusApi() {
  const resp = await fetch('/api/bridge/status', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function listParkedBridgeMessagesApi({ status = 'parked', limit } = {}) {
  const resp = await fetch(`/api/bridge/parked${qs({ status, limit })}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function allowParkedBridgeMessageApi(id) {
  const resp = await fetch(`/api/bridge/parked/${encodeURIComponent(id)}/allow`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function rejectParkedBridgeMessageApi(id) {
  const resp = await fetch(`/api/bridge/parked/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

// 视觉副驾就绪探针：configured 只反映当前用户保存并启用的完整 BYOK 配置。
export async function fetchVisionAssistStatus() {
  const resp = await fetch('/api/integrations/vision_assist/status', { headers: authHeaders() })
  return jsonOk(resp)
}
