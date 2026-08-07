import { getAuthToken } from '../../lib/accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function requestHooks(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) } })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

export function createEmptyHook() {
  return { id: '', event: 'pre_tool_use', toolPattern: '*', kind: 'http', url: 'https://', headers: {}, command: [], enabled: true, blocking: true, timeoutMs: 5000 }
}
