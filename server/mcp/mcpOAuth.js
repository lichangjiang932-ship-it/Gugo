import crypto from 'node:crypto'
import { getServer } from './mcpStore.js'
import {
  deleteMcpOAuthCredential,
  getMcpOAuthCredential,
  getMcpOAuthStatus,
  upsertMcpOAuthCredential,
} from './mcpOAuthStore.js'
import {
  consumeMcpOAuthPendingAuthorization,
  saveMcpOAuthPendingAuthorization,
} from './mcpOAuthPendingStore.js'

const PENDING_TTL_MS = 10 * 60 * 1000
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000
const refreshPromises = new Map()

function oauthError(message, code, statusCode = 400, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  return error
}

function isLoopbackUrl(url) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
}

function assertSafeOAuthUrl(raw, label) {
  let url
  try { url = new URL(String(raw || '')) } catch {
    throw oauthError(`${label} URL is invalid`, 'MCP_OAUTH_URL_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw oauthError(`${label} URL must use HTTP or HTTPS`, 'MCP_OAUTH_URL_INVALID')
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !isLoopbackUrl(url)) {
    throw oauthError(`${label} URL must use HTTPS in production`, 'MCP_OAUTH_HTTPS_REQUIRED')
  }
  return url.toString()
}

function splitScopes(value) {
  if (Array.isArray(value)) return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
  return [...new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
}

function wellKnownUrl(base, name) {
  const url = new URL(base)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  return `${url.origin}/.well-known/${name}${path}`
}

async function fetchJson(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let data = null
    try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON metadata is unusable */ }
    return { response, data }
  } finally {
    clearTimeout(timer)
  }
}

function resourceMetadataFromChallenge(header) {
  const match = String(header || '').match(/resource_metadata=(?:"([^"]+)"|([^,\s]+))/i)
  return match?.[1] || match?.[2] || ''
}

async function discoverProtectedResource(serverUrl, fetchImpl) {
  const candidates = [
    wellKnownUrl(serverUrl, 'oauth-protected-resource'),
    `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`,
  ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      const { response, data } = await fetchJson(candidate, {
        headers: { Accept: 'application/json' },
      }, fetchImpl)
      if (response.ok && data) return { metadata: data, metadataUrl: candidate }
    } catch { /* try the next discovery form */ }
  }
  try {
    const response = await fetchImpl(serverUrl, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream' },
    })
    const metadataUrl = resourceMetadataFromChallenge(response.headers.get('www-authenticate'))
    if (metadataUrl) {
      const safeUrl = assertSafeOAuthUrl(metadataUrl, 'Protected resource metadata')
      const discovered = await fetchJson(safeUrl, { headers: { Accept: 'application/json' } }, fetchImpl)
      if (discovered.response.ok && discovered.data) return { metadata: discovered.data, metadataUrl: safeUrl }
    }
  } catch { /* caller reports a useful discovery error below */ }
  return { metadata: {}, metadataUrl: '' }
}

async function discoverAuthorizationServer(issuer, fetchImpl) {
  const candidates = [
    wellKnownUrl(issuer, 'oauth-authorization-server'),
    wellKnownUrl(issuer, 'openid-configuration'),
  ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      const { response, data } = await fetchJson(candidate, {
        headers: { Accept: 'application/json' },
      }, fetchImpl)
      if (response.ok && data?.authorization_endpoint && data?.token_endpoint) return data
    } catch { /* try the next metadata endpoint */ }
  }
  return {}
}

async function registerClient({ registrationEndpoint, redirectUri, scopes, fetchImpl }) {
  const { response, data } = await fetchJson(assertSafeOAuthUrl(registrationEndpoint, 'Registration'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Gugo',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    }),
  }, fetchImpl)
  if (!response.ok || !data?.client_id) {
    throw oauthError(
      data?.error_description || data?.error || `Dynamic client registration failed (HTTP ${response.status})`,
      'MCP_OAUTH_REGISTRATION_FAILED',
    )
  }
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret || '',
    tokenAuthMethod: data.token_endpoint_auth_method || (data.client_secret ? 'client_secret_basic' : 'none'),
  }
}

function tokenRequestHeaders(credentials, metadata) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (credentials.clientSecret && metadata.tokenAuthMethod !== 'client_secret_post') {
    headers.Authorization = `Basic ${Buffer.from(`${metadata.clientId}:${credentials.clientSecret}`).toString('base64')}`
  }
  return headers
}

