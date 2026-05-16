async function readJsonResponse(responsePromise) {
  const response = await responsePromise
  if (!response.ok) {
    let payload = null
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
  return readJsonResponse(fetchImpl('/api/skills'))
}

export function importSkillPack(files, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }))
}

