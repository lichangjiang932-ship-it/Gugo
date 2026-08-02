import crypto from 'node:crypto'
import { getDb } from '../db.js'
import {
  getEnabledIntegrationCredentials,
  getIntegration,
  getIntegrationByProvider,
  testProviderCredentials,
  upsertIntegration,
} from './integrationsStore.js'
import { openCredentialObject, sealCredentialObject } from '../utils/credentialVault.js'

const SESSION_TTL_MS = 10 * 60 * 1000
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000
const OAUTH_CODE_VERIFIER_PURPOSE = 'integration-oauth-code-verifier'

const PROVIDERS = Object.freeze({
  github: Object.freeze({
    label: 'GitHub',
    clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GITHUB_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user'],
    scopesEnv: 'GITHUB_OAUTH_SCOPES',
    pkce: true,
  }),
  notion: Object.freeze({
    label: 'Notion',
    clientIdEnv: 'NOTION_OAUTH_CLIENT_ID',
    clientSecretEnv: 'NOTION_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    pkce: false,
  }),
  slack: Object.freeze({
    label: 'Slack',
    clientIdEnv: 'SLACK_OAUTH_CLIENT_ID',
    clientSecretEnv: 'SLACK_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'channels:history'],
    scopesEnv: 'SLACK_OAUTH_SCOPES',
    scopeSeparator: ',',
    pkce: false,
  }),
  google_drive: Object.freeze({
    label: 'Google Drive',
    clientIdEnv: 'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    scopesEnv: 'GOOGLE_DRIVE_OAUTH_SCOPES',
    scopeSeparator: ' ',
    pkce: true,
  }),
})

function oauthError(message, statusCode = 400, code = 'OAUTH_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding)
}

function writeCodeVerifier(value) {
  return sealCredentialObject({ codeVerifier: String(value || '') }, {
    purpose: OAUTH_CODE_VERIFIER_PURPOSE,
  })
}

function readCodeVerifier(row) {
  const decoded = openCredentialObject(row?.code_verifier, {
    purpose: OAUTH_CODE_VERIFIER_PURPOSE,
    legacyDecoder: (raw) => ({ codeVerifier: String(raw || '') }),
  })
  const codeVerifier = String(decoded.value.codeVerifier || '')
  if (decoded.legacy && row?.id && codeVerifier) {
    getDb().prepare('UPDATE integration_oauth_sessions SET code_verifier = ? WHERE id = ?')
      .run(writeCodeVerifier(codeVerifier), row.id)
  }
  return codeVerifier
}

function providerSettings(provider, env = process.env) {
  const metadata = PROVIDERS[provider]
  if (!metadata) throw oauthError(`OAuth is not supported for provider: ${provider}`, 400, 'OAUTH_PROVIDER_UNSUPPORTED')
  const clientId = String(env?.[metadata.clientIdEnv] || '').trim()
  const clientSecret = String(env?.[metadata.clientSecretEnv] || '').trim()
  const configuredScopes = metadata.scopesEnv
    ? String(env?.[metadata.scopesEnv] || '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
    : []
  const scopes = configuredScopes.length ? [...new Set(configuredScopes)] : [...metadata.scopes]
  return { ...metadata, scopes, clientId, clientSecret, configured: !!clientId && !!clientSecret }
}

function publicBaseUrl({ env = process.env, origin }) {
  const raw = String(env?.APP_PUBLIC_URL || origin || '').trim()
  if (!raw) throw oauthError('APP_PUBLIC_URL is required for OAuth', 503, 'OAUTH_PUBLIC_URL_REQUIRED')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw oauthError('APP_PUBLIC_URL must be a valid http(s) URL', 503, 'OAUTH_PUBLIC_URL_INVALID')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw oauthError('APP_PUBLIC_URL must be a valid http(s) origin', 503, 'OAUTH_PUBLIC_URL_INVALID')
  }
  return url.origin
}

