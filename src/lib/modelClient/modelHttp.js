import { getAuthToken } from '../accountClient.js'

export async function parseProxyResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || data?.ok === false) {
    const payload = data?.error
    const message = payload && typeof payload === 'object'
      ? payload.message
      : payload
    const error = new Error(message || data?.message || `\u672c\u5730\u6a21\u578b\u4ee3\u7406\u8bf7\u6c42\u5931\u8d25\uff1aHTTP ${response.status}`)
    const code = payload && typeof payload === 'object' ? payload.code : data?.code
    if (code) error.code = String(code)
    error.status = response.status
    error.payload = data
    throw error
  }

  return data
}

export function authHeaders() {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

