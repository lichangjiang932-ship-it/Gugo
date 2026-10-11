import { getDb } from '../db.js'
import {
  getEnabledIntegrationCredentials,
  getIntegration,
  getIntegrationByProvider,
  testProviderCredentials,
  upsertIntegration,
} from './integrationsStore.js'
import {
  PROVIDERS,
  SESSION_TTL_MS,
  cleanupSessions,
  connectorCredentials,
  failSession,
  fetchJson,
  getOAuthConnectionStatus,
  oauthError,
  providerSettings,
  publicBaseUrl,
  randomToken,
  readCodeVerifier,
  sha256,
  writeCodeVerifier,
} from './integrationOAuthShared.js'
import { pollDeviceFlowConnection, startDeviceFlowConnection } from './integrationOAuthDeviceFlow.js'
import { pollQrRegistration } from './integrationQrRegistration.js'

// Both live with the pieces they share, but callers have always reached for them
// here, and the route and the tests still do.
export { getOAuthConnectionStatus, pollDeviceFlowConnection }

/**
 * One poll endpoint for every flow that advances by polling.
 *
 * Which flow a session belongs to is a property of the session, not of the
 * request — the client has one timer and should not have to know whether the
 * thing it is waiting on is a device code, a QR registration, or neither. Each
 * poller answers null for a session that is not its own.
 */
export async function advanceOAuthSession({
  userId,
  id,
  env = process.env,
  fetchImpl = fetch,
  lookup,
  now = Date.now(),
} = {}) {
  const viaQr = await pollQrRegistration({ userId, id, env, fetchImpl, lookup, now })
  if (viaQr) return viaQr
  return pollDeviceFlowConnection({ userId, id, env, fetchImpl, lookup, now })
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

export async function startOAuthConnection({
  userId,
  provider,
  integrationId = null,
  origin,
  env = process.env,
  fetchImpl = fetch,
  lookup,
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
  if (settings.deviceFlow === true && !settings.clientSecret) {
    return startDeviceFlowConnection({ userId, provider, settings, existing, fetchImpl, lookup, now })
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

async function exchangeCode({ provider, code, row, settings, fetchImpl, lookup }) {
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
    }, { lookup })
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
  }, { lookup })
}

export async function getOAuthAccessToken({
  userId,
  provider,
  env = process.env,
  fetchImpl = fetch,
  lookup,
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
  }, { lookup })
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

export async function completeOAuthConnection({
  provider,
  state,
  code,
  providerError = '',
  env = process.env,
  fetchImpl = fetch,
  lookup,
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
    const tokenData = await exchangeCode({
      provider,
      code: String(code),
      row,
      settings,
      fetchImpl,
      lookup,
    })
    const existing = row.integration_id
      ? getIntegration({ userId: row.user_id, id: row.integration_id })
      : getIntegrationByProvider({ userId: row.user_id, provider })
    const credentials = connectorCredentials({ provider, tokenData, existing })
    const validation = await testProviderCredentials({
      provider,
      config: credentials.config,
      secret: credentials.secret,
      fetchImpl,
      lookup,
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
