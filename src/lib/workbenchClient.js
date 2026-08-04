import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function postJson(url, body = {}, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body || {}),
  })
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `request failed: ${response.status}`)
  }
  return payload
}

export function getWorkbenchStatus(options = {}) {
  return postJson('/api/workbench/git/status', {}, options)
}

export function getWorkbenchDiff(body = {}, options = {}) {
  return postJson('/api/workbench/git/diff', body, options)
}

export function runWorkbenchCheck(check, options = {}) {
  return postJson('/api/workbench/check/run', { check }, options)
}

export function commitWorkbenchChanges({ message, files }, options = {}) {
  return postJson('/api/workbench/git/commit', { message, files }, options)
}

export function pushWorkbenchBranch(options = {}) {
  return postJson('/api/workbench/git/push', {}, options)
}

export async function runWorkbenchTerminal({ command, cwd = '.' }, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/tools/shell/exec', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ command, cwd }),
  })
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) throw new Error(payload?.error || `request failed: ${response.status}`)
  return payload
}
