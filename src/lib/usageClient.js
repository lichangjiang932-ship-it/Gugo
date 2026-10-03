import { getAuthToken } from './accountClient.js'

function headers() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Persisted token usage for the signed-in user.
 *
 * `since` is `yyyy-mm-dd[Thh:mm]` in local time (the server also accepts epoch
 * milliseconds); the server refuses a malformed value instead of silently
 * reading a different window.
 */
export async function getUsageReportApi({ sessionId = '', since = '', limit = 0 } = {}) {
  const search = new URLSearchParams()
  if (sessionId) search.set('sessionId', sessionId)
  if (since) search.set('since', since)
  // No client-side default: the endpoint owns it, so the panel cannot drift from
  // the CLI's window. Only an explicit caller override is sent.
  if (limit) search.set('limit', String(limit))
  const query = search.toString()
  const response = await fetch(`/api/usage/report${query ? `?${query}` : ''}`, { headers: headers() })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || text || `HTTP ${response.status}`)
    error.status = response.status
    error.code = data?.code
    throw error
  }
  return data.report
}
