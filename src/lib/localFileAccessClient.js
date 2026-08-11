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
    const error = new Error(data?.error?.message || data?.error || `HTTP ${response.status}`)
    error.status = response.status
    error.code = data?.error?.code
    error.path = data?.error?.path
    error.retryable = data?.error?.retryable
    error.hint = data?.error?.hint
    error.suggestGrantPath = data?.error?.suggestGrantPath
    error.requiredAccessMode = data?.error?.requiredAccessMode
    error.locks = data?.error?.locks
    throw error
  }
  return data
}

export async function getLocalFileAccessApi({ signal } = {}) {
  return parse(await fetch('/api/local-files', { headers: authHeaders(), signal }))
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

export async function setWorkspaceTrustApi({ path, trusted }) {
  return parse(await fetch('/api/local-files/workspace-trust', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      path,
      trusted,
      confirmation: trusted ? 'TRUST_WORKSPACE_CONFIG' : undefined,
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

export async function configureWorkspaceOnboardingApi({
  path,
  features,
  approvalMode,
  confirmed,
  bypassConfirmed = false,
}) {
  return parse(await fetch('/api/local-files/onboarding', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      path,
      features,
      approvalMode,
      confirmation: confirmed ? 'ENABLE_WORKSPACE_CAPABILITIES' : undefined,
      bypassConfirmation: bypassConfirmed ? 'BYPASS_ALL_APPROVALS' : undefined,
    }),
  }))
}
