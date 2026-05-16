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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  }))
}

export function listJobs({ fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/jobs'))
}

export function getJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}`))
}

export function cancelJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  }))
}

export function retryJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
  }))
}

export function retryStep(jobId, stepId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/retry`, {
    method: 'POST',
  }))
}

export function subscribeToJobEvents(onEvent, { EventSourceImpl = globalThis.EventSource } = {}) {
  if (!EventSourceImpl) return () => {}
  const stream = new EventSourceImpl('/api/jobs/stream')
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