async function requestToken({ metadata, credentials, params, fetchImpl = fetch }) {
  const body = new URLSearchParams(params)
  if (credentials.clientSecret && metadata.tokenAuthMethod === 'client_secret_post') {
    body.set('client_id', metadata.clientId)
    body.set('client_secret', credentials.clientSecret)
  } else if (!credentials.clientSecret) {
    body.set('client_id', metadata.clientId)
  }
  const { response, data } = await fetchJson(assertSafeOAuthUrl(metadata.tokenEndpoint, 'Token'), {
    method: 'POST',
    headers: tokenRequestHeaders(credentials, metadata),
    body,
  }, fetchImpl)
  if (!response.ok || !data?.access_token) {
    throw oauthError(
      data?.error_description || data?.error || `Token request failed (HTTP ${response.status})`,
      'MCP_OAUTH_TOKEN_FAILED',
      400,
    )
  }
  return data
}

function tokenExpiry(token, now = Date.now()) {
  const seconds = Number(token?.expires_in)
  return Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null
}

export async function beginMcpOAuth({
  userId,
  serverId,
  redirectUri,
  config = {},
  fetchImpl = fetch,
}) {
  const server = getServer(userId, serverId)
  if (!server || !['http', 'sse'].includes(server.transport)) {
    throw oauthError('Remote MCP server not found', 'MCP_OAUTH_SERVER_NOT_FOUND', 404)
  }
  const safeServerUrl = assertSafeOAuthUrl(server.url, 'MCP server')
  const safeRedirectUri = assertSafeOAuthUrl(redirectUri, 'OAuth callback')
  const current = getMcpOAuthCredential(userId, serverId)
  const protectedResource = await discoverProtectedResource(safeServerUrl, fetchImpl)
  const resourceMetadata = protectedResource.metadata || {}
  const issuer = resourceMetadata.authorization_servers?.[0] || resourceMetadata.issuer || ''
  const authorizationServer = issuer ? await discoverAuthorizationServer(issuer, fetchImpl) : {}
  const authorizationEndpoint = assertSafeOAuthUrl(
    config.authorizationEndpoint || authorizationServer.authorization_endpoint || resourceMetadata.authorization_endpoint,
    'Authorization',
  )
  const tokenEndpoint = assertSafeOAuthUrl(
    config.tokenEndpoint || authorizationServer.token_endpoint || resourceMetadata.token_endpoint,
    'Token',
  )
  const registrationEndpoint = config.registrationEndpoint
    || authorizationServer.registration_endpoint
    || resourceMetadata.registration_endpoint
    || ''
  const scopes = splitScopes(
    config.scopes?.length ? config.scopes : (resourceMetadata.scopes_supported || current?.metadata?.scopes || []),
  )
  let clientId = String(config.clientId || current?.metadata?.clientId || '').trim()
  let clientSecret = String(config.clientSecret || current?.credentials?.clientSecret || '').trim()
  let tokenAuthMethod = config.tokenAuthMethod
    || current?.metadata?.tokenAuthMethod
    || (clientSecret ? 'client_secret_basic' : 'none')
  if (!clientId) {
    if (!registrationEndpoint) {
      throw oauthError(
        'The authorization server does not support dynamic registration. Enter an OAuth Client ID.',
        'MCP_OAUTH_CLIENT_REQUIRED',
      )
    }
    const registered = await registerClient({ registrationEndpoint, redirectUri: safeRedirectUri, scopes, fetchImpl })
    clientId = registered.clientId
    clientSecret = registered.clientSecret
    tokenAuthMethod = registered.tokenAuthMethod
  }

  const state = crypto.randomBytes(32).toString('base64url')
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  const metadata = {
    issuer,
    resource: resourceMetadata.resource || safeServerUrl,
    resourceMetadataUrl: protectedResource.metadataUrl,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    clientId,
    scopes,
    tokenAuthMethod,
  }
  const credentials = {
    ...(current?.credentials || {}),
    clientSecret,
  }
  upsertMcpOAuthCredential({ userId, serverId, metadata, credentials, expiresAt: current?.expiresAt })
  const createdAt = Date.now()
  const expiresAt = createdAt + PENDING_TTL_MS
  saveMcpOAuthPendingAuthorization({
    state,
    userId,
    serverId,
    createdAt,
    expiresAt,
    pending: {
      redirectUri: safeRedirectUri,
      verifier,
      metadata,
      credentials,
      callbackOrigin: new URL(safeRedirectUri).origin,
    },
  })
  const authorizationUrl = new URL(authorizationEndpoint)
  authorizationUrl.searchParams.set('response_type', 'code')
  authorizationUrl.searchParams.set('client_id', clientId)
  authorizationUrl.searchParams.set('redirect_uri', safeRedirectUri)
  authorizationUrl.searchParams.set('state', state)
  authorizationUrl.searchParams.set('code_challenge', challenge)
  authorizationUrl.searchParams.set('code_challenge_method', 'S256')
  authorizationUrl.searchParams.set('resource', metadata.resource)
  if (scopes.length) authorizationUrl.searchParams.set('scope', scopes.join(' '))
  return { authorizationUrl: authorizationUrl.toString(), state, expiresAt }
}

