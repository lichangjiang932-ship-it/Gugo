export const TOKEN_KEY = 'your-model-atelier:auth-token'
let memoryToken = ''

function safeStorage(name) {
  try { return window?.[name] || null } catch { return null }
}

function readToken(storage) {
  try { return storage?.getItem(TOKEN_KEY) || '' } catch { return '' }
}

function writeToken(storage, token) {
  if (!storage) return false
  try {
    if (token) storage?.setItem(TOKEN_KEY, token)
    else storage?.removeItem(TOKEN_KEY)
    return true
  } catch {
    return false
  }
}

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
  return memoryToken
    || readToken(safeStorage('sessionStorage'))
    || readToken(safeStorage('localStorage'))
    || ''
}

export function isLoggedInLocally() {
  return !!getAuthToken()
}

export function setAuthToken(token) {
  if (typeof window === 'undefined') return
  memoryToken = token || ''
  const localStorage = safeStorage('localStorage')
  const sessionStorage = safeStorage('sessionStorage')
  if (token) {
    if (writeToken(localStorage, token)) writeToken(sessionStorage, '')
    else writeToken(sessionStorage, token)
  } else {
    writeToken(localStorage, '')
    writeToken(sessionStorage, '')
  }
}

// A storage event is delivered only to the other tabs. Keep the in-memory
// token in those tabs aligned with localStorage before they re-bootstrap.
export function syncAuthTokenFromStorage(token) {
  if (typeof window === 'undefined') return
  memoryToken = token || ''
  writeToken(safeStorage('localStorage'), token || '')
  writeToken(safeStorage('sessionStorage'), '')
}

export async function bootstrapAuth({ fetchImpl = fetch, signal } = {}) {
  const token = getAuthToken()
  const response = await fetchImpl('/api/auth/bootstrap', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  })
  const data = await parseResponse(response)
  if (data.mode === 'local' && data.authenticated && data.token) {
    setAuthToken(data.token)
  } else if (data.mode === 'multi_user' && !data.authenticated && token) {
    setAuthToken('')
  }
  return data
}

function waitForRetry(delayMs, signal) {
  if (!delayMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function bootstrapAuthWithRetry({
  fetchImpl = fetch,
  signal,
  retryDelays = [0, 250, 750, 2000],
} = {}) {
  let lastError
  for (const delayMs of retryDelays) {
    await waitForRetry(delayMs, signal)
    try {
      return await bootstrapAuth({ fetchImpl, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError || new Error('Authentication bootstrap failed')
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

export async function logoutAccount({ fetchImpl = fetch } = {}) {
  const token = getAuthToken()
  try {
    const response = await fetchImpl('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    return await parseResponse(response)
  } finally {
    setAuthToken('')
  }
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
