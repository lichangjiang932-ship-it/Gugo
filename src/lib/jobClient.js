import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readJsonResponse(responsePromise) {
  const response = await responsePromise
  if (!response.ok) {
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    throw new Error(payload?.error || `request failed: ${response.status}`)
  }
  return response.json()
}

export function createJob(prompt, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ prompt }),
  }))
}

export function listJobs({ fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/jobs', { headers: authHeaders() }))
}

export function getJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  }))
}

export function cancelJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

export function steerJob(jobId, content, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content }),
  }))
}

export function approveJobPlan(jobId, { steps = null, fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/plan/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ steps }),
  }))
}

export function retryJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

export function retryStep(jobId, stepId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/retry`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

function authenticatedArtifactUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('artifact URL is required')
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  if (parsed.origin !== baseOrigin || !parsed.pathname.startsWith('/api/artifacts/')) {
    throw new Error('artifact preview URL must be same-origin')
  }
  parsed.searchParams.delete('token')
  parsed.searchParams.set('preview', '1')
  return `${parsed.pathname}${parsed.search}`
}

export async function loadArtifactPreviewHtml(url, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(authenticatedArtifactUrl(url), {
    headers: authHeaders(),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`artifact preview request failed: ${response.status}`)
  return response.text()
}

// EventSource cannot send Authorization headers. Exchange the session token for
// a short-lived, one-time ticket and get a fresh ticket after every disconnect.
export function subscribeToJobEvents(
  onEvent,
  {
    EventSourceImpl = globalThis.EventSource,
    fetchImpl = fetch,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    retryBaseMs = 1_000,
    retryMaxMs = 15_000,
    onConnectionChange = () => {},
  } = {},
) {
  if (!EventSourceImpl) return () => {}
  let stream = null
  let closed = false
  let retryTimer = null
  let retryAttempt = 0

  const reportConnection = (state, detail = {}) => {
    try {
      onConnectionChange({ state, ...detail })
    } catch {
      // Connection reporting must never break the stream lifecycle.
    }
  }

  const handler = (event) => {
    try {
      onEvent(JSON.parse(event.data))
    } catch {
      // Ignore malformed events; the stream should keep breathing.
    }
  }

  const scheduleReconnect = () => {
    if (closed || retryTimer != null) return
    if (stream) {
      stream.close()
      stream = null
    }
    const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** retryAttempt))
    retryAttempt += 1
    reportConnection('retrying', { delay })
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  const openStream = (url) => {
    if (closed) return
    const nextStream = new EventSourceImpl(url)
    stream = nextStream
    nextStream.addEventListener('ready', () => {
      if (closed || stream !== nextStream) return
      retryAttempt = 0
      reportConnection('open')
    })
    nextStream.addEventListener('job_event', handler)
    nextStream.addEventListener('error', () => {
      if (closed || stream !== nextStream) return
      scheduleReconnect()
    })
  }

  const connect = async () => {
    if (closed) return
    reportConnection('connecting')
    try {
      const response = await fetchImpl('/api/jobs/stream-ticket', {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(`stream ticket request failed: ${response.status}`)
      const { ticket } = await response.json()
      if (!ticket) throw new Error('stream ticket missing')
      openStream(`/api/jobs/stream?ticket=${encodeURIComponent(ticket)}`)
    } catch {
      scheduleReconnect()
    }
  }

  connect()

  return () => {
    closed = true
    if (retryTimer != null) clearTimeoutImpl(retryTimer)
    retryTimer = null
    if (stream) stream.close()
    stream = null
    reportConnection('closed')
  }
}

// Append the auth token for browser download links, which cannot carry headers.
export function withDownloadToken(url) {
  if (!url) return url
  const token = getAuthToken?.()
  if (!token) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}token=${encodeURIComponent(token)}`
}