export async function completeMcpOAuth({ state, code, error, errorDescription, fetchImpl = fetch }) {
  const pending = consumeMcpOAuthPendingAuthorization(String(state || ''))
  if (!pending) throw oauthError('OAuth state is invalid or expired', 'MCP_OAUTH_STATE_INVALID')
  if (error) throw oauthError(errorDescription || error, 'MCP_OAUTH_DENIED')
  if (!code) throw oauthError('Authorization code is missing', 'MCP_OAUTH_CODE_MISSING')
  const token = await requestToken({
    metadata: pending.metadata,
    credentials: pending.credentials,
    params: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      resource: pending.metadata.resource,
    },
    fetchImpl,
  })
  const expiresAt = tokenExpiry(token)
  const credentials = {
    ...pending.credentials,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || pending.credentials.refreshToken || '',
    tokenType: token.token_type || 'Bearer',
  }
  const metadata = {
    ...pending.metadata,
    scopes: splitScopes(token.scope || pending.metadata.scopes),
  }
  upsertMcpOAuthCredential({
    userId: pending.userId,
    serverId: pending.serverId,
    metadata,
    credentials,
    expiresAt,
  })
  return {
    userId: pending.userId,
    serverId: pending.serverId,
    callbackOrigin: pending.callbackOrigin,
  }
}

async function refreshAccessToken(userId, serverId, record, fetchImpl) {
  if (!record.credentials?.refreshToken) {
    throw oauthError('MCP OAuth session expired. Connect it again.', 'MCP_OAUTH_REAUTHORIZE', 401)
  }
  const token = await requestToken({
    metadata: record.metadata,
    credentials: record.credentials,
    params: {
      grant_type: 'refresh_token',
      refresh_token: record.credentials.refreshToken,
      resource: record.metadata.resource,
      ...(record.metadata.scopes?.length ? { scope: record.metadata.scopes.join(' ') } : {}),
    },
    fetchImpl,
  })
  const updated = upsertMcpOAuthCredential({
    userId,
    serverId,
    metadata: {
      ...record.metadata,
      scopes: splitScopes(token.scope || record.metadata.scopes),
    },
    credentials: {
      ...record.credentials,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || record.credentials.refreshToken,
      tokenType: token.token_type || record.credentials.tokenType || 'Bearer',
    },
    expiresAt: tokenExpiry(token),
  })
  return updated
}

export async function getMcpOAuthHeaders(userId, serverId, { fetchImpl = fetch } = {}) {
  let record = getMcpOAuthCredential(userId, serverId)
  if (!record) return {}
  const expired = record.expiresAt && record.expiresAt <= Date.now() + TOKEN_REFRESH_LEEWAY_MS
  if (!record.credentials?.accessToken || expired) {
    const key = `${userId}:${serverId}`
    if (!refreshPromises.has(key)) {
      refreshPromises.set(key, refreshAccessToken(userId, serverId, record, fetchImpl).finally(() => {
        refreshPromises.delete(key)
      }))
    }
    record = await refreshPromises.get(key)
  }
  return { Authorization: `${record.credentials.tokenType || 'Bearer'} ${record.credentials.accessToken}` }
}

export function disconnectMcpOAuth(userId, serverId) {
  return deleteMcpOAuthCredential(userId, serverId)
}

export { getMcpOAuthStatus }

export const _mcpOAuthInternals = {
  PENDING_TTL_MS,
  resourceMetadataFromChallenge,
  splitScopes,
  wellKnownUrl,
}
