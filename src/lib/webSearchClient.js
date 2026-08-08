import { getAuthToken } from './accountClient.js'

function headers(json = false) {
  const token = getAuthToken?.()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function readResponse(response) {
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || text || `HTTP ${response.status}`)
    error.status = response.status
    error.code = data?.code
    throw error
  }
  return data
}

export async function getWebSearchConfigApi() {
  return readResponse(await fetch('/api/web-search', { headers: headers() }))
}

export async function saveWebSearchConfigApi(payload) {
  return readResponse(await fetch('/api/web-search', {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify(payload),
  }))
}

export async function testWebSearchApi() {
  return readResponse(await fetch('/api/web-search/test', { method: 'POST', headers: headers() }))
}

export async function deleteWebSearchConfigApi() {
  return readResponse(await fetch('/api/web-search', { method: 'DELETE', headers: headers() }))
}
