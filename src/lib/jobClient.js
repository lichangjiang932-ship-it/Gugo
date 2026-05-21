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

// SSE: EventSource 原生不支持 header,走 query token 兜底
// 服务端 SSE 路由 /api/jobs/stream 同时接受 Bearer header 和 ?token=
export function subscribeToJobEvents(onEvent, { EventSourceImpl = globalThis.EventSource } = {}) {
  if (!EventSourceImpl) return () => {}
  const token = getAuthToken?.()
  const url = token ? `/api/jobs/stream?token=${encodeURIComponent(token)}` : '/api/jobs/stream'
  const stream = new EventSourceImpl(url)
  const handler = (event) => {
    try {
      onEvent(JSON.parse(event.data))
    } catch {
      // Ignore malformed events; the stream should keep breathing.
    }
  }
  stream.addEventListener('job_event', handler)
  return () => stream.close()
}

// 给前端 <a href> 下载用 — 拼上 query token 避免 EventSource/<a> 没法带 header 的问题
export function withDownloadToken(url) {
  if (!url) return url
  const token = getAuthToken?.()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
