import { authHeaders } from './agentClient.js'

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

export function listSkills({ fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills', { headers: authHeaders() }))
}

export function importSkillPack(files, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills/import', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }))
}

export function importSkillFromGithubUrl(url, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills/import-github', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }))
}
