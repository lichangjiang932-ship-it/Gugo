import { authHeaders, jsonOk } from './agentClient.js'

export async function recordChatFeedback(value, sessionId) {
  const feedback = String(value || '').trim()
  if (!feedback) return false
  const resp = await fetch('/api/evolution/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ feedback, sessionId: sessionId || null }),
  })
  await jsonOk(resp)
  return true
}

export async function listEvolutionEvidenceApi({ limit = 100 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/evidence?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}
