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

// SSE: EventSource 原生不支持 header。用 header token 先换一个 60s 一次性 ticket,
// 再用 ?ticket= 连接,避免把 7 天 session token 放 URL query(落日志/Referer/历史)。
export function subscribeToJobEvents(
  onEvent,
  { EventSourceImpl = globalThis.EventSource, fetchImpl = fetch } = {},
) {
  if (!EventSourceImpl) return () => {}
  let stream = null
  let closed = false

  const handler = (event) => {
    try {
      onEvent(JSON.parse(event.data))
    } catch {
      // Ignore malformed events; the stream should keep breathing.
    }
  }

  const connect = (url) => {
    if (closed) return
    stream = new EventSourceImpl(url)
    stream.addEventListener('job_event', handler)
  }

  ;(async () => {
    try {
      const res = await fetchImpl('/api/jobs/stream-ticket', {
        method: 'POST',
        headers: authHeaders(),
      })
      if (res.ok) {
        const { ticket } = await res.json()
        if (ticket) {
          connect(`/api/jobs/stream?ticket=${encodeURIComponent(ticket)}`)
          return
        }
      }
    } catch {
      // 换 ticket 失败 → 退回无 ticket 连接(服务端会用 Authorization 头兜底,浏览器下会 401)
    }
    connect('/api/jobs/stream')
  })()

  return () => {
    closed = true
    if (stream) stream.close()
  }
}

// 给前端 <a href> 下载用 — 拼上 query token 避免 EventSource/<a> 没法带 header 的问题
export function withDownloadToken(url) {
  if (!url) return url
  const token = getAuthToken?.()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
