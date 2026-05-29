/**
 * Mobile Access Key REST 客户端 (Hanako 平行：手机/局域网访问钥匙)
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
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return data
}

export async function listMobileKeysApi() {
  const resp = await fetch('/api/mobile/access-keys', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function createMobileKeyApi({ label = '', ttlMs = null } = {}) {
  const resp = await fetch('/api/mobile/access-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ label, ttlMs }),
  })
  return jsonOk(resp)
}

export async function revokeMobileKeyApi(id) {
  const resp = await fetch(`/api/mobile/access-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

/** 公开端点：用 rawKey 换 token。前端 /mobile.html 用。 */
export async function mobileHandshakeApi(rawKey) {
  const resp = await fetch('/api/mobile/handshake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: rawKey }),
  })
  return jsonOk(resp)
}
