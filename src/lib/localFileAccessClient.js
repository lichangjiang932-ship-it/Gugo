import { getAuthToken } from './accountClient.js'

const LOCAL_FILE_REQUEST_TIMEOUT_MS = 30_000

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

async function fetchWithTimeout(url, init = {}, { signal, timeoutMs = LOCAL_FILE_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener?.('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1, Number(timeoutMs) || LOCAL_FILE_REQUEST_TIMEOUT_MS))
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (!timedOut) throw error
    const timeoutError = new Error('Directory authorization timed out. Please retry.')
    timeoutError.code = 'LOCAL_FILE_REQUEST_TIMEOUT'
    timeoutError.retryable = true
    throw timeoutError
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forwardAbort)
  }
}

export async function getLocalFileAccessApi({ signal } = {}) {
  return parse(await fetch('/api/local-files', { headers: authHeaders(), signal }))
}

export async function grantLocalPathApi({ path, accessMode }, options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/grants', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ path, accessMode }),
  }, options))
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

export async function setWorkspaceTrustApi({ path, trusted }, options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/workspace-trust', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      path,
      trusted,
      confirmation: trusted ? 'TRUST_WORKSPACE_CONFIG' : undefined,
    }),
  }, options))
}

export async function browseLocalDirectoriesApi(path = '', options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/browse-directories', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ path }),
  }, options))
}

export async function setDefaultOutputDirectoryApi(path, options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/default-output-directory', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ path }),
  }, options))
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
