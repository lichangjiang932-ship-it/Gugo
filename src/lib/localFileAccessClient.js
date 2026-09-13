import { getAuthToken } from './accountClient.js'

const LOCAL_FILE_REQUEST_TIMEOUT_MS = 30_000
const NATIVE_DIRECTORY_PICKER_TIMEOUT_MS = 10 * 60_000

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

export async function grantLocalPathApi({ path, accessMode, scope = 'persistent' }, options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/grants', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ path, accessMode, scope }),
  }, options))
}

export async function grantTurnDirectoryApi({
  sessionId, turnId, pausedSequence, path, accessMode, scope = 'session',
}, options = {}) {
  if (![sessionId, turnId].every(value => typeof value === 'string' && value && value === value.trim())
    || !Number.isSafeInteger(pausedSequence) || pausedSequence < 0
    || typeof path !== 'string' || !path.trim()
    || !['read_only', 'read_write'].includes(accessMode) || !['session', 'persistent'].includes(scope)) {
    throw Object.assign(new Error('Directory authorization requires the exact current task and requested access.'), {
      code: 'TURN_DIRECTORY_AUTHORIZATION_INVALID',
    })
  }
  const result = await parse(await fetchWithTimeout('/api/local-files/grants/turn', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ sessionId, turnId, pausedSequence, path, accessMode, scope }),
  }, options))
  const grant = result?.grant
  const prior = result?.preexistingPermission
  const reusedPersistent = scope === 'session' && grant?.scope === 'persistent'
    && prior && typeof prior === 'object' && !Array.isArray(prior)
    && prior.id === grant.id && prior.path === grant.path
    && prior.accessMode === grant.accessMode && prior.scope === 'persistent'
  const matchingScope = grant?.scope === scope || reusedPersistent
  const matchingMode = grant?.accessMode === accessMode
    || (reusedPersistent && accessMode === 'read_only' && grant.accessMode === 'read_write')
  if (result?.ok !== true || result.interaction?.sessionId !== sessionId
    || result.interaction?.turnId !== turnId || result.interaction?.pausedSequence !== pausedSequence
    || result.interaction?.requestedPath !== path.trim() || result.interaction?.canonicalPath !== grant?.path
    || result.interaction?.accessMode !== accessMode || result.interaction?.scope !== scope
    || result.boundary?.type !== 'turn.paused' || result.boundary.sequence !== pausedSequence
    || typeof result.boundary.id !== 'string' || !result.boundary.id
    || !grant || Array.isArray(grant) || !matchingScope
    || typeof grant.id !== 'string' || !grant.id || typeof grant.path !== 'string' || !grant.path
    || grant.resourceType !== 'directory' || !['read_only', 'read_write'].includes(grant.accessMode) || !matchingMode) {
    throw Object.assign(new Error('The directory confirmation did not match the current task. Refresh its state.'), {
      code: 'TURN_DIRECTORY_AUTHORIZATION_RESPONSE_INVALID',
    })
  }
  return result
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

export async function setWorkspaceTrustApi({ path, trusted, scope = 'persistent' }, options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/workspace-trust', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      path,
      trusted,
      scope,
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

export async function selectLocalDirectoryApi(defaultPath = '', options = {}) {
  return parse(await fetchWithTimeout('/api/local-files/select-directory', {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ defaultPath: String(defaultPath || '').trim() }),
  }, {
    ...options,
    timeoutMs: options.timeoutMs ?? NATIVE_DIRECTORY_PICKER_TIMEOUT_MS,
  }))
}

export async function createManagedProjectDirectoryApi(name, options = {}) {
  try {
    return await parse(await fetchWithTimeout('/api/local-files/projects', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ name }),
    }, options))
  } catch (error) {
    if (error?.status === 405) error.code = 'PROJECT_CREATION_RESTART_REQUIRED'
    throw error
  }
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