function cleanupSessions(now) {
  const db = getDb()
  db.prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'expired', error = 'OAuth session expired', code_verifier = '', updated_at = ?
    WHERE status IN ('pending','exchanging') AND expires_at <= ?
  `).run(now, now)
  db.prepare(`
    DELETE FROM integration_oauth_sessions
    WHERE status IN ('completed','failed','expired') AND updated_at < ?
  `).run(now - TERMINAL_RETENTION_MS)
}

function sessionView(row, integration = null) {
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    integrationId: row.integration_id || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at || null,
    integration,
  }
}

export function listOAuthProviders({ env = process.env } = {}) {
  return Object.keys(PROVIDERS).map((provider) => {
    const settings = providerSettings(provider, env)
    return {
      provider,
      label: settings.label,
      configured: settings.configured,
      pkce: settings.pkce,
      scopes: [...settings.scopes],
    }
  })
}

export function startOAuthConnection({
  userId,
  provider,
  integrationId = null,
  origin,
  env = process.env,
  now = Date.now(),
} = {}) {
  if (!userId) throw oauthError('userId required', 401, 'OAUTH_UNAUTHORIZED')
  const settings = providerSettings(provider, env)
  if (!settings.configured) {
    throw oauthError(`${settings.label} OAuth is not configured on this server`, 503, 'OAUTH_NOT_CONFIGURED')
  }
  const existing = integrationId ? getIntegration({ userId, id: integrationId }) : null
  if (integrationId && (!existing || existing.provider !== provider)) {
    throw oauthError('integration not found for provider', 404, 'OAUTH_INTEGRATION_NOT_FOUND')
  }

  const baseUrl = publicBaseUrl({ env, origin })
  const redirectUri = `${baseUrl}/api/integrations/oauth/callback/${encodeURIComponent(provider)}`
  const id = `oauth_${randomToken(18)}`
  const state = randomToken(32)
  const codeVerifier = settings.pkce ? randomToken(48) : ''
  const db = getDb()
  cleanupSessions(now)
  db.prepare(`
    INSERT INTO integration_oauth_sessions
      (id, state_hash, user_id, provider, integration_id, status, code_verifier,
       redirect_uri, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    id,
    sha256(state),
    userId,
    provider,
    existing?.id || null,
    writeCodeVerifier(codeVerifier),
    redirectUri,
    now,
    now,
    now + SESSION_TTL_MS,
  )

  const authorization = new URL(settings.authorizationUrl)
  authorization.searchParams.set('client_id', settings.clientId)
  authorization.searchParams.set('redirect_uri', redirectUri)
  authorization.searchParams.set('state', state)
  authorization.searchParams.set('response_type', 'code')
  if (settings.scopes.length) {
    authorization.searchParams.set('scope', settings.scopes.join(settings.scopeSeparator || ' '))
  }
  if (settings.pkce) {
    authorization.searchParams.set('code_challenge', sha256(codeVerifier, 'base64url'))
    authorization.searchParams.set('code_challenge_method', 'S256')
  }
  if (provider === 'notion') {
    authorization.searchParams.set('owner', 'user')
  }
  if (provider === 'google_drive') {
    authorization.searchParams.set('access_type', 'offline')
    authorization.searchParams.set('prompt', 'consent')
    authorization.searchParams.set('include_granted_scopes', 'true')
  }

  return {
    session: getOAuthConnectionStatus({ userId, id, now }),
    authorizationUrl: authorization.toString(),
  }
}

export function getOAuthConnectionStatus({ userId, id, now = Date.now() } = {}) {
  if (!userId || !id) return null
  cleanupSessions(now)
  const row = getDb().prepare(
    'SELECT * FROM integration_oauth_sessions WHERE id = ? AND user_id = ?',
  ).get(id, userId)
  if (!row) return null
  const integration = row.integration_id
    ? getIntegration({ userId, id: row.integration_id })
    : null
  return sessionView(row, integration)
}

