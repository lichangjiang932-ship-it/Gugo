import { getAuthToken } from './accountClient.js'
import { translateKey } from '../i18n/translations.js'

function currentLanguage() {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage?.getItem('lang') || undefined
  } catch {
    return undefined
  }
}

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readJsonResponse(responsePromise) {
  const response = await responsePromise
  if (!response.ok) {
    let payload
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const structured = payload?.error && typeof payload.error === 'object'
      ? payload.error
      : null
    const message = structured?.message
      || (typeof payload?.error === 'string' ? payload.error : '')
      || `request failed: ${response.status}`
    const error = new Error(message)
    error.statusCode = Number(response.status) || 0
    error.code = String(structured?.code || payload?.code || '').trim() || undefined
    error.action = String(structured?.action || '').trim() || undefined
    error.providerId = structured?.providerId ?? null
    error.modelName = structured?.modelName ?? null
    error.configRevision = structured?.configRevision ?? null
    for (const field of [
      'recoveryKind',
      'modelRequestId',
      'stepId',
      'targetProviderId',
      'targetModelName',
      'targetConfigRevision',
      'unsafeToReplay',
      'requiresUserVerification',
    ]) {
      const value = structured && Object.hasOwn(structured, field)
        ? structured[field]
        : payload?.[field]
      if (value !== undefined) error[field] = value
    }
    error.details = structured?.details ?? structured ?? payload
    throw error
  }
  return response.json()
}

export function createJob(prompt, {
  fetchImpl = fetch,
  requirePlanApproval = false,
  autoRetry = false,
  modelName,
  providerId,
} = {}) {
  const selectedModel = String(modelName || '').trim()
  const selectedProvider = String(providerId || '').trim()
  return readJsonResponse(fetchImpl('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      prompt,
      ...(requirePlanApproval === true ? { requirePlanApproval: true } : {}),
      ...(autoRetry === true ? { autoRetry: true } : {}),
      ...(selectedModel ? { modelName: selectedModel } : {}),
      ...(selectedProvider ? { providerId: selectedProvider } : {}),
    }),
  }))
}

export function listJobs({ fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl('/api/jobs', { headers: authHeaders() }))
}

export function getJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  }))
}

export function cancelJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

export function steerJob(jobId, content, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content }),
  }))
}

export function resumeJobDirectoryAuthorization(jobId, {
  path,
  accessMode,
  fetchImpl = fetch,
} = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/directory-authorization/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path, accessMode }),
  }))
}

export function approveJobPlan(jobId, { steps = null, fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/plan/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ steps }),
  }))
}

