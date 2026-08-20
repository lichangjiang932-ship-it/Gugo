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

export async function getEvolutionDatasetApi({ limit = 200 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/dataset?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function listEvolutionExclusionsApi() {
  const resp = await fetch('/api/evolution/exclusions', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function setEvolutionEvidenceExcludedApi(evidenceId, excluded, reason = null) {
  const resp = await fetch('/api/evolution/exclusions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ evidenceId, excluded, reason }),
  })
  return jsonOk(resp)
}

export async function generateEvolutionCandidateApi(input) {
  const resp = await fetch('/api/evolution/candidates/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionCandidatesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/candidates?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionCandidateApi(id) {
  const resp = await fetch(`/api/evolution/candidates/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function createEvolutionReplaySuiteApi(input) {
  const resp = await fetch('/api/evolution/replay-suites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionReplaySuitesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/replay-suites?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function runEvolutionReplayApi(input) {
  const resp = await fetch('/api/evolution/replays/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionReplayRunsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/replays?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionReplayRunApi(id) {
  const resp = await fetch(`/api/evolution/replays/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function evaluateEvolutionReplayApi(replayId) {
  const resp = await fetch('/api/evolution/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ replayId }),
  })
  return jsonOk(resp)
}

export async function listEvolutionEvaluationsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/evaluations?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionEvaluationApi(id) {
  const resp = await fetch(`/api/evolution/evaluations/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}