async function fetchJson(fetchImpl, url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = {}
    }
    if (!response.ok) {
      throw oauthError(
        data?.error_description || data?.error || `OAuth token exchange failed (${response.status})`,
        502,
        'OAUTH_TOKEN_EXCHANGE_FAILED',
      )
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function exchangeCode({ provider, code, row, settings, fetchImpl }) {
  if (provider === 'notion') {
    const authorization = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')
    return fetchJson(fetchImpl, settings.tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: row.redirect_uri,
      }),
    })
  }

  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    code,
    redirect_uri: row.redirect_uri,
    grant_type: 'authorization_code',
  })
  if (settings.pkce) body.set('code_verifier', readCodeVerifier(row))
  return fetchJson(fetchImpl, settings.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
}

function connectorCredentials({ provider, tokenData, existing, now = Date.now() }) {
  const accessToken = String(tokenData?.access_token || '').trim()
  if (!accessToken) {
    throw oauthError(
      tokenData?.error_description || tokenData?.error || 'OAuth response did not include an access token',
      502,
      'OAUTH_TOKEN_MISSING',
    )
  }
  const config = { ...(existing?.config || {}), authSource: 'oauth' }
  if (provider === 'github') {
    config.oauthScopes = String(tokenData.scope || '')
  } else if (provider === 'notion') {
    if (tokenData.workspace_id) config.workspaceId = String(tokenData.workspace_id)
    if (tokenData.workspace_name) config.workspace = String(tokenData.workspace_name)
    if (tokenData.bot_id) config.botId = String(tokenData.bot_id)
  } else if (provider === 'slack') {
    if (tokenData.team?.id) config.teamId = String(tokenData.team.id)
    if (tokenData.team?.name) config.workspace = String(tokenData.team.name)
    if (tokenData.bot_user_id) config.botUserId = String(tokenData.bot_user_id)
    config.oauthScopes = String(tokenData.scope || '')
  } else if (provider === 'google_drive') {
    config.oauthScopes = String(tokenData.scope || '')
  }
  const secret = provider === 'slack' ? { botToken: accessToken } : { token: accessToken }
  if (tokenData.refresh_token) secret.refreshToken = String(tokenData.refresh_token)
  if (tokenData.token_type) secret.tokenType = String(tokenData.token_type)
  if (Number(tokenData.expires_in) > 0) {
    secret.expiresAt = String(now + (Number(tokenData.expires_in) * 1000))
  }
  return { config, secret }
}