export function retryJob(jobId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

export function retryStep(jobId, stepId, { fetchImpl = fetch } = {}) {
  return readJsonResponse(fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(stepId)}/retry`, {
    method: 'POST',
    headers: authHeaders(),
  }))
}

function authenticatedArtifactUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('artifact URL is required')
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  if (parsed.origin !== baseOrigin || !parsed.pathname.startsWith('/api/artifacts/')) {
    throw new Error('artifact preview URL must be same-origin')
  }
  parsed.searchParams.delete('token')
  parsed.searchParams.set('preview', '1')
  return `${parsed.pathname}${parsed.search}`
}

export async function loadArtifactPreviewHtml(url, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(authenticatedArtifactUrl(url), {
    headers: authHeaders(),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`artifact preview request failed: ${response.status}`)
  return response.text()
}

const MANAGED_HTML_ASSET_URI = /gugo-asset:\/\/([A-Za-z0-9_-]{1,64})/g

async function blobToEmbeddedDataUrl(blob) {
  const mimeType = String(blob?.type || 'application/octet-stream')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // Avoid overflowing Function argument/string limits for large background
  // images while keeping the result usable by an opaque-origin srcDoc frame.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return `data:${mimeType};base64,${globalThis.btoa(binary)}`
}

/**
 * Load an authenticated managed HTML preview and replace its private asset
 * markers with self-contained browser URLs. Session credentials stay in the
 * parent application and are never exposed to the sandboxed document.
 */
export async function loadArtifactPreviewDocument(url, {
  fetchImpl = fetch,
  signal,
  // Blob URLs created by the parent are not reliably readable from a
  // sandboxed srcDoc frame because that frame has an opaque origin/storage
  // partition. Embed assets by default so the side preview matches the
  // downloaded standalone HTML without granting allow-same-origin.
  createAssetUrl = blobToEmbeddedDataUrl,
  // Kept for callers/tests that explicitly manage short-lived object URLs.
  createObjectUrl,
} = {}) {
  const previewUrl = authenticatedArtifactUrl(url)
  const response = await fetchImpl(previewUrl, {
    headers: authHeaders(),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`artifact preview request failed: ${response.status}`)
  let html = await response.text()
  const assetIds = [...new Set([...html.matchAll(MANAGED_HTML_ASSET_URI)].map((match) => match[1]))]
  MANAGED_HTML_ASSET_URI.lastIndex = 0
  if (assetIds.length === 0) return { html, objectUrls: [] }

  const parsed = new URL(previewUrl, globalThis.location?.origin || 'http://localhost')
  const assetBase = parsed.pathname.replace(/\/$/, '')
  const objectUrls = []
  try {
    for (const id of assetIds) {
      const assetResponse = await fetchImpl(`${assetBase}/assets/${encodeURIComponent(id)}`, {
        headers: authHeaders(),
        credentials: 'same-origin',
        signal,
      })
      if (!assetResponse.ok) throw new Error(`artifact asset preview request failed: ${assetResponse.status}`)
      const assetBlob = await assetResponse.blob()
      const assetUrl = await (createObjectUrl || createAssetUrl)(assetBlob)
      if (String(assetUrl).startsWith('blob:')) objectUrls.push(assetUrl)
      html = html.replaceAll(`gugo-asset://${id}`, assetUrl)
    }
    return { html, objectUrls }
  } catch (error) {
    for (const objectUrl of objectUrls) URL.revokeObjectURL?.(objectUrl)
    throw error
  }
}

function artifactHtmlPreviewSessionRequestUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('artifact URL is required')
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  if (parsed.origin !== baseOrigin || !/^\/api\/artifacts\/[^/]+\/?$/.test(parsed.pathname)) {
    throw new Error('artifact HTML preview URL must be same-origin')
  }
  parsed.searchParams.delete('preview')
  parsed.searchParams.delete('token')
  const artifactPath = parsed.pathname.replace(/\/$/, '')
  return `${artifactPath}/preview-session${parsed.search}`
}

export async function createArtifactHtmlPreviewSession(url, {
  fetchImpl = fetch,
  signal,
} = {}) {
  const response = await fetchImpl(artifactHtmlPreviewSessionRequestUrl(url), {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    throw await structuredPreviewSessionError(response, 'artifact HTML preview session request failed')
  }
  const payload = await response.json()
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const previewUrl = new URL(String(payload?.url || ''), baseOrigin)
  if (previewUrl.origin !== baseOrigin || !/^\/api\/artifacts\/previews\/[^/]+\/.+/.test(previewUrl.pathname)) {
    throw new Error('artifact HTML preview session returned an invalid URL')
  }
  return `${previewUrl.pathname}${previewUrl.search}`
}

export async function revokeArtifactHtmlPreviewSession(url, { fetchImpl = fetch } = {}) {
  const raw = String(url || '').trim()
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  const match = parsed.pathname.match(/^\/api\/artifacts\/previews\/([^/]+)(?:\/.*)?$/)
  if (parsed.origin !== baseOrigin || !match) {
    throw new Error('artifact HTML preview URL must be same-origin')
  }
  const response = await fetchImpl(`/api/artifacts/previews/${match[1]}`, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'same-origin',
    keepalive: true,
  })
  if (!response.ok) throw new Error(`artifact HTML preview revoke failed: ${response.status}`)
}

function controlledHtmlPreviewUrl(value) {
  const raw = String(value || '').trim()
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  const controlledPath = /^\/api\/artifacts\/previews\/[^/]+\/index\.html$/.test(parsed.pathname)
    || /^\/api\/local-files\/previews\/[^/]+\/[^/]+$/.test(parsed.pathname)
  if (parsed.origin !== baseOrigin || !controlledPath) {
    const error = new Error('HTML preview probe URL must be a controlled same-origin session URL')
    error.code = 'HTML_PREVIEW_SESSION_URL_INVALID'
    throw error
  }
  return `${parsed.pathname}${parsed.search}`
}

