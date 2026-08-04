export const TOKEN_KEY = 'your-model-atelier:auth-token'

async function parseResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败：HTTP ${response.status}`)
  }
  return data
}

export function getAuthToken() {
  if (typeof window === 'undefined') return ''
  return window.sessionStorage?.getItem(TOKEN_KEY)
    || window.localStorage.getItem(TOKEN_KEY)
    || ''
}

export function isLoggedInLocally() {
  return !!getAuthToken()
}

export function setAuthToken(token) {
  if (typeof window === 'undefined') return
  if (token) window.localStorage.setItem(TOKEN_KEY, token)
  else {
    window.localStorage.removeItem(TOKEN_KEY)
    window.sessionStorage?.removeItem(TOKEN_KEY)
  }
}

export async function sendLoginCode(email, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/auth/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return parseResponse(response)
}

export async function verifyLoginCode({ email, code, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })
  const data = await parseResponse(response)
  setAuthToken(data.token)
  return data
}

export async function loginWithPassword({ email, password, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/auth/login-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await parseResponse(response)
  setAuthToken(data.token)
  return data
}

export async function setAccountPassword({ currentPassword, newPassword, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/account/password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  return parseResponse(response)
}

export async function removeAccountPassword({ currentPassword, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/account/password', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ currentPassword }),
  })
  return parseResponse(response)
}

export async function getAccount({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/account/me', {
    headers: { Authorization: `Bearer ${getAuthToken()}` },
  })
  return parseResponse(response)
}

export async function recharge(packageId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/billing/recharge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ packageId }),
  })
  return parseResponse(response)
}
