import { getAuthToken } from './accountClient.js'

async function authedJson(url, body, { fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.ok === false) {
    const structured = data?.error && typeof data.error === 'object' ? data.error : null
    const error = new Error(
      structured?.message
      || (typeof data?.error === 'string' ? data.error : '')
      || `HTTP ${resp.status}`,
    )
    error.statusCode = Number(resp.status) || 0
    error.code = String(structured?.code || data?.code || '').trim() || undefined
    error.action = String(structured?.action || '').trim() || undefined
    error.providerId = structured?.providerId ?? null
    error.modelName = structured?.modelName ?? null
    error.configRevision = structured?.configRevision ?? null
    error.details = structured?.details ?? structured ?? data
    throw error
  }
  return data
}

export function compressSession({
  sessionId,
  messages,
  keepMessages,
  semantic = true,
  modelName,
  modelProviderId,
  modelConfigRevision,
  fetchImpl = fetch,
}) {
  const selectedModel = String(modelName || '').trim()
  const selectedProviderId = String(modelProviderId || '').trim()
  const selectedRevision = Number(modelConfigRevision)
  return authedJson('/api/compaction/compress', {
    sessionId,
    messages,
    keepMessages,
    semantic,
    ...(selectedModel ? { modelName: selectedModel } : {}),
    ...(selectedProviderId ? { modelProviderId: selectedProviderId } : {}),
    ...(Number.isInteger(selectedRevision) && selectedRevision > 0
      ? { modelConfigRevision: selectedRevision }
      : {}),
  }, { fetchImpl })
}

export async function fetchCompactionArchive(id) {
  const headers = {}
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(`/api/compaction/archive/${encodeURIComponent(id)}`, { headers })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`)
  return data.archive
}