/**
 * Verify a capability-scoped HTML document before mounting it in an iframe.
 * iframe load events do not expose HTTP 401/403/404/5xx responses, so they
 * cannot distinguish the real document from a server-generated error page.
 */
export async function probeHtmlPreviewSession(url, { fetchImpl = fetch, signal } = {}) {
  const requestUrl = controlledHtmlPreviewUrl(url)
  const response = await fetchImpl(requestUrl, {
    method: 'HEAD',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (response.ok) return requestUrl
  const error = new Error(`HTML preview session is unavailable: ${response.status}`)
  error.statusCode = Number(response.status) || 0
  error.code = 'HTML_PREVIEW_SESSION_UNAVAILABLE'
  throw error
}

function waitForPreviewRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, Number(delayMs) || 0))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function structuredPreviewSessionError(response, fallbackLabel = 'local HTML preview session request failed') {
  const status = Number(response?.status) || 0
  let payload = null
  try {
    if (typeof response?.json === 'function') payload = await response.json()
  } catch {
    payload = null
  }
  const details = payload?.error && typeof payload.error === 'object'
    ? payload.error
    : payload && typeof payload === 'object' ? payload : null
  const error = new Error(
    String(details?.message || '').trim()
      || `${fallbackLabel}: ${status}`,
  )
  error.statusCode = status
  error.code = String(details?.code || '').trim() || 'LOCAL_HTML_PREVIEW_SESSION_FAILED'
  if (details?.hint) error.hint = String(details.hint)
  if (details?.path) error.path = String(details.path)
  error.details = details
  return error
}

async function previewSessionCompatibilityError({ fetchImpl, signal, response }) {
  const status = Number(response?.status) || 0
  if (status !== 405) {
    return structuredPreviewSessionError(response)
  }
  try {
    const response = await fetchImpl('/api/health', {
      method: 'GET',
      credentials: 'same-origin',
      signal,
    })
    const health = response.ok ? await response.json() : null
    if (Number(health?.capabilities?.localHtmlPreviewSession || 0) < 1) {
      const error = new Error(translateKey('chatPreview.localHtmlRuntimeMismatch', currentLanguage()))
      error.statusCode = status
      error.code = 'LOCAL_HTML_PREVIEW_RUNTIME_MISMATCH'
      return error
    }
  } catch (cause) {
    if (signal?.aborted) throw cause
  }
  const error = new Error(translateKey('chatPreview.localHtmlRouteUnavailable', currentLanguage()))
  error.statusCode = status
  error.code = 'LOCAL_HTML_PREVIEW_ROUTE_UNAVAILABLE'
  return error
}

export async function createLocalHtmlPreviewSession(url, {
  fetchImpl = fetch,
  signal,
  retryDelays = [],
} = {}) {
  const raw = String(url || '').trim()
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  const match = parsed.pathname.match(/^\/api\/local-files\/(?:verified|retained)\/([^/]+)\/?$/)
  if (parsed.origin !== baseOrigin || !match) {
    throw new Error('local receipt HTML preview URL must be same-origin')
  }
  parsed.searchParams.delete('preview')
  parsed.searchParams.delete('token')
  const receiptPath = parsed.pathname.replace(/\/$/, '')
  const requestUrl = `${receiptPath}/preview-session${parsed.search}`
  const request = () => fetchImpl(requestUrl, {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'same-origin',
    signal,
  })
  let response = await request()
  // Tests and explicitly coordinated restart flows may opt into bounded
  // retries. The UI does not blindly replay a deterministic route mismatch:
  // it probes runtime capability below and exposes an in-place retry instead.
  for (const delay of Array.isArray(retryDelays) ? retryDelays : []) {
    if (response.status !== 405) break
    await waitForPreviewRetry(delay, signal)
    response = await request()
  }
  if (!response.ok) throw await previewSessionCompatibilityError({ fetchImpl, signal, response })
  const payload = await response.json()
  const previewUrl = new URL(String(payload?.url || ''), baseOrigin)
  if (previewUrl.origin !== baseOrigin || !previewUrl.pathname.startsWith('/api/local-files/previews/')) {
    throw new Error('local HTML preview session returned an invalid URL')
  }
  return `${previewUrl.pathname}${previewUrl.search}`
}

