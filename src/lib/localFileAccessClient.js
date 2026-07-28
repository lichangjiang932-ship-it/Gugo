import { getAuthToken } from './accountClient.js'

function authHeaders(json = false) {
  const token = getAuthToken?.()
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function parse(response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`)
  }
  return data
}

export async function getLocalFileAccessApi() {
  return parse(await fetch('/api/local-files', { headers: authHeaders() }))
}

export async function grantLocalPathApi({ path, accessMode }) {
  return parse(await fetch('/api/local-files/grants', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ path, accessMode }),
  }))
}

export async function revokeLocalPathApi(id) {
  return parse(await fetch(`/api/local-files/grants/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }))
}

export async function setAllFilesAccessApi(enabled) {
  return parse(await fetch('/api/local-files/all-access', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      enabled,
      confirmation: enabled ? 'ALLOW_ALL_LOCAL_FILES' : undefined,
    }),
  }))
}

export async function pickLocalDirectoryApi() {
  return parse(await fetch('/api/local-files/pick-directory', {
    method: 'POST',
    headers: authHeaders(true),
    body: '{}',
  }))
}
