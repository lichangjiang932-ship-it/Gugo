import { authHeaders } from './agentClient.js'

export async function transcribeRecordedAudio(blob, { language, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams()
  if (language) params.set('language', language.split('-')[0])
  const response = await fetchImpl(`/api/media/transcribe?${params}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`)
  return String(payload?.text || '')
}