export async function revokeLocalHtmlPreviewSession(url, { fetchImpl = fetch } = {}) {
  const raw = String(url || '').trim()
  const baseOrigin = globalThis.location?.origin || 'http://localhost'
  const parsed = new URL(raw, baseOrigin)
  const match = parsed.pathname.match(/^\/api\/local-files\/previews\/([^/]+)(?:\/.*)?$/)
  if (parsed.origin !== baseOrigin || !match) {
    throw new Error('local HTML preview URL must be same-origin')
  }
  const response = await fetchImpl(`/api/local-files/previews/${match[1]}`, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'same-origin',
    keepalive: true,
  })
  if (!response.ok) throw new Error(`local HTML preview revoke failed: ${response.status}`)
}

// EventSource cannot send Authorization headers. Exchange the session token for
// a short-lived, one-time ticket and get a fresh ticket after every disconnect.
export function subscribeToJobEvents(
  onEvent,
  {
    EventSourceImpl = globalThis.EventSource,
    fetchImpl = fetch,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    retryBaseMs = 1_000,
    retryMaxMs = 15_000,
    onConnectionChange = () => {},
  } = {},
) {
  if (!EventSourceImpl) return () => {}
  let stream = null
  let closed = false
  let retryTimer = null
  let retryAttempt = 0

  const reportConnection = (state, detail = {}) => {
    try {
      onConnectionChange({ state, ...detail })
    } catch {
      // Connection reporting must never break the stream lifecycle.
    }
  }

  const handler = (event) => {
    try {
      onEvent(JSON.parse(event.data))
    } catch {
      // Ignore malformed events; the stream should keep breathing.
    }
  }

  const scheduleReconnect = () => {
    if (closed || retryTimer != null) return
    if (stream) {
      stream.close()
      stream = null
    }
    const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** retryAttempt))
    retryAttempt += 1
    reportConnection('retrying', { delay })
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  const openStream = (url) => {
    if (closed) return
    const nextStream = new EventSourceImpl(url)
    stream = nextStream
    nextStream.addEventListener('ready', () => {
      if (closed || stream !== nextStream) return
      retryAttempt = 0
      reportConnection('open')
    })
    nextStream.addEventListener('job_event', handler)
    nextStream.addEventListener('error', () => {
      if (closed || stream !== nextStream) return
      scheduleReconnect()
    })
  }

  const connect = async () => {
    if (closed) return
    reportConnection('connecting')
    try {
      const response = await fetchImpl('/api/jobs/stream-ticket', {
        method: 'POST',
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(`stream ticket request failed: ${response.status}`)
      const { ticket } = await response.json()
      if (!ticket) throw new Error('stream ticket missing')
      openStream(`/api/jobs/stream?ticket=${encodeURIComponent(ticket)}`)
    } catch {
      scheduleReconnect()
    }
  }

  connect()

  return () => {
    closed = true
    if (retryTimer != null) clearTimeoutImpl(retryTimer)
    retryTimer = null
    if (stream) stream.close()
    stream = null
    reportConnection('closed')
  }
}

function isTrustedDownloadUrl(value) {
  const raw = String(value || '').trim()
  if (!raw || /^(?:data|blob):/i.test(raw)) return false
  if (raw.startsWith('//')) return false
  if (/^\/api(?:\/|[?#]|$)/.test(raw)) return true
  if (typeof window === 'undefined' || !window.location?.origin) return false
  try {
    const parsed = new URL(raw, window.location.origin)
    return parsed.origin === window.location.origin
      && /^\/api(?:\/|$)/.test(parsed.pathname)
  } catch {
    return false
  }
}

// Browser download links cannot carry headers. Limit the query credential to
// the authenticated same-origin API so external previews can never receive it.
export function withDownloadToken(url) {
  if (!url) return url
  if (!isTrustedDownloadUrl(url)) return url
  const token = getAuthToken?.()
  if (!token) return url
  const hashIndex = url.indexOf('#')
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}token=${encodeURIComponent(token)}${hash}`
}
