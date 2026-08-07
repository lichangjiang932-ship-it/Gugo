import { getAuthToken } from '../accountClient.js'

export async function parseProxyResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `\u672c\u5730\u6a21\u578b\u4ee3\u7406\u8bf7\u6c42\u5931\u8d25\uff1aHTTP ${response.status}`)
  }

  return data
}

export function authHeaders() {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