export async function getOAuthAccessToken({
  userId,
  provider,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const credentials = getEnabledIntegrationCredentials({ userId, provider })
  if (!credentials) throw oauthError(`${provider} is not connected or is disabled`, 409, 'OAUTH_NOT_CONNECTED')
  const token = String(credentials.secret?.token || '').trim()
  const expiresAt = Number(credentials.secret?.expiresAt || 0)
  if (token && (!expiresAt || expiresAt > now + 60_000)) return token

  const refreshToken = String(credentials.secret?.refreshToken || '').trim()
  if (!refreshToken) throw oauthError(`${provider} OAuth token expired; reconnect it`, 401, 'OAUTH_REFRESH_REQUIRED')
  const settings = providerSettings(provider, env)
  if (!settings.configured) {
    throw oauthError(`${settings.label} OAuth is not configured on this server`, 503, 'OAUTH_NOT_CONFIGURED')
  }
  const body = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const tokenData = await fetchJson(fetchImpl, settings.tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const refreshed = String(tokenData?.access_token || '').trim()
  if (!refreshed) throw oauthError('OAuth refresh response did not include an access token', 502, 'OAUTH_TOKEN_MISSING')
  const secret = { token: refreshed }
  if (tokenData.refresh_token) secret.refreshToken = String(tokenData.refresh_token)
  if (Number(tokenData.expires_in) > 0) {
    secret.expiresAt = String(now + (Number(tokenData.expires_in) * 1000))
  }
  if (tokenData.token_type) secret.tokenType = String(tokenData.token_type)
  upsertIntegration({ userId, provider, secret })
  return refreshed
}

function failSession(id, error, now) {
  getDb().prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'failed', error = ?, code_verifier = '', updated_at = ?, completed_at = ?
    WHERE id = ?
  `).run(String(error?.message || error || 'OAuth failed').slice(0, 500), now, now, id)
}

export async function completeOAuthConnection({
  provider,
  state,
  code,
  providerError = '',
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const settings = providerSettings(provider, env)
  if (!state) throw oauthError('OAuth state is missing', 400, 'OAUTH_STATE_MISSING')
  const db = getDb()
  cleanupSessions(now)
  const row = db.prepare(
    'SELECT * FROM integration_oauth_sessions WHERE state_hash = ? AND provider = ?',
  ).get(sha256(String(state)), provider)
  if (!row) throw oauthError('OAuth state is invalid or expired', 400, 'OAUTH_STATE_INVALID')
  if (row.expires_at <= now || row.status === 'expired') {
    throw oauthError('OAuth session expired', 410, 'OAUTH_SESSION_EXPIRED')
  }
  if (row.status !== 'pending') {
    throw oauthError('OAuth state has already been used', 409, 'OAUTH_STATE_USED')
  }
  if (providerError || !code) {
    failSession(row.id, providerError || 'Authorization code is missing', now)
    return getOAuthConnectionStatus({ userId: row.user_id, id: row.id, now })
  }

  const claimed = db.prepare(`
    UPDATE integration_oauth_sessions
    SET status = 'exchanging', updated_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, row.id)
  if (claimed.changes !== 1) {
    throw oauthError('OAuth state has already been used', 409, 'OAUTH_STATE_USED')
  }

  try {
    const tokenData = await exchangeCode({ provider, code: String(code), row, settings, fetchImpl })
    const existing = row.integration_id
      ? getIntegration({ userId: row.user_id, id: row.integration_id })
      : getIntegrationByProvider({ userId: row.user_id, provider })
    const credentials = connectorCredentials({ provider, tokenData, existing })
    const validation = await testProviderCredentials({
      provider,
      config: credentials.config,
      secret: credentials.secret,
      fetchImpl,
    })
    if (validation?.ok !== true) {
      throw oauthError(
        validation?.message || 'OAuth credential validation failed',
        502,
        'OAUTH_CREDENTIAL_INVALID',
      )
    }
    const integration = upsertIntegration({
      userId: row.user_id,
      id: existing?.id,
      provider,
      name: existing?.name || settings.label,
      enabled: true,
      config: credentials.config,
      secret: credentials.secret,
    })
    const completedAt = Date.now()
    db.prepare(`
      UPDATE integration_oauth_sessions
      SET status = 'completed', integration_id = ?, error = NULL,
          code_verifier = '', updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(integration.id, completedAt, completedAt, row.id)
    return getOAuthConnectionStatus({ userId: row.user_id, id: row.id, now: completedAt })
  } catch (error) {
    const failedAt = Date.now()
    failSession(row.id, error, failedAt)
    return getOAuthConnectionStatus({ userId: row.user_id, id: row.id, now: failedAt })
  }
}

export function oauthCompletionRedirect(session) {
  const row = getDb().prepare(
    'SELECT redirect_uri FROM integration_oauth_sessions WHERE id = ?',
  ).get(session?.id)
  if (!row?.redirect_uri) return '/#/access?oauth=failed'
  const origin = new URL(row.redirect_uri).origin
  const params = new URLSearchParams({
    oauth: session.status === 'completed' ? 'success' : 'failed',
    provider: session.provider || '',
    session: session.id || '',
  })
  return `${origin}/#/access?${params.toString()}`
}
